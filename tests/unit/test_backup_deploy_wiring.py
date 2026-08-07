"""Guards for BO-23's unit delivery: the backup timer must ride the LIVE path.

PR #380 wrote the systemd unit-sync loop into deploy/hostinger/deploy.sh — the
manual runbook script — while both automated delivery paths (the workflow's SSH
step and the box's acb-pull poller) execute scripts/vps_apply.sh. The merge went
green, the deploy went green, and the backup timer stayed unscheduled: the exact
"correction exists on paper" failure the WS-25 guards exist to catch, one file
over. These pin the loop into the file that actually runs, and keep the manual
copy from silently drifting away from it.

Idiom note (learned the hard way in test_meeting_bot_deploy_wiring): every
assertion here reads NON-COMMENT lines. A guard satisfied by prose certifies
the documentation, not the wiring.
"""
from __future__ import annotations

import pathlib

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_APPLY = _ROOT / "scripts/vps_apply.sh"
_MANUAL = _ROOT / "deploy/hostinger/deploy.sh"
_UNITS_DIR = _ROOT / "deploy/hostinger"


def _executable_lines(path: pathlib.Path) -> list[str]:
    return [
        ln
        for ln in path.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]


def test_the_live_delivery_path_syncs_units_from_the_repo() -> None:
    """The loop must glob the units directory and install on change — in the
    file the workflow and the poller actually execute."""
    lines = _executable_lines(_APPLY)
    assert any(
        "deploy/hostinger/*.service" in ln and "for " in ln for ln in lines
    ), "vps_apply.sh must iterate the repo's unit files"
    assert any(
        "install -m 0644" in ln and "/etc/systemd/system/" in ln for ln in lines
    ), "vps_apply.sh must install changed units into /etc/systemd/system"


def test_the_live_delivery_path_enables_every_repo_timer() -> None:
    """`enable --now` over the timer glob — a timer added to the repo arrives
    scheduled, without anyone remembering it."""
    lines = _executable_lines(_APPLY)
    enabling = [ln for ln in lines if "enable --now" in ln]
    assert any(
        '"$(basename "$timer")"' in ln for ln in enabling
    ), "vps_apply.sh must enable timers from the glob, not from a hand list"


def test_the_live_delivery_path_never_restarts_services_from_the_sync_loop() -> None:
    """The loop syncs FILES and enables TIMERS only. Service restarts belong to
    the script's dedicated steps; a `systemctl restart` keyed off the unit glob
    would bounce the gateway as a side effect of any unit edit."""
    text = _APPLY.read_text(encoding="utf-8")
    assert "==> Syncing systemd units (BO-23)" in text
    window = text[text.index("==> Syncing systemd units (BO-23)"):]
    window = window[: window.index("==> ", 10)]  # this step only
    assert "systemctl restart" not in window


def test_the_backup_units_exist_and_the_timer_has_a_schedule() -> None:
    service = (_UNITS_DIR / "acb-backup.service").read_text(encoding="utf-8")
    timer = (_UNITS_DIR / "acb-backup.timer").read_text(encoding="utf-8")
    assert "backup_db.sh" in service, "the service must run the backup script"
    assert "OnCalendar=" in timer, "a timer without a schedule schedules nothing"
    assert "WantedBy=timers.target" in timer, "unenableable timer: no [Install]"


def test_the_pg_seam_actually_reaches_docker_in_docker_mode() -> None:
    """EXECUTES the seam, does not read it. #380's first version of pg()/pgi()
    called the function's own name in the docker branch — infinite recursion, a
    bash segfault at the pre-migration gate, and every deploy after the merge
    silently stopped applying migrations while verify() blessed the old healthy
    services. CI never saw it because the rehearsal only runs PG_MODE=local.

    This runs the REAL function definitions from both scripts in docker mode
    against a stubbed `docker`, timeout-bound so a recursion fails fast instead
    of hanging the suite."""
    import subprocess

    for script in ("scripts/backup_db.sh", "scripts/restore_db.sh"):
        defs = "\n".join(
            ln
            for ln in (_ROOT / script).read_text(encoding="utf-8").splitlines()
            if ln.startswith(("pg()", "pgi()"))
        )
        assert defs, f"{script} lost its pg()/pgi() seam"
        prog = (
            "set -u\n"
            'docker() { printf "STUB %s\\n" "$*"; }\n'
            "PG_MODE=docker\nPG_CONTAINER=testc\n"
            f"{defs}\n"
            "pg echo one && pgi echo two\n"
        )
        # stdin as BYTES, not `-c` argv and not text mode: Windows argv quoting
        # mangles the embedded quotes on their way into MSYS bash, and text
        # mode rewrites \n to \r\n, which bash reads as `set -u\r`.
        run = subprocess.run(
            ["bash"], input=prog.encode(), capture_output=True, timeout=10
        )
        out = run.stdout.decode(errors="replace")
        err = run.stderr.decode(errors="replace")[:300]
        assert run.returncode == 0, f"{script}: seam crashed: {err}"
        assert "STUB exec testc echo one" in out, f"{script}: pg missed docker exec"
        assert "STUB exec -i testc echo two" in out, f"{script}: pgi missed -i"


def test_the_manual_runbook_and_the_live_path_carry_the_same_loop() -> None:
    """deploy/hostinger/deploy.sh is the hand-run runbook and keeps its copy of
    the loop; this asserts BOTH copies stay functionally present so an edit
    that 'cleans up' either one fails loudly, naming the other. If this fires
    because the duplication is being retired: fine — make the survivor the
    file that BOTH automated paths execute (scripts/vps_apply.sh), then update
    this guard, in that order."""
    for path in (_APPLY, _MANUAL):
        lines = _executable_lines(path)
        assert any(
            "deploy/hostinger/*.timer" in ln and "for " in ln for ln in lines
        ), f"{path.name} lost the timer-sync loop"
