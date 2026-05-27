"""Triage sub-agents (WBS 1.4): cheap, narrow classifiers that route raw
ingestion events to the right downstream agent."""
from orchestrator.triage.email import (
    RULE_CONFIDENCE_THRESHOLD,
    classify,
    classify_by_rules,
    classify_with_llm,
)
from orchestrator.triage.schema import EmailMessage, EmailTriageDecision, TriageLabel

__all__ = [
    "RULE_CONFIDENCE_THRESHOLD",
    "EmailMessage",
    "EmailTriageDecision",
    "TriageLabel",
    "classify",
    "classify_by_rules",
    "classify_with_llm",
]
