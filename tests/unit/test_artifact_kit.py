"""The @cc/ui reference must stay honest without anyone maintaining it by hand.

``artifact_kit.json`` is generated from ``artifactUi.tsx`` and committed so
acb_skills has no runtime dependency on the frontend tree. That trade only works
if staleness is caught, so the drift test below re-parses the real source and
fails when the two disagree — the same guard CC_CLASSES uses.

The rest of these tests pin the parser against the shapes that actually bit:
a JSDoc containing a semicolon, and an unexported helper directly above an
export.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from acb_skills.artifact_kit import load_artifact_kit, parse_kit_source

REPO_ROOT = Path(__file__).resolve().parents[2]
KIT_SOURCE = REPO_ROOT / "workbench" / "control_plane" / "src" / "lib" / "artifactUi.tsx"
MANIFEST = REPO_ROOT / "packages" / "acb_skills" / "acb_skills" / "artifact_kit.json"


def test_manifest_matches_the_component_source() -> None:
    """Regenerate and compare. Fix with: uv run python scripts/gen_artifact_kit.py"""
    assert KIT_SOURCE.exists(), f"missing {KIT_SOURCE}"
    fresh = parse_kit_source(KIT_SOURCE.read_text(encoding="utf-8"))
    committed = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert fresh == committed, (
        "artifact_kit.json is stale relative to artifactUi.tsx — agents would be "
        "told about props that no longer exist (or miss new ones). Regenerate "
        "with: uv run python scripts/gen_artifact_kit.py"
    )


def test_every_component_has_a_summary() -> None:
    """An undocumented component is invisible in the index — it may as well not
    exist, since that listing is how an agent discovers the kit."""
    kit = json.loads(MANIFEST.read_text(encoding="utf-8"))
    undocumented = [c["name"] for c in kit if not c["summary"].strip()]
    assert not undocumented, f"components missing a JSDoc summary: {undocumented}"


# ── Parser regressions ─────────────────────────────────────────────────────

def test_a_jsdoc_containing_a_semicolon_does_not_drop_the_prop() -> None:
    source = """
// ── Numbers ──────────────
/** A tile. */
export function Stat({
  label, delta,
}: {
  label: ReactNode;
  /** Signed change; sign picks the colour. */
  delta?: number;
}) { return null; }
"""
    [stat] = parse_kit_source(source)
    assert [p["name"] for p in stat["props"]] == ["label", "delta"]
    assert stat["props"][1]["optional"] is True
    assert "sign picks the colour" in stat["props"][1]["doc"]


def test_an_export_does_not_inherit_a_preceding_helper_docstring() -> None:
    source = """
/** Internal geometry helper, not a component. */
function plot(v) { return v; }

/** Tiny inline sparkline. */
export function Spark({ values }: { values: number[] }) { return null; }
"""
    [spark] = parse_kit_source(source)
    assert spark["summary"] == "Tiny inline sparkline."


def test_nested_object_types_survive_intact() -> None:
    source = """
/** Bars. */
export function Bars({ data }: {
  data: { label: ReactNode; value: number; tone?: Tone }[];
}) { return null; }
"""
    [bars] = parse_kit_source(source)
    assert bars["props"][0]["type"] == "{ label: ReactNode; value: number; tone?: Tone }[]"


def test_section_headings_group_the_index() -> None:
    kit = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert {c["section"] for c in kit} != {""}, "components should be grouped by section"


# ── The tool's two tiers ───────────────────────────────────────────────────

def test_index_is_compact_and_lists_every_component() -> None:
    kit = json.loads(MANIFEST.read_text(encoding="utf-8"))
    index = asyncio.run(load_artifact_kit())
    for comp in kit:
        assert comp["name"] in index
    # The whole point is discovery that costs less than hand-writing markup.
    assert len(index) < 3_000, "the index has grown expensive; tighten the summaries"
    # An index must not carry prop signatures — that is the second tier's job.
    assert "ReactNode[][]" not in index


def test_named_lookup_returns_only_what_was_asked_for() -> None:
    out = asyncio.run(load_artifact_kit("Stat,Table"))
    assert "Stat" in out and "Table" in out
    assert "label" in out and "columns" in out
    # Not a dump of the whole kit.
    assert "Timeline" not in out
    assert "Donuts" not in out


def test_lookup_is_case_insensitive_and_reports_unknown_names() -> None:
    out = asyncio.run(load_artifact_kit("stat,Nonsense"))
    assert "Stat" in out
    assert "Nonsense" in out.lower() or "no such component" in out.lower()


def test_unknown_name_alone_lists_what_is_available() -> None:
    out = asyncio.run(load_artifact_kit("Nope"))
    assert "Report" in out and "Stat" in out
