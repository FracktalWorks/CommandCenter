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
import os
import signal
import subprocess
from collections.abc import Callable

PULSE_MONITOR = os.environ.get("PULSE_MONITOR", "meet.monitor")
JOIN_TIMEOUT_S = int(os.environ.get("MEET_JOIN_TIMEOUT", "150"))
MAX_DURATION_S = int(os.environ.get("MEET_MAX_DURATION", str(4 * 3600)))
# End the call if the bot has been the only participant for this long (everyone
# else left) — avoids a bot recording an empty room until the max-duration cap.
ALONE_TIMEOUT_S = int(os.environ.get("MEET_ALONE_TIMEOUT", "120"))


class MeetingBotError(Exception):
    def __init__(self, message: str, status: str = "failed") -> None:
        super().__init__(message)
        self.status = status


async def _click_first(page, selectors: list[str], timeout: float = 4000) -> bool:
    """Click the first selector that resolves; return whether one did."""
    for sel in selectors:
        try:
            el = page.locator(sel).first
            await el.wait_for(state="visible", timeout=timeout)
            await el.click()
            return True
        except Exception:
            continue
    return False


async def _maybe_fill_name(page, bot_name: str) -> None:
    for sel in (
        'input[aria-label="Your name"]',
        'input[placeholder="Your name"]',
        'input[aria-label*="name" i]',
    ):
        try:
            box = page.locator(sel).first
            await box.wait_for(state="visible", timeout=3000)
            await box.fill(bot_name)
            return
        except Exception:
            continue


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


async def _click_join(page) -> bool:
    return await _click_first(
        page,
        [
            'button:has-text("Ask to join")',
            'button:has-text("Join now")',
            'button:has-text("Join")',
            '[role="button"]:has-text("Ask to join")',
            '[role="button"]:has-text("Join now")',
        ],
        timeout=8000,
    )


async def _await_admission(page, on_status: Callable[[str], None]) -> str:
    """Poll until we're in the call, denied, or we time out in the waiting room."""
    waited = 0.0
    announced_waiting = False
    while waited < JOIN_TIMEOUT_S:
        # In-call: the "Leave call" control is present.
        for sel in (
            'button[aria-label*="Leave call" i]',
            '[aria-label*="Leave call" i]',
            'button[aria-label="Leave call"]',
        ):
            try:
                if await page.locator(sel).first.is_visible():
                    return "in_call"
            except Exception:
                pass
        # Denied / removed.
        try:
            body = (await page.inner_text("body")).lower()
        except Exception:
            body = ""
        if any(s in body for s in ("you can't join", "denied", "no one responded",
                                   "removed from the meeting")):
            return "not_admitted"
        if (
            "asking to be let in" in body or "waiting for the host" in body
        ) and not announced_waiting:
            on_status("waiting_room")
            announced_waiting = True
        await asyncio.sleep(3)
        waited += 3
    return "not_admitted"


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


async def join_and_record(
    meeting_url: str,
    bot_name: str,
    out_path: str,
    leave_event: asyncio.Event,
    on_status: Callable[[str], None],
) -> None:
    from playwright.async_api import async_playwright

    on_status("joining")
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,  # headful under Xvfb so the audio pipeline works
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--use-fake-ui-for-media-stream",  # auto-accept the mic/cam prompt
                "--autoplay-policy=no-user-gesture-required",
                "--disable-notifications",
                "--window-size=1280,720",
            ],
        )
        context = await browser.new_context(
            permissions=["microphone", "camera"],
            viewport={"width": 1280, "height": 720},
        )
        page = await context.new_page()
        rec: subprocess.Popen | None = None
        try:
            await page.goto(meeting_url, wait_until="load", timeout=60000)
            await asyncio.sleep(3)  # let the green-room render
            await _maybe_fill_name(page, bot_name)
            await _mute_self(page)
            if not await _click_join(page):
                raise MeetingBotError("no join button found on the meeting page")

            admission = await _await_admission(page, on_status)
            if admission != "in_call":
                raise MeetingBotError("bot was not admitted to the call",
                                      status="not_admitted")
            on_status("in_call")

            rec = _start_ffmpeg(out_path)
            await _wait_until_end(page, leave_event)
        finally:
            on_status("processing")
            if rec is not None:
                _stop_ffmpeg(rec)
            with contextlib.suppress(Exception):
                await _leave(page)
            await context.close()
            await browser.close()
