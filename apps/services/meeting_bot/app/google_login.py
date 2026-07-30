"""Sign the notetaker into a Google account, once, into its persistent profile.

Why this exists: Google **auto-declines anonymous participants**. A signed-out
bot that clicks "Ask to join" is refused within seconds — it never even gets to
knock — whenever nobody is in the call yet or the meeting doesn't allow
link-guests to ask in. That is policy, not a selector bug, and no amount of
browser-automation cleverness fixes it. The fix every meeting-bot product uses
(Recall included) is to give the bot a real Google account.

So: point ``MEET_PROFILE_DIR`` at a volume, sign in here ONCE, and every later
join reuses those cookies. Put that address on the calendar invite and Meet
admits the bot without anyone clicking Admit.

Two ways to sign in, because Google's sign-in screen is hostile to automation:

1. **Scripted** (``POST /google-login`` with credentials, or from
   ``MEET_GOOGLE_EMAIL`` / ``MEET_GOOGLE_PASSWORD``): types the email and
   password. Works for a plain password account with no 2-step verification —
   which is what a dedicated bot account should be.
2. **By hand over VNC** (``POST /google-login/interactive``): opens the sign-in
   page in the container's real browser and leaves it open so you can drive it
   yourself through the VNC view (``MEET_VNC=1``, see the README). This is the
   escape hatch for 2FA, a passkey prompt, or a "verify it's you" wall — you
   finish the login manually and the cookies land in the same profile.

Every step screenshots itself to ``/data``, so a failure says which wall was
hit instead of "login failed".
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os

from .meet import DIAG_DIR, PROFILE_DIR, chrome_launch_args

_log = logging.getLogger("meeting_bot.google_login")

#: Long enough for the account-chooser → password → consent chain on a slow
#: box; short enough that a stuck login doesn't pin the worker forever.
STEP_TIMEOUT_MS = 20000

#: How long an interactive (VNC) session stays open waiting for a human.
INTERACTIVE_TIMEOUT_S = int(os.environ.get("MEET_LOGIN_WINDOW", "600"))


class LoginError(Exception):
    """A sign-in that didn't complete; the message is user-facing."""

    def __init__(self, message: str, diagnostics: dict | None = None) -> None:
        super().__init__(message)
        self.diagnostics = diagnostics or {}


def configured_credentials() -> tuple[str, str]:
    return (
        os.environ.get("MEET_GOOGLE_EMAIL", "").strip(),
        os.environ.get("MEET_GOOGLE_PASSWORD", "").strip(),
    )


async def _shot(page, tag: str) -> str | None:
    """Screenshot the current step (never raises)."""
    path = os.path.join(DIAG_DIR, f"google-login-{tag}.png")
    try:
        os.makedirs(DIAG_DIR, exist_ok=True)
        await page.screenshot(path=path)
        return path
    except Exception:
        return None


async def _page_state(page) -> dict:
    state: dict = {"url": None, "title": None, "body": ""}
    with contextlib.suppress(Exception):
        state["url"] = page.url
    with contextlib.suppress(Exception):
        state["title"] = await page.title()
    with contextlib.suppress(Exception):
        state["body"] = " ".join((await page.inner_text("body")).split())[:800]
    return state


# Google's own words when it refuses an automated browser outright. Detected
# so the caller is told to use the interactive path rather than retrying a
# scripted login that can never succeed.
_BROWSER_BLOCKED = (
    "this browser or app may not be secure",
    "couldn't sign you in",
    "try using a different browser",
)

# Signals that the account got in but Google wants another factor. Also a
# "finish it by hand" case, not a failure to retry.
_NEEDS_HUMAN = (
    "2-step verification",
    "verify it's you",
    "verify it’s you",
    "enter the code",
    "check your phone",
    "passkey",
    "recovery email",
)


def classify_login_page(body: str) -> str | None:
    """``blocked`` / ``needs_human`` / None, from Google's own copy.

    Pure, so the phrase lists are testable without a browser — and the
    distinction decides what the operator is told to do next, which is the
    whole value of this module.
    """
    low = " ".join((body or "").lower().split())
    if any(s in low for s in _BROWSER_BLOCKED):
        return "blocked"
    if any(s in low for s in _NEEDS_HUMAN):
        return "needs_human"
    return None


async def _open_context(p):
    """Launch the persistent profile with the same disguise the join path uses.

    Sharing ``chrome_launch_args`` is load-bearing: sign in with a browser
    Google can fingerprint as automated and it refuses ("this browser or app
    may not be secure") — the login has to look exactly like the join.
    """
    if not PROFILE_DIR:
        raise LoginError(
            "MEET_PROFILE_DIR isn't set, so there is no profile to sign in to. "
            "Set it (the deploy points it at a volume) and restart the worker."
        )
    os.makedirs(PROFILE_DIR, exist_ok=True)
    chrome_path = os.environ.get("CHROME_EXECUTABLE", "").strip() or None
    return await p.chromium.launch_persistent_context(
        PROFILE_DIR,
        headless=False,
        executable_path=chrome_path,
        ignore_default_args=["--enable-automation"],
        args=chrome_launch_args(),
        viewport={"width": 1280, "height": 720},
        locale="en-US",
    )


async def current_account() -> dict:
    """Which Google account the profile is signed in as (if any).

    Read from Meet itself rather than a Google settings page: what matters is
    whether *Meet* sees a signed-in user, which is exactly the thing that
    decides whether a join gets auto-declined.
    """
    if not PROFILE_DIR:
        return {"profile": None, "signed_in": False,
                "detail": "MEET_PROFILE_DIR is not set"}
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        context = await _open_context(p)
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(
                "https://meet.google.com/?hl=en", wait_until="load", timeout=45000
            )
            await asyncio.sleep(2)
            email = ""
            with contextlib.suppress(Exception):
                # The account chip's aria-label carries the address.
                email = await page.evaluate(
                    """() => {
                      const el = document.querySelector(
                        'a[aria-label*="@"],[aria-label*="Google Account"]');
                      if (!el) return "";
                      const m = (el.getAttribute('aria-label')||'')
                        .match(/[\\w.+-]+@[\\w.-]+\\.\\w+/);
                      return m ? m[0] : "";
                    }"""
                )
            state = await _page_state(page)
            body_low = (state.get("body") or "").lower()
            signed_in = bool(email) or (
                "sign in" not in body_low[:200] and "new meeting" in body_low
            )
            await _shot(page, "status")
            return {
                "profile": PROFILE_DIR,
                "signed_in": signed_in,
                "email": email or None,
                "url": state.get("url"),
            }
        finally:
            with contextlib.suppress(Exception):
                await context.close()


async def sign_in(email: str = "", password: str = "") -> dict:
    """Scripted sign-in into the persistent profile. Raises LoginError."""
    email = (email or "").strip() or configured_credentials()[0]
    password = (password or "").strip() or configured_credentials()[1]
    if not email or not password:
        raise LoginError(
            "No credentials. Pass {email, password}, or set MEET_GOOGLE_EMAIL "
            "and MEET_GOOGLE_PASSWORD on the worker."
        )
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        context = await _open_context(p)
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(
                "https://accounts.google.com/ServiceLogin"
                "?service=meet&hl=en&continue=https://meet.google.com/",
                wait_until="load",
                timeout=60000,
            )
            await asyncio.sleep(2)

            # Already signed in → Google skips straight past the form.
            if "meet.google.com" in page.url:
                await _shot(page, "already")
                return {"ok": True, "already_signed_in": True, "email": email}

            state = await _page_state(page)
            verdict = classify_login_page(state.get("body") or "")
            if verdict == "blocked":
                shot = await _shot(page, "blocked")
                raise LoginError(
                    "Google refused to show the sign-in form to this browser "
                    "('may not be secure'). Scripted login can't get past "
                    "that — use POST /google-login/interactive and finish the "
                    "sign-in yourself over VNC.",
                    {"screenshot": shot, **state},
                )

            # Email step.
            try:
                await page.fill('input[type="email"]', email, timeout=STEP_TIMEOUT_MS)
                await page.keyboard.press("Enter")
            except Exception as exc:
                shot = await _shot(page, "no-email-field")
                raise LoginError(
                    "Couldn't find Google's email field — the sign-in layout "
                    "changed or a consent screen is in the way. See the "
                    "screenshot.",
                    {"screenshot": shot, **await _page_state(page)},
                ) from exc
            await asyncio.sleep(3)

            # Password step.
            try:
                await page.fill(
                    'input[type="password"]', password, timeout=STEP_TIMEOUT_MS
                )
                await page.keyboard.press("Enter")
            except Exception as exc:
                st = await _page_state(page)
                shot = await _shot(page, "no-password-field")
                v = classify_login_page(st.get("body") or "")
                msg = (
                    "Google asked for another factor before the password step."
                    if v == "needs_human"
                    else "Couldn't reach Google's password field (wrong "
                    "address, or an interstitial appeared)."
                )
                raise LoginError(
                    msg + " Finish it by hand with POST "
                    "/google-login/interactive over VNC.",
                    {"screenshot": shot, **st},
                ) from exc

            # Settle, then judge by where we ended up.
            for _ in range(12):
                await asyncio.sleep(2)
                if "meet.google.com" in page.url:
                    break
            st = await _page_state(page)
            shot = await _shot(page, "final")
            if "meet.google.com" not in (st.get("url") or ""):
                v = classify_login_page(st.get("body") or "")
                if v == "needs_human":
                    raise LoginError(
                        "Password accepted, but Google wants a second factor "
                        "(2-step / verify-it's-you). Use POST "
                        "/google-login/interactive and complete it over VNC — "
                        "or better, use a dedicated bot account without 2FA.",
                        {"screenshot": shot, **st},
                    )
                raise LoginError(
                    "Sign-in didn't land on Meet. See the screenshot for the "
                    "page Google actually showed.",
                    {"screenshot": shot, **st},
                )
            _log.info("google_login.ok email=%s", email)
            return {"ok": True, "email": email, "url": st.get("url"),
                    "screenshot": shot}
        finally:
            with contextlib.suppress(Exception):
                await context.close()


# ── Interactive (VNC) sign-in ────────────────────────────────────────────────
# One at a time: Chrome locks the profile directory, and a second launch
# against a locked profile fails in a way that looks like a login bug.

_interactive: dict = {"task": None, "started": 0.0, "done": False, "note": ""}


async def _interactive_session(window_s: int) -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        context = await _open_context(p)
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            with contextlib.suppress(Exception):
                await page.goto(
                    "https://accounts.google.com/ServiceLogin"
                    "?service=meet&hl=en&continue=https://meet.google.com/",
                    wait_until="load",
                    timeout=60000,
                )
            # Hold the browser open so a human can drive it over VNC, ending
            # early once Meet is reached (login done) to release the profile.
            waited = 0
            while waited < window_s:
                await asyncio.sleep(5)
                waited += 5
                with contextlib.suppress(Exception):
                    if "meet.google.com" in page.url:
                        await asyncio.sleep(5)  # let cookies settle
                        _interactive["note"] = "signed in — Meet reached"
                        break
            await _shot(page, "interactive-end")
        finally:
            _interactive["done"] = True
            with contextlib.suppress(Exception):
                await context.close()


def interactive_status() -> dict:
    task = _interactive.get("task")
    running = bool(task) and not task.done()
    return {
        "running": running,
        "note": _interactive.get("note") or "",
        "vnc_enabled": os.environ.get("MEET_VNC", "") == "1",
    }


def start_interactive(window_s: int | None = None) -> dict:
    """Open the sign-in page in the container's browser for a human to finish."""
    if not PROFILE_DIR:
        raise LoginError(
            "MEET_PROFILE_DIR isn't set, so there is no profile to sign in to."
        )
    task = _interactive.get("task")
    if task and not task.done():
        return {"ok": True, "already_running": True, **interactive_status()}
    _interactive["note"] = ""
    _interactive["done"] = False
    window = int(window_s or INTERACTIVE_TIMEOUT_S)
    _interactive["task"] = asyncio.create_task(_interactive_session(window))
    return {
        "ok": True,
        "window_seconds": window,
        "vnc_enabled": os.environ.get("MEET_VNC", "") == "1",
        "how": (
            "Open the VNC view (see the meeting-bot README: MEET_VNC=1, then "
            "ssh -L 6080:127.0.0.1:6080 and browse to http://localhost:6080), "
            "complete the Google sign-in, and stop when Meet loads. The "
            "cookies persist in the bot's profile."
        ),
    }
