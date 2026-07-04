#!/usr/bin/env python
"""Codebase-health measurement — one command, complexity + size + trend report.

The shared measurement engine behind the dev-velocity tooling
(ai-company-brain/specs/dev_velocity_tooling_2026-07.md). It reports the
structural-health signals that predict *agent drag* — the cost a coding agent
pays to edit a file: cyclomatic complexity (per function), file size (LOC), and
the maintainability index. It is deliberately dependency-light (radon only) and
read-only — it measures and flags, it never edits.

Two consumers:
  * CI (pr-check.yml) runs it non-blocking as the ratchet dashboard.
  * The scheduled ``codebase-health`` agent runs it weekly and opens issues/PRs
    for threshold crossings (flag-and-propose — never auto-refactor).

Usage:
    uv run python scripts/codebase_health.py                 # human table
    uv run python scripts/codebase_health.py --json          # machine-readable
    uv run python scripts/codebase_health.py --diff          # only files changed
                                                             #   vs the merge-base
    uv run python scripts/codebase_health.py --top 20        # N worst blocks
    uv run python scripts/codebase_health.py --paths apps packages

Thresholds (grandfather-and-ratchet — see the spec):
    CC_HEALTH_CC_WARN      per-function cyclomatic complexity warn  (default 15)
    CC_HEALTH_CC_FAIL      per-function cyclomatic complexity fail  (default 25)
    CC_HEALTH_LOC_WARN     file LOC warn                            (default 800)
    CC_HEALTH_MI_FAIL      maintainability-index fail (radon: <10 = F, <20 = C)
                                                                    (default 10)

Exit code is 0 unless ``--strict`` is passed AND a FAIL threshold is crossed;
by default the script always exits 0 (it is a dashboard, not a gate — the gate
is xenon in CI).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass, field

# radon is a dev dependency (see root pyproject [dependency-groups].dev).
from radon.complexity import cc_visit
from radon.metrics import mi_visit

_DEFAULT_PATHS = ["apps", "packages"]
_CC_WARN = int(os.environ.get("CC_HEALTH_CC_WARN", "15"))
_CC_FAIL = int(os.environ.get("CC_HEALTH_CC_FAIL", "25"))
_LOC_WARN = int(os.environ.get("CC_HEALTH_LOC_WARN", "800"))
_MI_FAIL = float(os.environ.get("CC_HEALTH_MI_FAIL", "10"))


@dataclass
class Block:
    """A single function/method and its cyclomatic complexity."""

    path: str
    name: str
    lineno: int
    complexity: int

    @property
    def grade(self) -> str:
        # radon's standard CC grade bands.
        c = self.complexity
        if c <= 5:
            return "A"
        if c <= 10:
            return "B"
        if c <= 20:
            return "C"
        if c <= 30:
            return "D"
        if c <= 40:
            return "E"
        return "F"


@dataclass
class FileReport:
    path: str
    loc: int
    max_cc: int
    mi: float  # maintainability index (0-100; higher is better)


@dataclass
class HealthReport:
    blocks_over_warn: list[Block] = field(default_factory=list)
    blocks_over_fail: list[Block] = field(default_factory=list)
    files_over_loc: list[FileReport] = field(default_factory=list)
    files_low_mi: list[FileReport] = field(default_factory=list)
    worst_blocks: list[Block] = field(default_factory=list)
    total_blocks: int = 0
    avg_cc: float = 0.0
    files_scanned: int = 0


def _iter_py_files(paths: list[str], diff_only: bool) -> list[str]:
    if diff_only:
        return _changed_py_files()
    out: list[str] = []
    for base in paths:
        try:
            res = subprocess.run(
                ["git", "ls-files", f"{base}/**/*.py", f"{base}/*.py"],
                capture_output=True,
                text=True,
                check=False,
            )
            out.extend(p for p in res.stdout.splitlines() if p.strip())
        except OSError:
            continue
    # Skip vendored / migration / generated noise.
    return [p for p in out if "__pycache__" not in p and "/migrations/" not in p]


def _changed_py_files() -> list[str]:
    """Python files changed vs the merge-base with origin/main (or HEAD~1)."""
    base = "origin/main"
    mb = subprocess.run(
        ["git", "merge-base", "HEAD", base],
        capture_output=True,
        text=True,
        check=False,
    )
    ref = mb.stdout.strip() or "HEAD~1"
    res = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=d", ref, "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    return [
        p
        for p in res.stdout.splitlines()
        if p.endswith(".py") and "__pycache__" not in p
    ]


def analyze(paths: list[str], diff_only: bool, top: int) -> HealthReport:
    report = HealthReport()
    all_cc: list[int] = []

    for path in _iter_py_files(paths, diff_only):
        try:
            with open(path, encoding="utf-8-sig") as fh:  # -sig strips BOM
                src = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        report.files_scanned += 1
        loc = src.count("\n") + 1

        # Cyclomatic complexity per function/method.
        file_max_cc = 0
        try:
            for b in cc_visit(src):
                block = Block(path, b.name, b.lineno, b.complexity)
                all_cc.append(b.complexity)
                file_max_cc = max(file_max_cc, b.complexity)
                if b.complexity >= _CC_FAIL:
                    report.blocks_over_fail.append(block)
                if b.complexity >= _CC_WARN:
                    report.blocks_over_warn.append(block)
                report.worst_blocks.append(block)
        except SyntaxError:
            continue

        # Maintainability index (0-100). radon can raise broadly on odd files.
        try:
            mi = mi_visit(src, multi=True)
        except Exception:
            mi = 100.0

        fr = FileReport(path, loc, file_max_cc, round(mi, 1))
        if loc > _LOC_WARN:
            report.files_over_loc.append(fr)
        if mi < _MI_FAIL:
            report.files_low_mi.append(fr)

    report.total_blocks = len(all_cc)
    report.avg_cc = round(sum(all_cc) / len(all_cc), 2) if all_cc else 0.0
    report.worst_blocks.sort(key=lambda b: b.complexity, reverse=True)
    report.worst_blocks = report.worst_blocks[:top]
    report.blocks_over_warn.sort(key=lambda b: b.complexity, reverse=True)
    report.files_over_loc.sort(key=lambda f: f.loc, reverse=True)
    return report


def _print_human(report: HealthReport) -> None:
    print("=" * 72)
    print("CODEBASE HEALTH REPORT")
    print("=" * 72)
    print(f"Files scanned:  {report.files_scanned}")
    print(f"Functions:      {report.total_blocks}")
    print(f"Avg complexity: {report.avg_cc}  (grade {'A' if report.avg_cc <= 5 else 'B' if report.avg_cc <= 10 else 'C'})")
    print(f"Over cc={_CC_WARN} (warn): {len(report.blocks_over_warn)}   "
          f"Over cc={_CC_FAIL} (fail): {len(report.blocks_over_fail)}")
    print()

    if report.worst_blocks:
        print(f"-- {len(report.worst_blocks)} WORST FUNCTIONS " + "-" * 40)
        for b in report.worst_blocks:
            print(f"  {b.complexity:4d} [{b.grade}]  {b.path}:{b.lineno}  {b.name}")
        print()

    if report.files_over_loc:
        print(f"-- FILES OVER {_LOC_WARN} LOC ({len(report.files_over_loc)}) " + "-" * 30)
        for f in report.files_over_loc[:20]:
            print(f"  {f.loc:5d} LOC  (max cc {f.max_cc}, MI {f.mi})  {f.path}")
        print()

    if report.files_low_mi:
        print(f"-- LOW MAINTAINABILITY INDEX (<{_MI_FAIL}) ({len(report.files_low_mi)}) " + "-" * 20)
        for f in report.files_low_mi:
            print(f"  MI {f.mi:5.1f}  ({f.loc} LOC)  {f.path}")
        print()

    if not (report.worst_blocks or report.files_over_loc or report.files_low_mi):
        print("No health signals over threshold. OK")


def main() -> int:
    ap = argparse.ArgumentParser(description="Codebase-health measurement.")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--diff", action="store_true", help="only files changed vs merge-base")
    ap.add_argument("--top", type=int, default=15, help="N worst functions to show")
    ap.add_argument("--paths", nargs="*", default=_DEFAULT_PATHS)
    ap.add_argument("--strict", action="store_true",
                    help="exit nonzero if a FAIL threshold is crossed")
    args = ap.parse_args()

    report = analyze(args.paths, args.diff, args.top)

    if args.json:
        payload = {
            "summary": {
                "files_scanned": report.files_scanned,
                "total_blocks": report.total_blocks,
                "avg_cc": report.avg_cc,
                "over_warn": len(report.blocks_over_warn),
                "over_fail": len(report.blocks_over_fail),
                "thresholds": {"cc_warn": _CC_WARN, "cc_fail": _CC_FAIL,
                               "loc_warn": _LOC_WARN, "mi_fail": _MI_FAIL},
            },
            "worst_blocks": [asdict(b) | {"grade": b.grade} for b in report.worst_blocks],
            "files_over_loc": [asdict(f) for f in report.files_over_loc],
            "files_low_mi": [asdict(f) for f in report.files_low_mi],
            "blocks_over_fail": [asdict(b) | {"grade": b.grade}
                                 for b in report.blocks_over_fail],
        }
        print(json.dumps(payload, indent=2))
    else:
        _print_human(report)

    if args.strict and report.blocks_over_fail:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
