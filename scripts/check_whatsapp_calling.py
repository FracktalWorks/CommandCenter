"""Is the WhatsApp Business Calling API enabled on our number?

Hard gate for Phase A of project-docs/specs/whatsapp_calls_note_taker.md:
we can't build a WhatsApp note taker on the official path until Meta has
switched calling on for the WABA. Rollout is gated per-number, so this is a
question only the live API can answer.

Reads WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN from the environment,
falling back to the repo-root .env. Stdlib only — run it anywhere:

    python3 scripts/check_whatsapp_calling.py

Read-only. It never flips a setting; enabling calling is a deliberate act and
the command to do it is printed rather than run.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

GRAPH = "https://graph.facebook.com"
VERSION = os.environ.get("WHATSAPP_GRAPH_VERSION", "v21.0").strip() or "v21.0"


def load_env() -> None:
    """Fill missing WHATSAPP_* vars from the repo-root .env (real env wins)."""
    env = Path(__file__).resolve().parent.parent / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k.startswith("WHATSAPP_") and v and not os.environ.get(k):
            os.environ[k] = v


def get(path: str, token: str):
    req = urllib.request.Request(
        f"{GRAPH}/{VERSION}/{path}",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:600]
        try:
            return e.code, json.loads(body)
        except ValueError:
            return e.code, {"raw": body}
    except Exception as e:  # network, DNS, TLS
        return None, {"error": str(e)[:300]}


def main() -> int:
    load_env()
    pnid = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip()
    token = os.environ.get("WHATSAPP_ACCESS_TOKEN", "").strip()

    if not pnid or not token:
        print("✗ No credentials.")
        print("  Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN (or put")
        print("  them in the repo-root .env) and run this again.")
        return 2

    print(f"Graph {VERSION} · phone_number_id {pnid}\n")

    status, num = get(f"{pnid}?fields=display_phone_number,verified_name,quality_rating", token)
    if status == 200:
        print(f"  number   {num.get('display_phone_number', '?')} "
              f"({num.get('verified_name', '?')}) · quality {num.get('quality_rating', '?')}")
    else:
        err = (num.get("error") or {}).get("message", num)
        print(f"✗ Can't read the phone number ({status}): {err}")
        print("  The token is wrong, expired, or lacks whatsapp_business_management.")
        return 2

    # The calling switch lives on the phone number's settings edge.
    status, settings = get(f"{pnid}/settings", token)

    if status == 200:
        calling = settings.get("calling")
        if calling is None:
            print("\n?  The settings edge returned no `calling` object.")
            print("   Calling almost certainly isn't provisioned for this number yet.")
            print("   Full response for the record:")
            print("   " + json.dumps(settings)[:400])
            return 1
        state = str(calling.get("status", "")).upper()
        if state == "ENABLED":
            print("\n✓ CALLING IS ENABLED on this number.")
            print(f"  call_icon_visibility: {calling.get('call_icon_visibility', 'DEFAULT')}")
            print("\n  Phase A is unblocked. Next: subscribe the webhook to the `calls`")
            print("  field and stand up a media endpoint to answer the SDP offer.")
            return 0
        print(f"\n○ Calling is provisioned but currently {state or 'DISABLED'}.")
        print("  Nothing is blocking us — it's a switch we own. To turn it on:")
        print(f"\n    curl -X POST '{GRAPH}/{VERSION}/{pnid}/settings' \\")
        print("      -H \"Authorization: Bearer $WHATSAPP_ACCESS_TOKEN\" \\")
        print("      -H 'Content-Type: application/json' \\")
        print("      -d '{\"calling\":{\"status\":\"ENABLED\"}}'")
        return 0

    err = (settings.get("error") or {}) if isinstance(settings, dict) else {}
    msg = err.get("message", settings)
    if status in (400, 401, 403):
        print(f"\n✗ CALLING IS NOT AVAILABLE on this number ({status}).")
        print(f"  Meta says: {msg}")
        print("\n  Meta gates the Calling API per-number during rollout; a 401/403 here")
        print("  means it hasn't been switched on for us. This is not something we can")
        print("  engineer around — ask Meta or our BSP to enable it on the WABA.")
        print("  Until then Phase A is blocked and only the unofficial path (§1 Surface C)")
        print("  or the upload fallback (§1 Surface D) can carry WhatsApp call notes.")
        return 1

    print(f"\n? Unexpected response ({status}): {msg}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
