"""Automation · assistant configuration — settings, knowledge base, writing-style
generation, learned-pattern listing, and the shared about-context loader."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException, Query, status
from gateway.routes.email.core import (
    _assert_account_owner,
    _get_db,
    _log,
    email_memory_scope,
    router,
)
from pydantic import BaseModel, Field
from sqlalchemy import text


async def _load_assistant_about(db: Any, account_id: str) -> tuple[str, str]:
    """Return (enriched_about, signature) for draft context.

    `enriched_about` bundles the user's About text with their personal
    instructions, writing style, and knowledge base as tagged blocks, so the
    single `about` string carries the full drafting context into both the LLM
    drafter and the MAF agent. Empty string if nothing is set.
    """
    row = (await db.execute(text(
        """SELECT about, signature, personal_instructions, writing_style,
                  learned_writing_style
           FROM email_assistant_settings WHERE account_id = :aid"""
    ), {"aid": account_id})).fetchone()
    about = (row.about if row else "") or ""
    signature = (row.signature if row else "") or ""
    personal = (getattr(row, "personal_instructions", None) or "") if row else ""
    style = (getattr(row, "writing_style", None) or "") if row else ""
    learned_style = (
        getattr(row, "learned_writing_style", None) or "") if row else ""

    kb_rows = (await db.execute(text(
        """SELECT title, content FROM email_knowledge
           WHERE account_id = :aid ORDER BY updated_at DESC LIMIT 20"""
    ), {"aid": account_id})).fetchall()

    parts: list[str] = []
    if about.strip():
        parts.append(f"<about>\n{about.strip()}\n</about>")
    if personal.strip():
        parts.append(
            "<personal_instructions>\n"
            f"{personal.strip()}\n</personal_instructions>"
        )
    if style.strip():
        parts.append(f"<writing_style>\n{style.strip()}\n</writing_style>")
    # Auto-derived from the user's draft edits — advisory, lower priority than an
    # explicit writing_style.
    if learned_style.strip():
        parts.append(
            "<learned_writing_style>\n"
            f"{learned_style.strip()}\n</learned_writing_style>"
        )
    if kb_rows:
        kb_text, budget = [], 4000
        for k in kb_rows:
            chunk = f"## {k.title}\n{(k.content or '').strip()}"
            if budget - len(chunk) < 0:
                break
            kb_text.append(chunk)
            budget -= len(chunk)
        if kb_text:
            parts.append(
                "<knowledge_base>\n" + "\n\n".join(kb_text) + "\n</knowledge_base>"
            )

    # GLOBAL patterns learned from how the user edits drafts (advisory, always
    # applicable). Scope-specific memories (sender/domain/topic) are injected
    # per-email via `_fetch_reply_memories` as <reply_memories> instead.
    lp_rows = (await db.execute(text(
        """SELECT pattern FROM email_learned_patterns
           WHERE account_id = :aid AND scope_type = 'GLOBAL'
           ORDER BY weight DESC, updated_at DESC LIMIT 12"""
    ), {"aid": account_id})).fetchall()
    if lp_rows:
        parts.append(
            "<learned_patterns>\n"
            + "\n".join(f"- {r.pattern}" for r in lp_rows)
            + "\n</learned_patterns>"
        )

    return "\n\n".join(parts), signature


# Per-task default tiers when no account preference is saved (or lookup fails).
_DEFAULT_TASK_MODELS = {
    "rule": "tier-fast",       # rule evaluation / classification / labeling
    "draft": "tier-powerful",  # draft writing
    "chat": "tier-powerful",   # email chat panel (strong tool-caller)
}


async def _account_models(db: Any, account_id: str) -> dict[str, str]:
    """The three task-specific models an account uses, as a dict with keys
    ``rule`` (rule evaluation/classification), ``draft`` (draft writing), and
    ``chat`` (the email chat panel).

    Each falls back to its per-task default (rule→tier-fast, draft→tier-powerful,
    chat→tier-powerful) so automation works before the user saves a preference
    or if the lookup fails."""
    out = dict(_DEFAULT_TASK_MODELS)
    if not account_id:
        return out
    try:
        row = (await db.execute(text(
            "SELECT rule_model, draft_model, chat_model "
            "FROM email_assistant_settings WHERE account_id = :aid"
        ), {"aid": account_id})).fetchone()
        if row:
            out["rule"] = (getattr(row, "rule_model", None) or out["rule"])
            out["draft"] = (getattr(row, "draft_model", None) or out["draft"])
            out["chat"] = (getattr(row, "chat_model", None) or out["chat"])
    except Exception as exc:  # noqa: BLE001 — fall back to the per-task defaults
        _log.warning("email.account_models_failed", error=str(exc)[:160])
    return out


class AssistantSettingsModel(BaseModel):
    account_id: str
    about: str | None = None
    signature: str | None = None
    # Global "Run rules automatically on new mail" switch (inbox-zero style).
    # Defaults ON; the scheduler treats a missing settings row as ON, so a fresh
    # account auto-runs once it has rules. An explicit OFF stops auto-run.
    auto_run: bool = True
    cold_email_blocker: str = "OFF"  # OFF | LABEL | ARCHIVE
    # Three task-specific models (tier-fast | tier-balanced | tier-powerful, or
    # any enabled model id). Rule evaluation / classification / labeling:
    rule_model: str = "tier-fast"
    # Draft writing (replies, follow-ups, rule DRAFT_EMAIL actions):
    draft_model: str = "tier-powerful"
    # The interactive email chat panel (strong tool-caller for reliability):
    chat_model: str = "tier-powerful"
    digest_frequency: str = "OFF"  # OFF | DAILY | WEEKLY
    personal_instructions: str | None = None
    writing_style: str | None = None
    # Auto-drafting defaults OFF, everywhere. Every draft is a call on the
    # drafting model (tier-powerful), written before anyone has decided the
    # email is worth answering — so it must be a switch the user turns ON, never
    # one they discover already running. Mirrors the backfill's opt-in
    # (RuleProcessPastRequest.draft_replies). Adds/removes DRAFT_EMAIL on the
    # Reply rule via sync_draft_reply_action.
    draft_replies: bool = False
    follow_up_days: int = 0  # legacy alias for follow_up_awaiting_days
    # inbox-zero parity (migration 29)
    draft_confidence: str = "ALL_EMAILS"  # ALL_EMAILS | STANDARD | HIGH_CONFIDENCE
    follow_up_awaiting_days: int = 0  # remind when THEY haven't replied after N days
    follow_up_needs_reply_days: int = 0  # remind when I haven't replied after N days
    # OFF by default for the same reason — and with a sharper edge: the scan had
    # been dead since it shipped (fixed in #84), so the first working run on a
    # long-configured account releases a nudge for every thread in the window at
    # once. Defaulting this ON meant that backlog would arrive as AI drafts.
    follow_up_auto_draft: bool = False
    digest_categories: list[str] = Field(default_factory=list)
    digest_day_of_week: int = 1  # 0=Sun … 6=Sat (used when WEEKLY)
    digest_time_of_day: str = "09:00"  # HH:MM, account-local
    digest_send_to_email: bool = True
    # inbox-zero parity (migration 30)
    multi_rule_execution: bool = False  # allow >1 rule to run on one email
    sensitive_data_protection: bool = True  # skip drafting on sensitive emails
    # Extra "your organisation" domains (migration 46). The account's own domain
    # is always internal; these are additional domains/aliases (multi-brand orgs)
    # whose mail also counts as outbound/internal for direction-aware
    # classification. Read-only ``own_domain`` is returned by GET for display.
    org_domains: list[str] = Field(default_factory=list)


@router.get("/assistant/settings")
async def get_assistant_settings(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """Get the assistant's About/signature/auto-run settings for an account."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        row = (await db.execute(text(
            """SELECT about, signature, auto_run, cold_email_blocker,
                      rule_model, draft_model, chat_model,
                      digest_frequency, personal_instructions, writing_style,
                      draft_replies, follow_up_days, draft_confidence,
                      follow_up_awaiting_days, follow_up_needs_reply_days,
                      follow_up_auto_draft, digest_categories, digest_day_of_week,
                      digest_time_of_day, digest_send_to_email,
                      multi_rule_execution, sensitive_data_protection,
                      org_domains
               FROM email_assistant_settings WHERE account_id = :aid"""
        ), {"aid": account_id})).fetchone()
        # The account's own email domain is ALWAYS treated as internal; surface
        # it (read-only) so the UI can show it as the always-included default.
        acc_row = (await db.execute(text(
            "SELECT email_address FROM email_accounts WHERE id = :aid"
        ), {"aid": account_id})).fetchone()
        from gateway.routes.email.automation.identity import _domain_of  # noqa: PLC0415
        own_domain = _domain_of(getattr(acc_row, "email_address", "") or "")
        awaiting = (getattr(row, "follow_up_awaiting_days", 0) if row else 0) or 0
        # Fall back to the legacy single field if the new column is still 0.
        if not awaiting and row:
            awaiting = getattr(row, "follow_up_days", 0) or 0
        return {
            "account_id": account_id,
            "about": row.about if row else "",
            "signature": row.signature if row else "",
            "auto_run": bool(row.auto_run) if row else True,
            "cold_email_blocker": (row.cold_email_blocker if row else "OFF") or "OFF",
            "rule_model": (getattr(row, "rule_model", None) if row else None)
            or "tier-fast",
            "draft_model": (getattr(row, "draft_model", None) if row else None)
            or "tier-powerful",
            # Default must match _DEFAULT_TASK_MODELS["chat"] and
            # AssistantSettingsModel.chat_model (tier-powerful — a strong
            # tool-caller). A divergent default here previously made the email
            # chat lock to tier-balanced while automation used tier-powerful.
            "chat_model": (getattr(row, "chat_model", None) if row else None)
            or "tier-powerful",
            "digest_frequency": (row.digest_frequency if row else "OFF") or "OFF",
            "personal_instructions": (
                getattr(row, "personal_instructions", None) if row else ""
            ) or "",
            "writing_style": (
                getattr(row, "writing_style", None) if row else ""
            ) or "",
            # Missing row / NULL column → OFF. This fallback IS the default for
            # every account that has never opened AI Settings, so it must agree
            # with AssistantSettingsModel.draft_replies or the toggle would read
            # ON while nothing had ever enabled it.
            "draft_replies": (
                bool(row.draft_replies) if row and row.draft_replies is not None
                else False
            ),
            "follow_up_days": awaiting,  # legacy alias
            "draft_confidence": (
                getattr(row, "draft_confidence", None) if row else None
            ) or "ALL_EMAILS",
            "follow_up_awaiting_days": awaiting,
            "follow_up_needs_reply_days": (
                getattr(row, "follow_up_needs_reply_days", 0) if row else 0
            ) or 0,
            "follow_up_auto_draft": (
                bool(row.follow_up_auto_draft)
                if row and getattr(row, "follow_up_auto_draft", None) is not None
                else False
            ),
            "digest_categories": (
                list(getattr(row, "digest_categories", None) or []) if row else []
            ),
            "digest_day_of_week": (
                getattr(row, "digest_day_of_week", 1) if row else 1
            ),
            "digest_time_of_day": (
                getattr(row, "digest_time_of_day", None) if row else None
            ) or "09:00",
            "digest_send_to_email": (
                bool(row.digest_send_to_email)
                if row and getattr(row, "digest_send_to_email", None) is not None
                else True
            ),
            "multi_rule_execution": (
                bool(row.multi_rule_execution)
                if row and getattr(row, "multi_rule_execution", None) is not None
                else False
            ),
            "sensitive_data_protection": (
                bool(row.sensitive_data_protection)
                if row and getattr(row, "sensitive_data_protection", None) is not None
                else True
            ),
            "org_domains": (
                list(getattr(row, "org_domains", None) or []) if row else []
            ),
            # Read-only: the account's own domain, always treated as internal.
            "own_domain": own_domain,
        }
    finally:
        await db.close()


@router.put("/assistant/settings")
async def put_assistant_settings(
    req: AssistantSettingsModel,
    user: UserContext = Depends(get_current_user),
):
    """Upsert the assistant settings for an account."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        # `follow_up_awaiting_days` is canonical; accept the legacy `follow_up_days`
        # as a fallback so older clients keep working.
        awaiting = req.follow_up_awaiting_days or req.follow_up_days or 0
        # Normalize + dedupe the extra org domains (the account's own domain is
        # always internal, so it never needs to be stored here).
        from gateway.routes.email.automation.identity import normalize_domain  # noqa: PLC0415
        org_domains = list(dict.fromkeys(
            nd for d in (req.org_domains or [])
            if isinstance(d, str) and (nd := normalize_domain(d))))
        await db.execute(text(
            """INSERT INTO email_assistant_settings
                 (account_id, about, signature, auto_run, cold_email_blocker,
                  rule_model, draft_model, chat_model, digest_frequency,
                  personal_instructions,
                  writing_style, draft_replies, follow_up_days, draft_confidence,
                  follow_up_awaiting_days, follow_up_needs_reply_days,
                  follow_up_auto_draft, digest_categories, digest_day_of_week,
                  digest_time_of_day, digest_send_to_email,
                  multi_rule_execution, sensitive_data_protection, org_domains,
                  updated_at)
               VALUES (:aid, :about, :sig, :auto, :cold, :rule_model,
                       :draft_model, :chat_model,
                       :digest,
                       :pi, :ws, :dr, :fu, :dc, :fua, :funr, :fuad, :dcat,
                       :ddow, :dtod, :dste, :mre, :sdp, :orgd, now())
               ON CONFLICT (account_id) DO UPDATE SET
                 about = EXCLUDED.about,
                 signature = EXCLUDED.signature,
                 auto_run = EXCLUDED.auto_run,
                 cold_email_blocker = EXCLUDED.cold_email_blocker,
                 rule_model = EXCLUDED.rule_model,
                 draft_model = EXCLUDED.draft_model,
                 chat_model = EXCLUDED.chat_model,
                 digest_frequency = EXCLUDED.digest_frequency,
                 personal_instructions = EXCLUDED.personal_instructions,
                 writing_style = EXCLUDED.writing_style,
                 draft_replies = EXCLUDED.draft_replies,
                 follow_up_days = EXCLUDED.follow_up_days,
                 draft_confidence = EXCLUDED.draft_confidence,
                 follow_up_awaiting_days = EXCLUDED.follow_up_awaiting_days,
                 follow_up_needs_reply_days = EXCLUDED.follow_up_needs_reply_days,
                 follow_up_auto_draft = EXCLUDED.follow_up_auto_draft,
                 digest_categories = EXCLUDED.digest_categories,
                 digest_day_of_week = EXCLUDED.digest_day_of_week,
                 digest_time_of_day = EXCLUDED.digest_time_of_day,
                 digest_send_to_email = EXCLUDED.digest_send_to_email,
                 multi_rule_execution = EXCLUDED.multi_rule_execution,
                 sensitive_data_protection = EXCLUDED.sensitive_data_protection,
                 org_domains = EXCLUDED.org_domains,
                 updated_at = now()"""
        ), {"aid": req.account_id, "about": req.about, "sig": req.signature,
            "auto": req.auto_run, "cold": req.cold_email_blocker or "OFF",
            "rule_model": req.rule_model or "tier-fast",
            "draft_model": req.draft_model or "tier-powerful",
            "chat_model": req.chat_model or "tier-powerful",
            "digest": req.digest_frequency or "OFF",
            "pi": req.personal_instructions, "ws": req.writing_style,
            "dr": req.draft_replies, "fu": awaiting,
            "dc": req.draft_confidence or "ALL_EMAILS",
            "fua": awaiting, "funr": req.follow_up_needs_reply_days or 0,
            "fuad": req.follow_up_auto_draft,
            "dcat": list(req.digest_categories or []),
            "ddow": req.digest_day_of_week,
            "dtod": req.digest_time_of_day or "09:00",
            "dste": req.digest_send_to_email,
            "mre": req.multi_rule_execution,
            "sdp": req.sensitive_data_protection,
            "orgd": org_domains})
        await db.commit()
        # inbox-zero parity: the "Auto draft replies" toggle adds/removes the
        # DRAFT_EMAIL action on the "Reply" rule (like inbox-zero's
        # enableDraftRepliesAction), so to-reply mail is auto-drafted when on.
        try:
            from gateway.routes.email.automation.rules import (  # noqa: PLC0415
                sync_draft_reply_action,
            )
            if await sync_draft_reply_action(db, req.account_id, req.draft_replies):
                await db.commit()
        except Exception as exc:  # noqa: BLE001 — settings already saved; best-effort
            _log.warning("email.draft_replies_sync_failed",
                         account_id=req.account_id, error=str(exc)[:200])
        acc_row = (await db.execute(text(
            "SELECT email_address FROM email_accounts WHERE id = :aid"
        ), {"aid": req.account_id})).fetchone()
        from gateway.routes.email.automation.identity import _domain_of  # noqa: PLC0415
        own_domain = _domain_of(getattr(acc_row, "email_address", "") or "")
        return {
            "account_id": req.account_id,
            "about": req.about or "",
            "signature": req.signature or "",
            "auto_run": req.auto_run,
            "cold_email_blocker": req.cold_email_blocker or "OFF",
            "rule_model": req.rule_model or "tier-fast",
            "draft_model": req.draft_model or "tier-powerful",
            "chat_model": req.chat_model or "tier-powerful",
            "digest_frequency": req.digest_frequency or "OFF",
            "personal_instructions": req.personal_instructions or "",
            "writing_style": req.writing_style or "",
            "draft_replies": req.draft_replies,
            "follow_up_days": awaiting,
            "draft_confidence": req.draft_confidence or "ALL_EMAILS",
            "follow_up_awaiting_days": awaiting,
            "follow_up_needs_reply_days": req.follow_up_needs_reply_days or 0,
            "follow_up_auto_draft": req.follow_up_auto_draft,
            "digest_categories": list(req.digest_categories or []),
            "digest_day_of_week": req.digest_day_of_week,
            "digest_time_of_day": req.digest_time_of_day or "09:00",
            "digest_send_to_email": req.digest_send_to_email,
            "multi_rule_execution": req.multi_rule_execution,
            "sensitive_data_protection": req.sensitive_data_protection,
            "org_domains": org_domains,
            "own_domain": own_domain,
        }
    finally:
        await db.close()


class KnowledgeModel(BaseModel):
    id: str | None = None
    account_id: str
    title: str
    content: str


@router.get("/knowledge")
async def list_knowledge(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """List the account's knowledge-base entries (used when drafting replies)."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        rows = (await db.execute(text(
            """SELECT id, title, content, updated_at FROM email_knowledge
               WHERE account_id = :aid ORDER BY updated_at DESC"""
        ), {"aid": account_id})).fetchall()
        return {"entries": [
            {"id": str(r.id), "account_id": account_id, "title": r.title,
             "content": r.content,
             "updated_at": r.updated_at.isoformat() if r.updated_at else None}
            for r in rows
        ]}
    finally:
        await db.close()


@router.post("/knowledge")
async def create_knowledge(
    req: KnowledgeModel,
    user: UserContext = Depends(get_current_user),
):
    """Add (or overwrite by title) a knowledge-base entry."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        kid = str(uuid4())
        await db.execute(text(
            """INSERT INTO email_knowledge (id, account_id, title, content)
               VALUES (:id, :aid, :title, :content)
               ON CONFLICT (account_id, title) DO UPDATE SET
                 content = EXCLUDED.content, updated_at = now()"""
        ), {"id": kid, "aid": req.account_id, "title": req.title,
            "content": req.content})
        await db.commit()
        return {"id": kid, "account_id": req.account_id, "title": req.title,
                "content": req.content}
    finally:
        await db.close()


@router.patch("/knowledge/{kid}")
async def update_knowledge(
    kid: str,
    req: KnowledgeModel,
    user: UserContext = Depends(get_current_user),
):
    """Edit a knowledge-base entry."""
    db = await _get_db()
    try:
        owner = (await db.execute(text(
            """SELECT ek.id FROM email_knowledge ek
               JOIN email_accounts ea ON ek.account_id = ea.id
               WHERE ek.id = :id AND ea.user_id = :uid"""
        ), {"id": kid, "uid": user.email or "anonymous"})).fetchone()
        if not owner:
            raise HTTPException(status_code=404, detail="Not found")
        await db.execute(text(
            """UPDATE email_knowledge SET title = :title, content = :content,
                      updated_at = now() WHERE id = :id"""
        ), {"id": kid, "title": req.title, "content": req.content})
        await db.commit()
        return {"id": kid, "account_id": req.account_id, "title": req.title,
                "content": req.content}
    finally:
        await db.close()


@router.delete("/knowledge/{kid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_knowledge(
    kid: str,
    user: UserContext = Depends(get_current_user),
):
    """Delete a knowledge-base entry."""
    db = await _get_db()
    try:
        res = await db.execute(text(
            """DELETE FROM email_knowledge ek USING email_accounts ea
               WHERE ek.id = :id AND ek.account_id = ea.id
                 AND ea.user_id = :uid"""
        ), {"id": kid, "uid": user.email or "anonymous"})
        await db.commit()
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Not found")
    finally:
        await db.close()


async def _llm_writing_style(samples: list[str]) -> str:
    """Summarize the user's writing style from sample sent emails.

    A generation task → runs on the powerful tier with the input fitted to the
    model's context window (acompletion_with_fallback handles keys + fitting)."""
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        joined = "\n\n---\n\n".join(samples)
        sys_prompt = (
            "Analyze the user's sent emails and describe their writing style as a "
            "short, reusable style guide (4-6 bullet points). Cover typical "
            "length, greeting/sign-off habits, formality, sentence style, and any "
            "distinctive traits. Phrase each point as an instruction a writer "
            "could follow, e.g. 'Keep replies to 2-3 short sentences.' Output ONLY "
            "the guide."
        )
        resp, _ = await acompletion_with_fallback(
            model="tier-powerful",
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": joined[:8000]}],
            temperature=0, max_tokens=1000,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.writing_style_failed", error=str(exc)[:200])
        return ""


@router.post("/assistant/writing-style/generate")
async def generate_writing_style(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """Derive a writing-style guide from the account's recent sent mail + save it."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        rows = (await db.execute(text(
            """SELECT body_text FROM email_messages
               WHERE account_id = :aid AND LOWER(folder) = 'sent'
               ORDER BY received_at DESC LIMIT 25"""
        ), {"aid": account_id})).fetchall()
        samples = [
            (r.body_text or "").strip()[:1200]
            for r in rows if (r.body_text or "").strip()
        ][:15]
        if not samples:
            raise HTTPException(
                status_code=400, detail="No sent emails to analyze yet.")
        style = await _llm_writing_style(samples)
        if not style:
            raise HTTPException(
                status_code=502, detail="Could not derive a writing style.")
        await db.execute(text(
            """INSERT INTO email_assistant_settings
                 (account_id, writing_style, updated_at)
               VALUES (:aid, :ws, now())
               ON CONFLICT (account_id) DO UPDATE SET
                 writing_style = EXCLUDED.writing_style, updated_at = now()"""
        ), {"aid": account_id, "ws": style})
        await db.commit()
        # Index the derived style into Mem0 — keyed PER ACCOUNT so a user's other
        # mailboxes don't inherit this inbox's writing voice (see
        # email_memory_scope). The drafter reads it back under the same scope.
        try:
            from acb_memory import add_memories_background  # noqa: PLC0415
            await add_memories_background(
                email_memory_scope(user.email or "default", account_id),
                [{"role": "assistant",
                  "content": f"My email writing style: {style}"}],
                agent_id="email",
            )
        except Exception:  # noqa: BLE001
            pass
        return {"writing_style": style}
    finally:
        await db.close()


@router.get("/learned-patterns")
async def list_learned_patterns(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """Preferences the assistant has learned from the user's draft edits."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        rows = (await db.execute(text(
            """SELECT id, pattern, weight, kind, scope_type, scope_value
               FROM email_learned_patterns
               WHERE account_id = :aid
               ORDER BY weight DESC, updated_at DESC"""
        ), {"aid": account_id})).fetchall()
        return {"patterns": [
            {"id": str(r.id), "pattern": r.pattern, "weight": r.weight,
             "kind": getattr(r, "kind", None),
             "scope_type": getattr(r, "scope_type", None),
             "scope_value": getattr(r, "scope_value", None)}
            for r in rows
        ]}
    finally:
        await db.close()


@router.delete("/learned-patterns/{pid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_learned_pattern(
    pid: str,
    user: UserContext = Depends(get_current_user),
):
    """Forget a learned preference."""
    db = await _get_db()
    try:
        res = await db.execute(text(
            """DELETE FROM email_learned_patterns lp USING email_accounts ea
               WHERE lp.id = :id AND lp.account_id = ea.id
                 AND ea.user_id = :uid"""
        ), {"id": pid, "uid": user.email or "anonymous"})
        await db.commit()
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Not found")
    finally:
        await db.close()
