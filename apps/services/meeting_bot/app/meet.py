"""Google Meet join + audio capture via Playwright (headless Chrome).

The bot opens the meeting URL as a guest, turns its own mic/cam OFF, asks to
join, waits to be admitted, then records the call's audio by capturing the
container's PulseAudio null-sink monitor with ffmpeg. On leave / call-end it
finalises the file.

Reality check: Google Meet's DOM is not a public API — the selectors below are
best-effort and WILL need occasional tuning as Meet's UI changes (this is the
inherent maintenance cost of any browser-automation meeting bot, self-hosted or
not). Everything is defensive: a missing selector degrades to a clear status
rather than a crash. Verify against a real meeting on the deployment box.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import signal
import subprocess
from collections.abc import Callable
from urllib.parse import urlsplit

_log = logging.getLogger("meeting_bot.meet")

PULSE_MONITOR = os.environ.get("PULSE_MONITOR", "meet.monitor")
DIAG_DIR = os.environ.get("MEETING_BOT_DATA", "/data")
JOIN_TIMEOUT_S = int(os.environ.get("MEET_JOIN_TIMEOUT", "150"))
MAX_DURATION_S = int(os.environ.get("MEET_MAX_DURATION", str(4 * 3600)))
# End the call if the bot has been the only participant for this long (everyone
# else left) — avoids a bot recording an empty room until the max-duration cap.
ALONE_TIMEOUT_S = int(os.environ.get("MEET_ALONE_TIMEOUT", "120"))


class MeetingBotError(Exception):
    def __init__(
        self, message: str, status: str = "failed", diagnostics: dict | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        #: What the page actually looked like when this failed — see `_snapshot`.
        self.diagnostics = diagnostics or {}


# ── Diagnostics ──────────────────────────────────────────────────────────────
# Meet's DOM is not a public API, so a selector WILL eventually miss. When that
# happens the useful question is "what did the page actually show?" — answering
# it from a log line beats guessing at selectors. Every failure path captures a
# snapshot; the enumerated control labels are the part that tells you which
# selector to write next.

async def _visible_controls(page, limit: int = 40) -> list[str]:
    """Labels of every button Meet actually rendered, in DOM order."""
    script = """(limit) => {
      const out = [];
      for (const el of document.querySelectorAll('button,[role="button"]')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const label = (el.getAttribute('aria-label') || el.innerText || '').trim();
        if (label) out.push(label.slice(0, 80));
        if (out.length >= limit) break;
      }
      return out;
    }"""
    try:
        return await page.evaluate(script, limit)
    except Exception:
        return []


async def _snapshot(page, job_id: str, tag: str) -> dict:
    """Capture what the page looks like right now (never raises)."""
    diag: dict = {"tag": tag, "url": None, "title": None, "controls": [], "body": ""}
    with contextlib.suppress(Exception):
        diag["url"] = page.url
    with contextlib.suppress(Exception):
        diag["title"] = await page.title()
    diag["controls"] = await _visible_controls(page)
    with contextlib.suppress(Exception):
        diag["body"] = " ".join((await page.inner_text("body")).split())[:1500]
    shot = os.path.join(DIAG_DIR, f"{job_id}-{tag}.png")
    try:
        os.makedirs(DIAG_DIR, exist_ok=True)
        await page.screenshot(path=shot)
        diag["screenshot"] = shot
    except Exception:
        diag["screenshot"] = None
    _log.warning(
        "meet.snapshot tag=%s url=%s title=%r controls=%s body=%r",
        tag, diag["url"], diag["title"], diag["controls"][:14], diag["body"][:300],
    )
    return diag


async def _click_first(page, selectors: list[str], timeout: float = 4000) -> str | None:
    """Click the first selector that resolves; return the one that worked.

    The timeout is applied to the *click* as well as the visibility wait. Without
    that, a button that is visible but disabled (Meet disables "Ask to join"
    until a guest has typed a name) burns Playwright's 30 s default per selector
    instead of the caller's budget, and the join silently exceeds its own
    deadline before ever reaching the later selectors.
    """
    for sel in selectors:
        try:
            el = page.locator(sel).first
            await el.wait_for(state="visible", timeout=timeout)
            await el.click(timeout=timeout)
            _log.info("meet.clicked selector=%s", sel)
            return sel
        except Exception:
            continue
    return None


async def _maybe_fill_name(page, bot_name: str) -> bool:
    """Type the bot's name into the guest name box. Returns whether it was found.

    Signed-out guests MUST supply a name — Meet keeps "Ask to join" disabled
    until one is typed — so a miss here presents downstream as an unclickable
    join button rather than as anything about names.
    """
    for sel in (
        'input[aria-label="Your name"]',
        'input[placeholder="Your name"]',
        'input[aria-label*="name" i]',
        'input[type="text"]',
    ):
        try:
            box = page.locator(sel).first
            await box.wait_for(state="visible", timeout=3000)
            await box.fill(bot_name)
            _log.info("meet.name_filled selector=%s", sel)
            return True
        except Exception:
            continue
    _log.info("meet.name_box_absent (already signed in, or the layout changed)")
    return False


async def _dismiss_blocking_dialogs(page) -> None:
    """Clear the interstitials Meet shows a browser with no real camera.

    The container has a virtual microphone but no webcam, so Meet frequently
    puts up a device warning over the green room. It is modal: the join button
    sits behind it, so failing to dismiss it looks exactly like a missing join
    button.
    """
    for _ in range(3):
        hit = await _click_first(
            page,
            [
                'button:has-text("Continue without microphone and camera")',
                'button:has-text("Continue without camera and microphone")',
                'button:has-text("Use without camera and microphone")',
                'button:has-text("Continue without camera")',
                'button:has-text("Continue without microphone")',
                'button:has-text("Dismiss")',
                'button:has-text("Got it")',
                '[role="button"]:has-text("Continue without")',
            ],
            timeout=1500,
        )
        if hit is None:
            return
        await asyncio.sleep(0.5)


async def _mute_self(page) -> None:
    """Turn the bot's own mic + camera off on the green-room screen (best-effort).
    We join silent and invisible — the bot only listens."""
    await _click_first(
        page,
        [
            'button[aria-label*="Turn off microphone" i]',
            'div[aria-label*="Turn off microphone" i]',
            '[data-is-muted="false"][aria-label*="microphone" i]',
        ],
        timeout=2500,
    )
    await _click_first(
        page,
        [
            'button[aria-label*="Turn off camera" i]',
            'div[aria-label*="Turn off camera" i]',
            '[data-is-muted="false"][aria-label*="camera" i]',
        ],
        timeout=2500,
    )


async def _click_join(page) -> str | None:
    return await _click_first(
        page,
        [
            'button:has-text("Ask to join")',
            'button:has-text("Join now")',
            '[role="button"]:has-text("Ask to join")',
            '[role="button"]:has-text("Join now")',
            'button:has-text("Join")',
        ],
        timeout=8000,
    )


# Phrases that mean the bot will never get in, however long it waits.
_REFUSED = (
    "you can't join this",
    "you cannot join this",
    "denied",
    "no one responded",
    "removed from the meeting",
    "meeting hasn't started",
    "check your meeting code",
    "not allowed to join",
)
# Phrases that mean it IS knocking and someone still has to answer.
_WAITING = ("asking to be let in", "waiting for the host", "waiting to be let in")


def classify_body(body: str) -> str | None:
    """Read the green room's own words: ``refused`` / ``waiting`` / None.

    Pure so the phrase list can be tested directly — the distinction matters
    because "asking to be let in" and "you can't join this call" are one polling
    tick apart in the DOM but mean opposite things to whoever is waiting.
    """
    low = (body or "").lower()
    if any(s in low for s in _REFUSED):
        return "refused"
    if any(s in low for s in _WAITING):
        return "waiting"
    return None


_MEET_CODE = re.compile(r"^/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)", re.I)


def canonical_meet_url(url: str) -> str:
    """Reduce a meet.google.com link to its canonical bare form, in English.

    Invite links arrive dressed up — ``?authuser=0&hs=122``, calendar tracking
    params — and some of those decorations make Meet route a signed-out browser
    to its marketing page instead of the green room. The bare
    ``https://meet.google.com/xxx-yyyy-zzz`` form is the one guests handle most
    reliably; ``hl=en`` pins the UI language so the phrase lists above match on
    any box. Non-Meet URLs and unusual shapes (``/lookup/…``) pass through
    untouched.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if (parts.hostname or "").lower() != "meet.google.com":
        return url
    m = _MEET_CODE.match(parts.path or "")
    if not m:
        return url
    return f"https://meet.google.com/{m.group(1).lower()}?hl=en"


def looks_like_landing(url: str, body: str) -> bool:
    """Whether the page is Meet's *marketing* page rather than a green room.

    Meet renders this client-side (the URL often doesn't change) when it
    decides the visitor isn't a real participant — the signature of a
    signed-out browser that leaked ``navigator.webdriver`` or hit a decorated
    invite link. It has no join button at all, so without this check it
    surfaces as the misleading "No join button on the meeting page".
    """
    low_url = (url or "").lower()
    if "workspace.google.com" in low_url or "meet.google.com/landing" in low_url:
        return True
    low = (body or "").lower()
    if "try meet for work" in low or "video calls, enhanced with ai" in low:
        return True
    return "join a meeting now" in low and "enter code" in low


async def _in_call(page) -> bool:
    """Whether we are actually inside the call (the leave control exists)."""
    for sel in (
        'button[aria-label*="Leave call" i]',
        '[aria-label*="Leave call" i]',
        'button[aria-label*="End call" i]',
        '[data-tooltip-id*="leave" i]',
    ):
        try:
            if await page.locator(sel).first.is_visible():
                return True
        except Exception:
            continue
    return False


async def _await_admission(page, on_status: Callable[[str], None]) -> str:
    """Wait for admission. Returns ``in_call`` / ``refused`` / ``timeout``.

    Timeout and refusal are reported separately because they need opposite
    responses from a human: refusal means the bot will never get in on this
    link, while a timeout usually just means nobody clicked Admit. Collapsing
    both into "not admitted" (as this did originally) hides which one happened.
    """
    waited = 0.0
    announced_waiting = False
    while waited < JOIN_TIMEOUT_S:
        if await _in_call(page):
            return "in_call"
        try:
            body = await page.inner_text("body")
        except Exception:
            body = ""
        verdict = classify_body(body)
        if verdict == "refused":
            _log.warning("meet.refused body=%r", " ".join(body.split())[:300])
            return "refused"
        if verdict == "waiting" and not announced_waiting:
            on_status("waiting_room")
            announced_waiting = True
            _log.info("meet.waiting_room")
        await asyncio.sleep(3)
        waited += 3
    return "timeout"


def _participant_count(page) -> int:
    """Best-effort current participant count (Meet shows it on a people pill).
    Returns -1 when it can't be read (treated as 'not alone')."""
    # Not reliably available headless; kept simple and optional.
    return -1


def _start_ffmpeg(out_path: str) -> subprocess.Popen:
    """Record the PulseAudio monitor → 16 kHz mono Opus/OGG (small, ASR-ready)."""
    return subprocess.Popen(
        [
            "ffmpeg", "-nostdin", "-loglevel", "error",
            "-f", "pulse", "-i", PULSE_MONITOR,
            "-ac", "1", "-ar", "16000", "-c:a", "libopus",
            "-y", out_path,
        ],
        stdin=subprocess.DEVNULL,
    )


def _stop_ffmpeg(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        proc.send_signal(signal.SIGINT)  # lets ffmpeg finalise the container
        proc.wait(timeout=15)
    except Exception:
        with contextlib.suppress(Exception):
            proc.kill()


async def _wait_until_end(page, leave_event: asyncio.Event) -> None:
    """Stay in the call until asked to leave, the call ends, or the cap is hit."""
    waited = 0
    alone_for = 0
    while waited < MAX_DURATION_S:
        if leave_event.is_set():
            return
        try:
            body = (await page.inner_text("body")).lower()
        except Exception:
            body = ""
        if any(s in body for s in ("you've left the meeting", "you left the meeting",
                                   "return to home screen", "call ended",
                                   "removed from the meeting")):
            return
        n = _participant_count(page)
        if n == 1:
            alone_for += 5
            if alone_for >= ALONE_TIMEOUT_S:
                return
        else:
            alone_for = 0
        await asyncio.sleep(5)
        waited += 5


async def _leave(page) -> None:
    await _click_first(
        page,
        ['button[aria-label*="Leave call" i]', '[aria-label*="Leave call" i]'],
        timeout=3000,
    )


async def _say_consumer(say_queue, stop: asyncio.Event) -> None:
    """Drain queued interjections and speak them into the call while in-call."""
    from . import live as livemod

    while not stop.is_set():
        try:
            text = await asyncio.wait_for(say_queue.get(), timeout=1.0)
        except TimeoutError:
            continue
        except Exception:
            return
        await livemod.speak(text)


def _start_live_tasks(live_callback, say_queue, stop: asyncio.Event) -> list:
    """Start the (optional) live-transcription stream + say consumer for the call.
    Both are additive and gated — absent config just means no live feed / no
    speaking, and the archival recording is unaffected."""
    from . import live as livemod

    tasks = []
    if live_callback and livemod.live_enabled():
        tasks.append(asyncio.create_task(
            livemod.stream_transcription(live_callback, stop)
        ))
    if say_queue is not None:
        tasks.append(asyncio.create_task(_say_consumer(say_queue, stop)))
    return tasks


async def _green_room(page, job_id: str, bot_name: str) -> None:
    """Fill in the name, clear device dialogs, mute, and ask to join.

    Ordered deliberately: dialogs first (they cover everything), then the name
    (which is what enables the join button for a guest), then muting, then join.
    """
    await _dismiss_blocking_dialogs(page)
    await _maybe_fill_name(page, bot_name)
    await _dismiss_blocking_dialogs(page)  # filling a field can raise a new one
    await _mute_self(page)
    if await _click_join(page) is not None:
        return
    # Meet re-renders the green room slowly on a small box; one retry after a
    # settle costs 4 s and covers the common "not hydrated yet" case.
    await asyncio.sleep(4)
    await _dismiss_blocking_dialogs(page)
    if await _click_join(page) is not None:
        return
    diag = await _snapshot(page, job_id, "no-join-button")
    if looks_like_landing(diag.get("url") or "", diag.get("body") or ""):
        raise MeetingBotError(
            "Google Meet showed its landing page instead of the meeting — it "
            "treated the notetaker as a bot or the link as invalid. Use a "
            "direct https://meet.google.com/xxx-yyyy-zzz link and check the "
            "meeting allows guests to knock.",
            diagnostics=diag,
        )
    controls = ", ".join(diag.get("controls", [])[:10]) or "none visible"
    raise MeetingBotError(
        f"No join button on the meeting page. Buttons Meet actually showed: "
        f"[{controls}]. Page title: {diag.get('title')!r}.",
        diagnostics=diag,
    )


async def join_and_record(
    meeting_url: str,
    bot_name: str,
    out_path: str,
    leave_event: asyncio.Event,
    on_status: Callable[[str], None],
    live_callback: str | None = None,
    say_queue=None,
    job_id: str = "bot",
) -> None:
    from playwright.async_api import async_playwright

    on_status("joining")
    async with async_playwright() as p:
        # Normally Playwright's own pinned build is used. CHROME_EXECUTABLE lets a
        # host point at a different Chrome/Chromium — needed whenever the browser
        # on the box wasn't installed by THIS playwright version (otherwise the
        # launch dies with "Executable doesn't exist at .../chromium-<rev>").
        chrome_path = os.environ.get("CHROME_EXECUTABLE", "").strip() or None
        browser = await p.chromium.launch(
            headless=False,  # headful under Xvfb so the audio pipeline works
            executable_path=chrome_path,
            # Meet sniffs for automation. Playwright's default launch both adds
            # --enable-automation (the "controlled by automated software" mode)
            # and leaves navigator.webdriver=true — either is enough for Meet
            # to route a signed-out visitor to its MARKETING page, which has no
            # join button at all (seen in production, screenshot-proven).
            ignore_default_args=["--enable-automation"],
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
                "--use-fake-ui-for-media-stream",  # auto-accept the mic/cam prompt
                "--autoplay-policy=no-user-gesture-required",
                "--disable-notifications",
                "--window-size=1280,720",
                "--lang=en-US",
            ],
        )
        context = await browser.new_context(
            permissions=["microphone", "camera"],
            viewport={"width": 1280, "height": 720},
            # English pinned so classify_body/looks_like_landing phrase match
            # regardless of the host's geo-derived language.
            locale="en-US",
        )
        page = await context.new_page()
        rec: subprocess.Popen | None = None
        try:
            url = canonical_meet_url(meeting_url)
            if url != meeting_url:
                _log.info("meet.url_canonicalised %s -> %s", meeting_url, url)
            _log.info("meet.goto url=%s name=%r", url, bot_name)
            await page.goto(url, wait_until="load", timeout=60000)
            # Meet hydrates its green room well after `load` fires, and slower
            # still on a 2-vCPU box. Wait for a real control rather than a fixed
            # sleep, falling through after 20 s so the snapshot shows the page.
            with contextlib.suppress(Exception):
                await page.wait_for_selector(
                    'button, [role="button"], input', timeout=20000
                )
            await asyncio.sleep(2)

            # Marketing page instead of a green room → Meet bounced us. Reload
            # once (the first navigation sometimes races Meet's own routing);
            # if it still refuses, fail with the real story, not "no button".
            body = ""
            with contextlib.suppress(Exception):
                body = await page.inner_text("body")
            if looks_like_landing(page.url, body):
                _log.warning("meet.landing_page_detected — retrying once")
                await page.goto(url, wait_until="load", timeout=60000)
                with contextlib.suppress(Exception):
                    await page.wait_for_selector(
                        'button, [role="button"], input', timeout=20000
                    )
                await asyncio.sleep(2)
                body = ""
                with contextlib.suppress(Exception):
                    body = await page.inner_text("body")
                if looks_like_landing(page.url, body):
                    diag = await _snapshot(page, job_id, "landing-page")
                    raise MeetingBotError(
                        "Google Meet showed its landing page instead of the "
                        "meeting — it treated the notetaker as a bot or the "
                        "link as invalid. Double-check the meeting link is a "
                        "direct https://meet.google.com/xxx-yyyy-zzz code and "
                        "that the meeting allows guests to knock; if this "
                        "keeps happening Meet has likely tightened its "
                        "automated-browser detection.",
                        diagnostics=diag,
                    )

            await _green_room(page, job_id, bot_name)

            admission = await _await_admission(page, on_status)
            if admission == "refused":
                diag = await _snapshot(page, job_id, "refused")
                raise MeetingBotError(
                    "Google Meet refused the join. This link needs a signed-in "
                    "Google account, or the host has locked the call to invited "
                    "people. Detail: " + (diag.get("body") or "")[:300],
                    status="not_admitted",
                    diagnostics=diag,
                )
            if admission == "timeout":
                diag = await _snapshot(page, job_id, "not-admitted")
                raise MeetingBotError(
                    f"Nobody admitted the notetaker within {JOIN_TIMEOUT_S}s. "
                    "Someone already in the call has to click Admit when it "
                    "knocks (raise MEET_JOIN_TIMEOUT if you need longer).",
                    status="not_admitted",
                    diagnostics=diag,
                )
            on_status("in_call")
            _log.info("meet.in_call recording to %s", out_path)

            rec = _start_ffmpeg(out_path)
            # Live transcription stream + interjection consumer run alongside the
            # archival recording (both optional/gated).
            live_stop = asyncio.Event()
            aux = _start_live_tasks(live_callback, say_queue, live_stop)
            try:
                await _wait_until_end(page, leave_event)
            finally:
                live_stop.set()
                for t in aux:
                    t.cancel()
        finally:
            on_status("processing")
            if rec is not None:
                _stop_ffmpeg(rec)
            with contextlib.suppress(Exception):
                await _leave(page)
            await context.close()
            await browser.close()
