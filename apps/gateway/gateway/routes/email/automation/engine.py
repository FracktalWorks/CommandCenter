"""Automation · rule matching engine — LLM + static + learned-pattern matching
that decides which rule(s) an email triggers (read-only; no side effects)."""

from __future__ import annotations

import json
import re
from typing import Any

from fastapi import HTTPException
from gateway.routes.email.automation.rules import _load_rules
from gateway.routes.email.core import _log, _safe_json
from sqlalchemy import text


def _fmt_recipients(field: Any) -> str:
    """A JSONB ``[{name, email}]`` recipient list → ``"Name <email>, …"`` for the
    classifier prompt. Empty string when there are none."""
    try:
        items = field if isinstance(field, list) else json.loads(field or "[]")
    except Exception:  # noqa: BLE001
        return ""
    out: list[str] = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        em, nm = (it.get("email") or "").strip(), (it.get("name") or "").strip()
        if em and nm:
            out.append(f"{nm} <{em}>")
        elif em or nm:
            out.append(em or nm)
    return ", ".join(out)


def email_dict_from_row(
    row: Any, self_email: str = "", about: str = "", self_name: str = "",
) -> dict[str, str]:
    """Build the classifier's email dict from an ``email_messages`` row.

    Mirrors the inputs inbox-zero feeds its rule AI: the recipient envelope
    (``to`` / ``cc``) + the account's own address/name (``self`` / ``self_name``)
    so it can tell direct-recipient from CC'd, the email ``date``, and the user's
    free-text ``about`` context (role / preferences) for relevance judgement."""
    raw_from = getattr(row, "from_address", None)
    frm = raw_from if isinstance(raw_from, dict) else json.loads(raw_from or "{}")
    received = getattr(row, "received_at", None)
    return {
        "subject": getattr(row, "subject", "") or "",
        "from": frm.get("email", ""),
        "body": getattr(row, "body_text", None) or getattr(row, "snippet", None) or "",
        "to": _fmt_recipients(getattr(row, "to_addresses", None)),
        "cc": _fmt_recipients(getattr(row, "cc_addresses", None)),
        "self": self_email or "",
        "self_name": self_name or "",
        "about": about or "",
        "date": received.isoformat() if hasattr(received, "isoformat") else "",
        "thread_id": getattr(row, "thread_id", "") or "",
    }


def _user_info_block(email: dict[str, str]) -> str:
    """Who the AI is acting for (inbox-zero's ``getUserInfoPrompt`` parity):
    the owner's email, name and free-text "about" context."""
    parts = []
    if email.get("self"):
        parts.append(f"  email: {email['self']}")
    if email.get("self_name"):
        parts.append(f"  name: {email['self_name']}")
    if (email.get("about") or "").strip():
        parts.append(f"  about: {email['about'].strip()[:1200]}")
    if not parts:
        return ""
    body = "\n".join(parts)
    return f"USER (you are acting on behalf of this person):\n{body}\n\n"


def _email_block(email: dict[str, str]) -> str:
    """Render the email envelope for the classifier prompt — including To/Cc, the
    date, and who "You" are, so recipient role (direct vs CC'd) is visible."""
    date_line = f"Date: {email['date']}\n" if email.get("date") else ""
    return (
        _user_info_block(email)
        + f"EMAIL\nFrom: {email.get('from', '')}\n"
        f"To: {email.get('to', '') or '(unknown)'}\n"
        f"Cc: {email.get('cc', '') or '(none)'}\n"
        + date_line
        + f"Subject: {email.get('subject', '')}\n"
        f"Body: {(email.get('body', '') or '')[:1500]}"
    )


_RECIPIENT_GUIDELINE = (
    "Consider whether the mailbox owner is a direct recipient (in To) or only "
    "CC'd: an email where they are merely CC'd is usually informational and does "
    "not require a reply from them."
)

# Classification guidance ported from inbox-zero's choose-rule system prompt, so
# our rule AI reasons the same way (specific over catch-all, honour excludes,
# more-specific wins, reply rules only when a response is genuinely needed).
_CLASSIFIER_GUIDELINES = (
    "Follow these guidelines: (1) Match the email to the most SPECIFIC rule that "
    "fits its content and purpose; when several could apply, prefer the more "
    "specific one. (2) If a rule says to exclude certain emails, do NOT pick it "
    "for those. (3) Prioritise reply-related rules only when the email clearly "
    "needs a response from the mailbox owner. " + _RECIPIENT_GUIDELINE + " "
    "(4) Use the USER context (their role and what they care about) to judge "
    "relevance, and only fall back to a catch-all rule when no specific rule fits."
)


async def _fetch_classification_hints(
    db: Any, account_id: str, sender_email: str, *, limit: int = 5,
) -> str:
    """How mail from this sender has been classified before — an ADVISORY hint
    for the classifier (inbox-zero's classificationFeedback), NOT a hard rule.
    Returns e.g. "Newsletter (x4), FYI (x1)" or "" when there's no history."""
    sender = (sender_email or "").strip().lower()
    if not sender:
        return ""
    try:
        rows = (await db.execute(text(
            """SELECT rule_name, COUNT(*) AS n
               FROM email_executed_rules
               WHERE account_id = :aid
                 AND rule_name IS NOT NULL
                 AND status NOT IN ('SKIPPED', 'REJECTED')
                 AND LOWER(COALESCE(from_address, '')) LIKE :pat
               GROUP BY rule_name ORDER BY n DESC LIMIT :lim"""
        ), {"aid": account_id, "pat": f"%{sender}%", "lim": limit})).fetchall()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.classification_hints_failed", error=str(exc)[:160])
        return ""
    return ", ".join(f"{r.rule_name} (x{r.n})" for r in rows if r.rule_name)


def _hint_block(hints: str) -> str:
    """Render the advisory classification-history hint for the prompt."""
    if not hints:
        return ""
    return (
        "\n\nCLASSIFICATION HISTORY (advisory only — still judge THIS email on "
        f"its own merits): mail from this sender was previously filed under: "
        f"{hints}."
    )


async def _llm_pick_rule(
    email: dict[str, str], rules: list[dict[str, Any]], hints: str = "",
) -> dict[str, Any] | None:
    """Ask the LLM which instruction-based rule matches the email.

    Returns {"index": int, "reason": str} (index into `rules`) or None.
    Fails closed (returns None) when the LLM is unavailable.
    """
    if not rules:
        return None
    try:
        import litellm as _litellm  # noqa: PLC0415
        from acb_llm.client import _TIER_MODEL, ensure_model_registered  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)

        rule_lines = "\n".join(
            f"{i}. {r['name']}: {r.get('instructions') or '(no description)'}"
            for i, r in enumerate(rules)
        )
        sys_prompt = (
            "You are an email classifier helping the user manage their inbox. "
            "Given an email and a numbered list of rules, choose the single "
            "best-matching rule. " + _CLASSIFIER_GUIDELINES
            + ' Respond with ONLY a JSON object: {"index": <number or -1 if none '
            'match>, "reason": "<short why>"}.'
        )
        user_prompt = (
            f"{_email_block(email)}\n\nRULES\n{rule_lines}{_hint_block(hints)}"
        )
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            temperature=0, max_tokens=300,
        )
        content = resp.choices[0].message.content or ""
        data = _safe_json(content)
        if isinstance(data, dict) and isinstance(data.get("index"), int):
            idx = data["index"]
            if 0 <= idx < len(rules):
                return {"index": idx, "reason": str(data.get("reason", ""))[:300]}
        return None
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.llm_pick_rule_failed", error=str(exc)[:200])
        return None


async def _llm_pick_rules(
    email: dict[str, str], rules: list[dict[str, Any]], hints: str = "",
) -> list[dict[str, Any]]:
    """Multi-rule selection (inbox-zero parity): ask the LLM for ALL instruction
    rules that apply to the email, not just the single best.

    Returns a list of {"index": int, "reason": str} (indexes into `rules`).
    Fails closed (returns []) when the LLM is unavailable.
    """
    if not rules:
        return []
    try:
        import litellm as _litellm  # noqa: PLC0415
        from acb_llm.client import _TIER_MODEL, ensure_model_registered  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)

        rule_lines = "\n".join(
            f"{i}. {r['name']}: {r.get('instructions') or '(no description)'}"
            for i, r in enumerate(rules)
        )
        sys_prompt = (
            "You are an email classifier helping the user manage their inbox. "
            "Given an email and a numbered list of rules, choose EVERY rule that "
            "genuinely applies to the email (there may be more than one, or none). "
            "Do not force a match. Mark exactly ONE match as the primary (the "
            "single most specific rule that best fits the email) with "
            '"primary": true. ' + _CLASSIFIER_GUIDELINES
            + ' Respond with ONLY a JSON object: {"matches": [{"index": <number>, '
            '"reason": "<short why>", "primary": <true|false>}]} — an empty list '
            "if none apply."
        )
        user_prompt = (
            f"{_email_block(email)}\n\nRULES\n{rule_lines}{_hint_block(hints)}"
        )
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            temperature=0, max_tokens=500,
        )
        content = resp.choices[0].message.content or ""
        data = _safe_json(content)
        out: list[dict[str, Any]] = []
        seen: set[int] = set()
        if isinstance(data, dict) and isinstance(data.get("matches"), list):
            for m in data["matches"]:
                if not isinstance(m, dict):
                    continue
                idx = m.get("index")
                if isinstance(idx, int) and 0 <= idx < len(rules) and idx not in seen:
                    seen.add(idx)
                    out.append({"index": idx,
                                "reason": str(m.get("reason", ""))[:300],
                                "primary": bool(m.get("primary"))})
        return out
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.llm_pick_rules_failed", error=str(exc)[:200])
        return []


def _static_match(rule: dict[str, Any], email: dict[str, str]) -> bool | None:
    """Evaluate a rule's static patterns. Returns None if the rule has none."""
    checks: list[bool] = []
    field_map = [
        ("from_pattern", email.get("from", "")),
        ("to_pattern", email.get("to", "")),
        ("subject_pattern", email.get("subject", "")),
        ("body_pattern", email.get("body", "")),
    ]
    for key, value in field_map:
        pat = rule.get(key)
        if pat:
            checks.append(pat.lower() in (value or "").lower())
    if not checks:
        return None
    return all(checks) if rule.get("conditional_operator", "AND") == "AND" else any(checks)


async def _load_rule_patterns(
    db: Any, account_id: str,
) -> dict[str, dict[str, list[tuple[str, str]]]]:
    """Learned classification patterns per rule (inbox-zero parity).

    Returns ``{rule_id: {"include": [(type, value), …], "exclude": […]}}``.
    Best-effort: returns {} if the table doesn't exist yet (pre-migration)."""
    try:
        rows = (await db.execute(text(
            "SELECT rule_id, pattern_type, value, exclude "
            "FROM email_rule_patterns WHERE account_id = :aid"
        ), {"aid": account_id})).fetchall()
    except Exception:  # noqa: BLE001
        return {}
    out: dict[str, dict[str, list[tuple[str, str]]]] = {}
    for r in rows:
        d = out.setdefault(str(r.rule_id), {"include": [], "exclude": []})
        d["exclude" if r.exclude else "include"].append((r.pattern_type, r.value))
    return out


def _generalize_subject(s: str) -> str:
    """Strip parenthesised content, numbers and IDs (inbox-zero's
    generalizeSubject) so a learned subject pattern matches across varying
    invoice / order / ticket numbers."""
    s = re.sub(r"\([^)]*\)", "", s or "")
    s = re.sub(r"(?:#\d+|\b\d+\b)", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _pattern_hit(pat: tuple[str, str], email: dict[str, str]) -> bool:
    """True if a learned pattern (type, value) matches the email — inbox-zero
    parity: FROM is a *bidirectional* case-insensitive substring; SUBJECT matches
    on raw substring OR with numbers/IDs generalised away."""
    ptype, value = pat
    v = (value or "").strip().lower()
    if not v:
        return False
    if ptype == "SUBJECT":
        subj = (email.get("subject", "") or "").lower()
        if v in subj:
            return True
        gv = _generalize_subject(v)
        return bool(gv) and gv in _generalize_subject(subj)
    frm = (email.get("from", "") or "").lower()  # FROM (bidirectional)
    return bool(frm) and (v in frm or frm in v)


def _patterns_excluded_rules(
    patterns: dict[str, dict[str, list[tuple[str, str]]]], email: dict[str, str],
) -> set[str]:
    """Rule ids whose learned EXCLUDE pattern matches this email — skip them."""
    return {
        rid for rid, p in patterns.items()
        if any(_pattern_hit(pt, email) for pt in p["exclude"])
    }


def _patterns_included_rule(
    rule: dict[str, Any],
    patterns: dict[str, dict[str, list[tuple[str, str]]]],
    email: dict[str, str],
) -> bool:
    """True if a learned INCLUDE pattern for this rule matches the email."""
    p = patterns.get(str(rule.get("id")))
    return bool(p and any(_pattern_hit(pt, email) for pt in p["include"]))


async def _match_email_to_rule(
    db: Any, account_id: str, email: dict[str, str]
) -> dict[str, Any] | None:
    """Return the first matching rule + reason, or None.

    Evaluation order per rule: static patterns (local) first, then NL
    instructions (one batched LLM call). Static-first keeps it cheap &
    deterministic.
    """
    rules = [r for r in await _load_rules(db, account_id) if r["enabled"]]
    if not rules:
        return None

    # Learned patterns (inbox-zero parity): an EXCLUDE pattern skips a rule
    # entirely; an INCLUDE pattern short-circuits to an immediate match (no LLM).
    patterns = await _load_rule_patterns(db, account_id)
    excluded = _patterns_excluded_rules(patterns, email)
    for rule in rules:
        if str(rule.get("id")) in excluded:
            continue
        if _patterns_included_rule(rule, patterns, email):
            return {"rule": rule, "reason": "Matched a learned pattern.",
                    "source": "pattern"}

    instruction_rules: list[dict[str, Any]] = []
    for rule in rules:
        if str(rule.get("id")) in excluded:
            continue
        sm = _static_match(rule, email)
        has_instr = bool((rule.get("instructions") or "").strip())
        if has_instr:
            # Static (if any) must not contradict; let the LLM decide.
            if sm is not False:
                instruction_rules.append(rule)
            continue
        if sm is True:
            return {"rule": rule, "reason": "Matched static conditions.",
                    "source": "static"}
        # No instructions and static didn't match → this rule doesn't apply.

    if instruction_rules:
        hints = await _fetch_classification_hints(db, account_id, email.get("from", ""))
        pick = await _llm_pick_rule(email, instruction_rules, hints=hints)
        if pick:
            return {"rule": instruction_rules[pick["index"]],
                    "reason": pick["reason"] or "Matched by AI.", "source": "ai"}
    return None


async def _match_email_to_rules_multi(
    db: Any, account_id: str, email: dict[str, str]
) -> list[dict[str, Any]]:
    """Multi-rule selection (inbox-zero parity): return ALL matching rules, not
    just the best one. Each item is {"rule": ..., "reason": ...}.

    Static matches are collected locally; the LLM is asked once for EVERY
    instruction rule that applies (via _llm_pick_rules). De-duped by id and
    returned in rule sort order.
    """
    rules = [r for r in await _load_rules(db, account_id) if r["enabled"]]
    if not rules:
        return []

    patterns = await _load_rule_patterns(db, account_id)
    excluded = _patterns_excluded_rules(patterns, email)

    matches: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _add(rule: dict[str, Any], reason: str, source: str,
             is_primary: bool = False) -> None:
        rid = str(rule.get("id"))
        if rid in seen:
            return
        seen.add(rid)
        matches.append({"rule": rule, "reason": reason, "source": source,
                        "is_primary": is_primary})

    # Learned INCLUDE patterns match immediately (and skip the LLM for that rule).
    for rule in rules:
        if str(rule.get("id")) in excluded:
            continue
        if _patterns_included_rule(rule, patterns, email):
            _add(rule, "Matched a learned pattern.", "pattern")

    instruction_rules: list[dict[str, Any]] = []
    for rule in rules:
        if str(rule.get("id")) in excluded or str(rule.get("id")) in seen:
            continue
        sm = _static_match(rule, email)
        has_instr = bool((rule.get("instructions") or "").strip())
        if has_instr:
            if sm is not False:
                instruction_rules.append(rule)
            continue
        if sm is True:
            _add(rule, "Matched static conditions.", "static")

    if instruction_rules:
        hints = await _fetch_classification_hints(db, account_id, email.get("from", ""))
        for pick in await _llm_pick_rules(email, instruction_rules, hints=hints):
            _add(instruction_rules[pick["index"]],
                 pick["reason"] or "Matched by AI.", "ai",
                 is_primary=bool(pick.get("primary")))

    # The LLM-chosen primary (most specific) leads; the rest follow in canonical
    # system order (rules arrive from _load_rules sorted that way — inbox-zero
    # parity, not a user priority).
    order = {str(r.get("id")): i for i, r in enumerate(rules)}
    matches.sort(key=lambda m: (0 if m.get("is_primary") else 1,
                                order.get(str(m["rule"].get("id")), 1_000)))
    return matches


async def _email_payload_from_id(db: Any, message_id: str, user_email: str) -> dict[str, str]:
    row = (await db.execute(text(
        """SELECT em.subject, em.body_text, em.snippet, em.from_address,
                  em.to_addresses, em.cc_addresses, em.thread_id, em.received_at,
                  ea.email_address
           FROM email_messages em JOIN email_accounts ea ON em.account_id = ea.id
           WHERE em.id = :mid AND ea.user_id = :uid"""
    ), {"mid": message_id, "uid": user_email})).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")
    return email_dict_from_row(row, getattr(row, "email_address", "") or "")
