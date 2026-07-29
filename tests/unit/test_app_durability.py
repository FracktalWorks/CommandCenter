"""Custom Apps draft durability (Phase 1) — pure coverage, no DB required.

Locks ``gateway.routes.apps.durability``: the workspace file-walk selection
rules (which files the ``app_files`` mirror takes), rehydrate's workspace
reconstruction + baseline git repo, and the git checkpoint helpers
(checkpoint → list → additive restore, all best-effort). git IS available in
CI, so the checkpoint tests run against real throwaway repos in tmp_path;
identity comes from the helpers' own ``-c user.name/user.email`` flags.
RFC: docs/app-workshop/README.md §4.9; tables: infra/postgres/115_app_files.sql.
"""
from __future__ import annotations

import subprocess
from datetime import datetime
from pathlib import Path

from gateway.routes.apps.durability import (
    git_checkpoint,
    is_checkpoint_sha,
    list_checkpoints,
    list_workspace_text_files,
    rehydrate_workspace,
    restore_checkpoint,
)


def _rel_paths(workspace: Path) -> set[str]:
    return {
        str(p.relative_to(workspace)).replace("\\", "/")
        for p in list_workspace_text_files(workspace)
    }


def _log_shas(workspace: Path) -> list[str]:
    proc = subprocess.run(
        ["git", "log", "--pretty=format:%h"], cwd=str(workspace),
        capture_output=True, text=True, timeout=10, check=False,
    )
    return [line for line in proc.stdout.splitlines() if line]


# ── File-walk selection rules ────────────────────────────────────────────────

def test_walk_takes_nested_text_files(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<html></html>")
    (tmp_path / "app.json").write_text("{}")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.js").write_text("let x = 1;")
    assert _rel_paths(tmp_path) == {"index.html", "app.json", "src/app.js"}


def test_walk_skips_dotfiles_and_dotdirs(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("ok")
    (tmp_path / ".env").write_text("SECRET=1")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("[core]")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / ".hidden").write_text("x")
    assert _rel_paths(tmp_path) == {"index.html"}


def test_walk_skips_build_and_dependency_dirs(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("ok")
    for skip in ("node_modules", "dist", "build", "__pycache__"):
        (tmp_path / skip / "sub").mkdir(parents=True)
        (tmp_path / skip / "sub" / "mod.js").write_text("x")
    assert _rel_paths(tmp_path) == {"index.html"}


def test_walk_mirrors_a_t2_entry_file_living_under_a_skip_dir(tmp_path: Path) -> None:
    """A T2 app's ``entry: dist/bundle.html`` must survive the mirror — it's
    what a lost workspace rehydrates from — while a sibling build artifact
    under the same skip-dir (a source map) still does not."""
    (tmp_path / "app.json").write_text('{"entry": "dist/bundle.html"}')
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "App.tsx").write_text("export default function App() {}")
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "bundle.html").write_text("<html></html>")
    (tmp_path / "dist" / "bundle.js.map").write_text("{}")
    (tmp_path / "node_modules" / "react").mkdir(parents=True)
    (tmp_path / "node_modules" / "react" / "index.js").write_text("x")
    assert _rel_paths(tmp_path) == {
        "app.json", "src/App.tsx", "dist/bundle.html",
    }


def test_walk_skips_oversize_and_non_utf8_files(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("ok")
    (tmp_path / "big.txt").write_bytes(b"x" * (2 * 1024 * 1024 + 1))
    (tmp_path / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\xff\xfe\x00")
    assert _rel_paths(tmp_path) == {"index.html"}


def test_walk_of_missing_dir_is_empty(tmp_path: Path) -> None:
    assert list_workspace_text_files(tmp_path / "nope") == []


# ── Rehydrate ────────────────────────────────────────────────────────────────

def test_rehydrate_recreates_workspace_with_git_baseline(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    row = {"workspace_path": str(workspace), "manifest": {}}
    rehydrate_workspace(row, [
        ("index.html", "<html>hi</html>"),
        ("src/app.js", "let x = 1;"),
    ])
    assert (workspace / "index.html").read_text() == "<html>hi</html>"
    assert (workspace / "src" / "app.js").read_text() == "let x = 1;"
    assert (workspace / ".git").is_dir()
    assert len(_log_shas(workspace)) == 1        # the baseline commit


def test_rehydrate_refuses_traversal_and_dot_paths(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    row = {"workspace_path": str(workspace), "manifest": {}}
    rehydrate_workspace(row, [
        ("../evil.txt", "no"),
        ("/abs.txt", "no"),
        (".env", "no"),
        (".git/hooks/pre-commit", "no"),
        ("ok.txt", "yes"),
    ])
    assert (workspace / "ok.txt").read_text() == "yes"
    assert not (tmp_path / "evil.txt").exists()
    assert not (workspace / ".env").exists()
    assert not (workspace / ".git" / "hooks" / "pre-commit").exists()


# ── Checkpoint → list → restore round-trip ───────────────────────────────────

def test_checkpoint_list_restore_round_trip(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "index.html").write_text("v1")

    first = git_checkpoint(ws, "first")          # inits the repo + commits
    assert first is not None and is_checkpoint_sha(first)

    (ws / "index.html").write_text("v2")
    (ws / "extra.txt").write_text("added after first")
    second = git_checkpoint(ws, "second")
    assert second is not None and second != first

    # A clean tree checkpoints to the current HEAD, without a new commit.
    assert git_checkpoint(ws, "noop") == second
    assert len(_log_shas(ws)) == 2

    checkpoints = list_checkpoints(ws)
    assert [c["sha"] for c in checkpoints] == [second, first]
    assert checkpoints[0]["message"] == "second"
    assert checkpoints[0]["files_changed"] == 2  # index.html + extra.txt
    assert checkpoints[1]["files_changed"] == 1
    for c in checkpoints:
        datetime.fromisoformat(c["at"])          # %cI is parseable ISO

    restored = restore_checkpoint(ws, first)
    assert restored is not None
    assert restored not in (first, second)       # a NEW restore commit
    assert (ws / "index.html").read_text() == "v1"


def test_restore_is_additive_and_history_grows(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "a.txt").write_text("a1")
    first = git_checkpoint(ws, "first")
    (ws / "a.txt").write_text("a2")
    (ws / "later.txt").write_text("born after first")
    git_checkpoint(ws, "second")

    before = _log_shas(ws)
    assert restore_checkpoint(ws, str(first)) is not None
    # Additive: the file created after the checkpoint survives the restore…
    assert (ws / "later.txt").read_text() == "born after first"
    assert (ws / "a.txt").read_text() == "a1"
    # …and history only grew — the old log is intact under one new commit.
    after = _log_shas(ws)
    assert len(after) == len(before) + 1
    assert after[1:] == before


def test_restore_of_current_state_is_a_noop_success(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "a.txt").write_text("a")
    sha = git_checkpoint(ws, "only")
    assert restore_checkpoint(ws, str(sha)) == sha
    assert len(_log_shas(ws)) == 1               # nothing to commit


# ── Bad shas + best-effort degradation ───────────────────────────────────────

def test_restore_rejects_non_hex_refs(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "a.txt").write_text("a")
    git_checkpoint(ws, "first")
    for bad in (
        "HEAD", "main", "HEAD~1", "abc123..def456", "a" * 41, "abc123",
        "deadbee$", "; rm -rf /", "", "  ",
    ):
        assert not is_checkpoint_sha(bad)
        assert restore_checkpoint(ws, bad) is None, bad
    assert len(_log_shas(ws)) == 1               # nothing snuck in


def test_restore_unknown_but_valid_hex_sha_fails_closed(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "a.txt").write_text("a")
    git_checkpoint(ws, "first")
    assert is_checkpoint_sha("deadbeef")
    assert restore_checkpoint(ws, "deadbeef") is None


def test_git_helpers_degrade_without_a_repo(tmp_path: Path) -> None:
    assert git_checkpoint(tmp_path / "missing", "x") is None
    assert list_checkpoints(tmp_path) == []      # dir exists, no repo
    assert restore_checkpoint(tmp_path, "abcdef1") is None
