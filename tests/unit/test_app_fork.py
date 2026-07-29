"""Custom Apps — fork/remix (`_fork_workspace`, the pure filesystem step).

`POST /{slug}/fork` copies a source app's SOURCE FILES into a fresh
workspace (via durability._read_workspace_files, reused rather than
re-walking the tree) with a corrected app.json identity and a fresh git
history — never the source's runtime data/sharing/history, which all stay
DB-side untouched. This locks the filesystem half; the DB-row half needs a
live Postgres (matching this codebase's existing convention of not
integration-testing the DB-backed endpoints directly — see write_app_file,
create_app, none of which have endpoint-level tests either).
"""
from __future__ import annotations

from pathlib import Path

from gateway.routes.apps.lifecycle import _fork_workspace


def test_fork_copies_files_and_corrects_identity(tmp_path: Path):
    new_workspace = tmp_path / "quote-calc-fork"
    files = {
        "app.json": ('{"slug": "quote-calc", "name": "Quote Calc"}', "sha-a"),
        "index.html": ("<html>original</html>", "sha-b"),
        "src/App.tsx": ("export default function App() {}", "sha-c"),
    }
    manifest = {"slug": "quote-calc-fork", "name": "Quote Calc (fork)", "tier": "T2"}

    _fork_workspace(new_workspace, files, manifest)

    assert (new_workspace / "index.html").read_text() == "<html>original</html>"
    assert (new_workspace / "src" / "App.tsx").read_text() == (
        "export default function App() {}"
    )
    # app.json is overwritten with the corrected identity, not the source's copy.
    import json
    written = json.loads((new_workspace / "app.json").read_text())
    assert written["slug"] == "quote-calc-fork"
    assert written["name"] == "Quote Calc (fork)"


def test_fork_gets_fresh_git_history_not_the_source(tmp_path: Path):
    new_workspace = tmp_path / "forked-app"
    _fork_workspace(new_workspace, {"index.html": ("<html></html>", "x")}, {"slug": "a"})

    assert (new_workspace / ".git").is_dir()


def test_fork_never_copies_runtime_dirs_because_read_workspace_files_already_excludes_them(
    tmp_path: Path,
):
    # _fork_workspace only ever writes what it's handed — the exclusion of
    # inputs/outputs/agent-data/dist happens upstream in
    # durability.list_workspace_text_files (already covered by its own
    # tests); this just locks that _fork_workspace doesn't ADD anything back.
    new_workspace = tmp_path / "clean-fork"
    _fork_workspace(new_workspace, {"app.json": ("{}", "x")}, {"slug": "a"})

    all_paths = {p.relative_to(new_workspace) for p in new_workspace.rglob("*")}
    assert Path("inputs") not in all_paths
    assert Path("outputs") not in all_paths
    assert Path("agent-data") not in all_paths
