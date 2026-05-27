"""Inspect AI evaluation scenarios for ACB skills (WBS 1.9.2).

Run:
    inspect eval evals/inspect/scenarios.py --model openai/tier1-local-qwen3

Each Task tests one skill behaviour and uses a graded scorer that checks:
  - Citation present ([kind:uuid] token)
  - Output within length limit
  - Severity correctness (reconciler escalation tasks)

Requires: pip install inspect-ai
"""
from __future__ import annotations

from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.scorer import Score, Target, accuracy, scorer
from inspect_ai.solver import generate


# ---------------------------------------------------------------------------
# Custom scorer: citation present
# ---------------------------------------------------------------------------

@scorer(metrics=[accuracy()])
def citation_present():
    """Pass if the model output contains at least one [kind:uuid] citation."""
    import re
    _RE = re.compile(r"\[[\w]+:[0-9a-f-]{36}\]")

    async def score(state, target: Target) -> Score:
        output = state.output.completion
        ok = bool(_RE.search(output))
        return Score(value=1 if ok else 0, explanation=f"citation={'found' if ok else 'missing'}")

    return score


@scorer(metrics=[accuracy()])
def severity_correct():
    """Pass if output contains the expected severity word."""

    async def score(state, target: Target) -> Score:
        output = state.output.completion.lower()
        expected = target.text.lower()
        ok = expected in output
        return Score(value=1 if ok else 0, explanation=f"expected '{expected}' in output")

    return score


@scorer(metrics=[accuracy()])
def length_ok(max_chars: int = 600):
    """Pass if output length is within max_chars."""

    async def score(state, target: Target) -> Score:
        n = len(state.output.completion)
        ok = n <= max_chars
        return Score(value=1 if ok else 0, explanation=f"len={n} limit={max_chars}")

    return score


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

@task
def stale_task_nudge_eval():
    """stale_task_nudge: output <= 280 chars + citation."""
    return Task(
        dataset=[
            Sample(input="Task ID: 00000000-0000-0000-0000-000000000001, days_in_stage=14"),
            Sample(input="Task ID: 00000000-0000-0000-0000-000000000002, days_in_stage=50"),
        ],
        solver=generate(),
        scorer=[citation_present(), length_ok(max_chars=280)],
    )


@task
def quiet_deal_followup_eval():
    """quiet_deal_followup: output <= 280 chars + citation."""
    return Task(
        dataset=[
            Sample(input="Deal ID: 00000000-0000-0000-0000-000000000040, days_quiet=21"),
            Sample(input="Deal ID: 00000000-0000-0000-0000-000000000041, days_quiet=7"),
        ],
        solver=generate(),
        scorer=[citation_present(), length_ok(max_chars=280)],
    )


@task
def stale_task_escalation_eval():
    """stale_task_escalation: severity correct + citation."""
    return Task(
        dataset=[
            Sample(input="Task 00000000-0000-0000-0000-000000000070 days=14", target="low"),
            Sample(input="Task 00000000-0000-0000-0000-000000000071 days=60", target="high"),
            Sample(input="Task 00000000-0000-0000-0000-000000000072 days=30", target="medium"),
        ],
        solver=generate(),
        scorer=[citation_present(), severity_correct()],
    )


@task
def quiet_deal_escalation_eval():
    """quiet_deal_escalation: severity correct + citation."""
    return Task(
        dataset=[
            Sample(input="Deal 00000000-0000-0000-0000-000000000080 days=10", target="low"),
            Sample(input="Deal 00000000-0000-0000-0000-000000000081 days=50", target="high"),
        ],
        solver=generate(),
        scorer=[citation_present(), severity_correct()],
    )


@task
def email_classify_eval():
    """email_classify: JSON output + valid label."""
    import json
    import re
    _LABELS = {"sales_lead", "sales_followup", "delivery_issue", "hr_query",
                "finance", "internal", "spam", "unknown"}

    @scorer(metrics=[accuracy()])
    def label_valid():
        async def score(state, target: Target) -> Score:
            try:
                obj = json.loads(state.output.completion)
                ok = obj.get("label") in _LABELS
            except Exception:
                ok = False
            return Score(value=1 if ok else 0)
        return score

    return Task(
        dataset=[
            Sample(input="Email ID: 00000000-0000-0000-0000-000000000050"),
            Sample(input="Email ID: 00000000-0000-0000-0000-000000000051"),
        ],
        solver=generate(),
        scorer=[label_valid()],
    )