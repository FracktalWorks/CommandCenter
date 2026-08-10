"""The upstream REF: links in the Projects spec stay well-formed and real.

The owner asked (2026-08-10) that every feature carry a link back to the file
that inspired it, "so that when we are developing it, we always have a
reference to the original file to study". A link that 404s is worse than no
link: it sends a developer hunting, and it quietly discredits every other link
on the page. So the convention is fenced rather than trusted.

Two properties, and only the first can be checked without the upstream repos:

1. **Well-formed, and pinned to the SHA §9.0 declares.** A link against a
   moving branch points at different code every week; a link against a SHA the
   spec does not declare is one nobody can audit. This runs everywhere.
2. **The path exists at that commit.** Only checkable where the read-only
   clone happens to be present (it is not in CI), so it SKIPS rather than
   failing — but when it can run, it is the check that matters.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC = REPO_ROOT / "project-docs" / "specs" / "project_management_app.md"

#: The pinned commits §9.0 declares, and where a local read-only clone lands.
UPSTREAM = {
    "makeplane/plane": ("31853ab2b8b7810c59dc30d22e52c8f4b5a71a47",
                        Path("/workspace/makeplane/plane")),
    "paca-ai/paca": ("09dab28e3caee9e43891697998dcfa7fcf76991c",
                     Path("/workspace/paca-ai/paca")),
}

#: ⚠️ The path class excludes backticks and pipes deliberately. §9.0 documents
#: the LINK PREFIX for each repo inside a markdown table — `https://…/blob/<sha>/`
#: — and a looser class captures the closing backtick as a one-character "path".
#: The fence found that on its first run, which is the argument for the fence.
LINK = re.compile(
    r"https://github\.com/([^/]+/[^/]+)/blob/([0-9a-f]{7,40})/([^)\s#`|]+)(#L\d+(?:-L\d+)?)?"
)


def _links() -> list[tuple[str, str, str]]:
    text = SPEC.read_text(encoding="utf-8")
    return [(m.group(1), m.group(2), m.group(3)) for m in LINK.finditer(text)]


def test_the_spec_actually_carries_reference_links() -> None:
    """Guards every assertion below from passing vacuously.

    A regex that matches nothing makes 'all links are valid' trivially true,
    which is the failure mode that makes a fence worse than none.
    """
    assert len(_links()) >= 10, (
        "§9.0 declares a REF: convention but the spec carries almost no links. "
        "Either the convention was abandoned (remove §9.0) or the links were "
        "lost in an edit."
    )


def test_every_link_names_a_repo_the_spec_pinned() -> None:
    unknown = sorted({repo for repo, _, _ in _links() if repo not in UPSTREAM})
    assert not unknown, (
        f"These repos are linked but not declared in §9.0: {unknown}. A reader "
        "cannot check the licence rule for a repo the spec never introduced — "
        "and the two we do have carry DIFFERENT rules (AGPL vs Apache-2.0)."
    )


def test_every_link_is_pinned_to_the_declared_commit() -> None:
    """A link against any other ref is unauditable and will rot."""
    wrong = [
        (repo, sha) for repo, sha, _ in _links()
        if not UPSTREAM[repo][0].startswith(sha)
    ]
    assert not wrong, (
        f"Links pinned to a commit §9.0 does not declare: {sorted(set(wrong))}. "
        "Update §9.0's table and every link together, or the two disagree and "
        "nobody can tell which is right."
    )


@pytest.mark.parametrize("repo", sorted(UPSTREAM))
def test_every_linked_path_exists_upstream(repo: str) -> None:
    """The check that actually matters — skipped when the clone is absent."""
    sha, clone = UPSTREAM[repo]
    if not (clone / ".git").is_dir():
        pytest.skip(
            f"no local read-only clone of {repo} at {clone}. ⚠️ This is the only "
            "test that proves a REF: path resolves; a green run without it "
            "proves the links are well-formed, not that they are real."
        )
    missing = sorted({
        path for linked_repo, _, path in _links()
        if linked_repo == repo and not (clone / path).exists()
    })
    assert not missing, (
        f"REF: paths that do not exist in {repo} at {sha}: {missing}. A link "
        "that 404s sends a developer to the wrong place and discredits the rest."
    )
