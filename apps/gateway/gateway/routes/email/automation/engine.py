"""Automation · rule matching engine — LLM + static + learned-pattern matching
that decides which rule(s) an email triggers (read-only; no side effects)."""

from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException
from gateway.routes.email.automation.rules import _load_rules
from gateway.routes.email.core import _log, _safe_json
from sqlalchemy import text


async def _llm_pick_rule(
    email: dict[str, str], rules: list[dict[str, Any]]
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
            "You are an email classifier. Given an email and a numbered list of "
            "rules, choose the single best-matching rule. Respond with ONLY a JSON "
            'object: {"index": <number or -1 if none match>, "reason": "<short why>"}.'
        )
        user_prompt = (
            f"EMAIL\nFrom: {email.get('from','')}\nSubject: {email.get('subject','')}\n"
            f"Body: {(email.get('body','') or '')[:1500]}\n\nRULES\n{rule_lines}"
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
    email: dict[str, str], rules: list[dict[str, Any]]
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
            "You are an email classifier. Given an email and a numbered list of "
            "rules, choose EVERY rule that genuinely applies to the email (there "
            "may be more than one, or none). Do not force a match. Respond with "
            'ONLY a JSON object: {"matches": [{"index": <number>, "reason": '
            '"<short why>"}]} — an empty list if none apply.'
        )
        user_prompt = (
            f"EMAIL\nFrom: {email.get('from','')}\nSubject: {email.get('subject','')}\n"
            f"Body: {(email.get('body','') or '')[:1500]}\n\nRULES\n{rule_lines}"
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
                    out.append({"index": idx, "reason": str(m.get("reason", ""))[:300]})
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


def _pattern_hit(pat: tuple[str, str], email: dict[str, str]) -> bool:
    """True if a learned pattern (type, value) matches the email (substring, ci)."""
    ptype, value = pat
    v = (value or "").strip().lower()
    if not v:
        return False
    if ptype == "SUBJECT":
        return v in (email.get("subject", "") or "").lower()
    return v in (email.get("from", "") or "").lower()  # FROM


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
            return {"rule": rule, "reason": "Matched a learned pattern."}

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
            return {"rule": rule, "reason": "Matched static conditions."}
        # No instructions and static didn't match → this rule doesn't apply.

    if instruction_rules:
        pick = await _llm_pick_rule(email, instruction_rules)
        if pick:
            return {"rule": instruction_rules[pick["index"]],
                    "reason": pick["reason"] or "Matched by AI."}
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

    def _add(rule: dict[str, Any], reason: str) -> None:
        rid = str(rule.get("id"))
        if rid in seen:
            return
        seen.add(rid)
        matches.append({"rule": rule, "reason": reason})

    # Learned INCLUDE patterns match immediately (and skip the LLM for that rule).
    for rule in rules:
        if str(rule.get("id")) in excluded:
            continue
        if _patterns_included_rule(rule, patterns, email):
            _add(rule, "Matched a learned pattern.")

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
            _add(rule, "Matched static conditions.")

    if instruction_rules:
        for pick in await _llm_pick_rules(email, instruction_rules):
            _add(instruction_rules[pick["index"]], pick["reason"] or "Matched by AI.")

    # Preserve rule sort order (rules already arrive ordered by sort_order).
    order = {str(r.get("id")): i for i, r in enumerate(rules)}
    matches.sort(key=lambda m: order.get(str(m["rule"].get("id")), 1_000))
    return matches


async def _email_payload_from_id(db: Any, message_id: str, user_email: str) -> dict[str, str]:
    row = (await db.execute(text(
        """SELECT em.subject, em.body_text, em.snippet, em.from_address, em.to_addresses
           FROM email_messages em JOIN email_accounts ea ON em.account_id = ea.id
           WHERE em.id = :mid AND ea.user_id = :uid"""
    ), {"mid": message_id, "uid": user_email})).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")
    frm = row.from_address if isinstance(row.from_address, dict) else json.loads(row.from_address or "{}")
    return {
        "subject": row.subject or "",
        "body": row.body_text or row.snippet or "",
        "from": frm.get("email", ""),
        "to": "",
    }
