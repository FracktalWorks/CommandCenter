"""Automation · AI drafting — reply generation via the MAF agent/LLM, writing-
style + learned-edit capture, and the draft/save endpoints."""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import BackgroundTasks, Depends, HTTPException
from gateway.routes.email.automation.assistant import (
    _account_models,
    _load_assistant_about,
)
from gateway.routes.email.core import (
    _assert_account_owner,
    _get_db,
    _instantiate_provider,
    _log,
    _persist_rotated_creds,
    _provider_for_account,
    _provider_for_message,
    _row_to_message,
    _safe_json,
    router,
)
from pydantic import BaseModel
from sqlalchemy import text


def _normalize_text(s: str) -> str:
    return " ".join((s or "").split()).lower()


# ── Drafting context budgets ─────────────────────────────────────────────────
# Generous UPPER BOUNDS only. The LLM layer (acompletion_with_fallback →
# fit_messages_to_context) already trims the prompt to the model's real context
# window (the draft model defaults to tier-powerful ≈ 200k input tokens), keeping
# a head + tail around a marker. So we pass the FULL incoming email + thread and
# let that layer fit — instead of pre-truncating here. The old tight caps (the
# message being replied to was cut to [:2000] chars) made a long email reach the
# model as just its opening lines, so drafts read "only the introductory lines
# came through" / "the communication appears to be truncated". These bounds are a
# safety net against pathological multi-MB bodies, not the normal limiter.
_DRAFT_BODY_MAX_CHARS = 100_000     # the message being replied to (~25k tokens)
_DRAFT_THREAD_MAX_CHARS = 60_000    # the whole prior thread, joined (~15k tokens)
_THREAD_MSG_MAX_CHARS = 12_000      # per earlier message in the thread
_THREAD_MSG_LIMIT = 20              # how many earlier messages to include


async def _fetch_thread_context(
    db: Any, account_id: str, thread_id: str,
    exclude_provider_msg_id: str = "", *, limit: int = _THREAD_MSG_LIMIT,
) -> str:
    """Earlier messages in the conversation (oldest → newest), formatted for the
    drafter so it can reply with full thread context — inbox-zero passes the
    whole thread to its reply AI; without this we'd only see the latest message.

    Excludes drafts and the message currently being replied to. Returns '' when
    there's no prior context (e.g. a brand-new single-message thread)."""
    if not thread_id:
        return ""
    try:
        rows = (await db.execute(text(
            """SELECT from_address, body_text, snippet, received_at,
                      provider_message_id, folder
               FROM email_messages
               WHERE account_id = :aid AND thread_id = :tid
                 AND LOWER(COALESCE(folder, '')) NOT IN ('drafts', 'draft')
               ORDER BY received_at ASC NULLS FIRST
               LIMIT :lim"""
        ), {"aid": account_id, "tid": thread_id, "lim": limit})).fetchall()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.thread_context_failed", error=str(exc)[:160])
        return ""
    parts: list[str] = []
    for r in rows:
        if exclude_provider_msg_id and r.provider_message_id == exclude_provider_msg_id:
            continue
        body = (r.body_text or r.snippet or "").strip()
        if not body:
            continue
        frm = r.from_address if isinstance(r.from_address, dict) \
            else json.loads(r.from_address or "{}")
        sender = frm.get("name") or frm.get("email") or "?"
        when = r.received_at.isoformat() if hasattr(r.received_at, "isoformat") else ""
        header = f"From: {sender}" + (f" · {when}" if when else "")
        parts.append(f"{header}\n{body[:_THREAD_MSG_MAX_CHARS]}")
    return "\n\n---\n\n".join(parts)


async def _fetch_sender_reply_examples(
    db: Any, account_id: str, sender_email: str, *, limit: int = 3,
) -> str:
    """The owner's recent replies SENT to this sender — past examples the drafter
    can mirror for tone, brevity and relationship (inbox-zero's
    <sender_reply_examples>). Empty when there's no sent history to them."""
    sender_email = (sender_email or "").strip().lower()
    if not sender_email:
        return ""
    try:
        rows = (await db.execute(text(
            """SELECT body_text, snippet
               FROM email_messages
               WHERE account_id = :aid AND LOWER(COALESCE(folder, '')) = 'sent'
                 AND LOWER(to_addresses::text) LIKE :pat
               ORDER BY received_at DESC NULLS LAST
               LIMIT :lim"""
        ), {"aid": account_id, "pat": f"%{sender_email}%", "lim": limit})).fetchall()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.sender_examples_failed", error=str(exc)[:160])
        return ""
    parts: list[str] = []
    for r in rows:
        body = (r.body_text or r.snippet or "").strip()
        if body:
            parts.append(body[:800])
    return "\n\n---\n\n".join(parts)


async def _fetch_reply_memories(
    db: Any, account_id: str, email: dict[str, str], *, limit: int = 6,
) -> str:
    """Scope-matched reply memories (SENDER/DOMAIN/TOPIC) for the email being
    drafted — inbox-zero's <reply_memories>, prioritised SENDER > DOMAIN > TOPIC.
    GLOBAL memories are injected separately via the enriched `about`."""
    sender = (email.get("from") or "").strip().lower()
    domain = sender.split("@")[-1] if "@" in sender else ""
    content = f"{email.get('subject', '')} {email.get('body', '')}".lower()[:2000]
    try:
        rows = (await db.execute(text(
            """SELECT pattern, kind, scope_type,
                      CASE scope_type WHEN 'SENDER' THEN 3 WHEN 'DOMAIN' THEN 2
                                      WHEN 'TOPIC' THEN 1 ELSE 0 END AS prio
               FROM email_learned_patterns
               WHERE account_id = :aid AND (
                     (scope_type = 'SENDER' AND scope_value = :sender)
                  OR (scope_type = 'DOMAIN' AND scope_value = :domain
                      AND :domain <> '')
                  OR (scope_type = 'TOPIC' AND scope_value <> ''
                      AND :content LIKE '%' || scope_value || '%')
               )
               ORDER BY prio DESC, weight DESC, updated_at DESC
               LIMIT :lim"""
        ), {"aid": account_id, "sender": sender, "domain": domain,
            "content": content, "lim": limit})).fetchall()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.reply_memories_failed", error=str(exc)[:160])
        return ""
    return "\n".join(f"- [{r.kind}/{r.scope_type}] {r.pattern}" for r in rows)


async def _cleanup_thread_drafts(account_id: str, thread_id: str) -> None:
    """Trash any drafts left in a thread (upstream + local) after a reply is sent
    — e.g. an AI DRAFT_EMAIL draft a rule created (which the user never sent
    because they composed their own reply), or a Gmail-style auto-save that wasn't
    the one consumed by the send. Best-effort background task."""
    if not thread_id:
        return
    db = await _get_db()
    try:
        rows = (await db.execute(text(
            "SELECT id, provider_message_id FROM email_messages "
            "WHERE account_id = :aid AND thread_id = :tid "
            "AND LOWER(COALESCE(folder, '')) IN ('drafts', 'draft')"
        ), {"aid": account_id, "tid": thread_id})).fetchall()
        if not rows:
            return
        acc = (await db.execute(text(
            "SELECT provider, credentials_encrypted FROM email_accounts "
            "WHERE id = :id"
        ), {"id": account_id})).fetchone()
        if not acc:
            return
        from acb_llm.key_store import get_key_store  # noqa: PLC0415
        store = get_key_store()
        creds = json.loads(store.decrypt(acc.credentials_encrypted))
        provider = _instantiate_provider(acc.provider, creds)
        if not await provider.authenticate():
            return
        for r in rows:
            try:
                await provider.trash_message(r.provider_message_id)
            except Exception:  # noqa: BLE001 — one stuck draft shouldn't abort
                pass
            await db.execute(text(
                "DELETE FROM email_messages WHERE id = :id"), {"id": r.id})
        if provider.credentials_dirty():
            await _persist_rotated_creds(db, store, account_id, provider)
        await db.commit()
        _log.info("email.thread_drafts_cleaned",
                  account_id=account_id, count=len(rows))
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.cleanup_thread_drafts_failed", error=str(exc)[:160])
    finally:
        await db.close()


async def _resolve_existing_thread_draft(
    db: Any, provider: Any, account_id: str, thread_id: str,
) -> str:
    """Decide what to do about an existing AI draft before auto-drafting again —
    a port of inbox-zero's handlePreviousDraftDeletion (at most ONE AI draft per
    thread; never clobber the user's edits, never pile up duplicates). Returns:

      "none"    — no draft in the thread → create one.
      "replace" — a prior AI draft existed UNMODIFIED; trashed it → create fresh
                  (so it picks up the latest thread context).
      "keep"    — the user edited the draft (or there's no original to compare
                  against) → preserve it; the caller must NOT create another.

    Unmodified is judged by comparing the live draft mirror against the original
    AI text stored in ``email_ai_drafts`` (the same sync that delivers the new
    inbound message also refreshes the draft mirror, so it is current). Best-effort
    — returns "none" on any error so drafting still proceeds."""
    if not thread_id or not account_id:
        return "none"
    try:
        row = (await db.execute(text(
            "SELECT id, provider_message_id, body_text FROM email_messages "
            "WHERE account_id = :aid AND thread_id = :tid "
            "AND LOWER(COALESCE(folder, '')) IN ('drafts', 'draft') "
            "ORDER BY updated_at DESC NULLS LAST, received_at DESC LIMIT 1"
        ), {"aid": account_id, "tid": thread_id})).fetchone()
        if not row:
            return "none"
        orig = (await db.execute(text(
            "SELECT draft_text FROM email_ai_drafts "
            "WHERE account_id = :aid AND thread_id = :tid"
        ), {"aid": account_id, "tid": thread_id})).fetchone()
        original = (orig.draft_text if orig else "") or ""
        if original and _normalize_text(row.body_text or "") == \
                _normalize_text(original):
            try:
                await provider.trash_message(row.provider_message_id)
            except Exception:  # noqa: BLE001 — a stuck draft shouldn't abort
                pass
            await db.execute(text(
                "DELETE FROM email_messages WHERE id = :id"), {"id": row.id})
            return "replace"
        return "keep"  # user-edited (or unknown) → preserve, don't duplicate
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.resolve_existing_draft_failed", error=str(exc)[:160])
        return "none"


async def _store_ai_draft(
    db: Any, account_id: str, thread_id: str, draft_text: str
) -> None:
    """Remember the assistant's original draft for a thread, so we can later
    learn from how the user edits it before sending."""
    if not account_id or not thread_id or not (draft_text or "").strip():
        return
    try:
        await db.execute(text(
            """INSERT INTO email_ai_drafts (account_id, thread_id, draft_text)
               VALUES (:aid, :tid, :txt)
               ON CONFLICT (account_id, thread_id) DO UPDATE SET
                 draft_text = EXCLUDED.draft_text, created_at = now()"""
        ), {"aid": account_id, "tid": thread_id, "txt": draft_text})
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.store_ai_draft_failed", error=str(exc)[:160])


_PUBLIC_EMAIL_DOMAINS = frozenset({
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
    "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me",
    "protonmail.com", "gmx.com", "mail.com", "msn.com",
})


async def _llm_extract_reply_memories(
    incoming: str, draft: str, sent: str,
) -> list[dict[str, str]]:
    """Extract 0-3 durable, reusable reply memories from how the user changed the
    assistant's draft, each tagged with a KIND (FACT/PROCEDURE/PREFERENCE) and a
    SCOPE (SENDER/DOMAIN/TOPIC/GLOBAL) — inbox-zero's scoped reply memories.

    Returns [{content, kind, scope, topic}]; empty when nothing generalizable.
    """
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        sys_prompt = (
            "You learn how a user likes their email replies written by comparing "
            "the assistant's DRAFT with what the user actually SENT (the INCOMING "
            "email is given for context). Extract 0-3 DURABLE, REUSABLE memories; "
            "ignore one-off facts specific to THIS email. For each, give:\n"
            "- content: a short instruction or fact (e.g. 'Keep sign-offs to my "
            "first name', 'I am the CTO', 'Attach the pricing PDF for demos').\n"
            "- kind: FACT (a stable fact about the user/their work), PROCEDURE "
            "(a how-to/step they follow), or PREFERENCE (tone/length/style).\n"
            "- scope: SENDER (specific to this correspondent), DOMAIN (their "
            "company), TOPIC (a recurring subject), or GLOBAL (all replies).\n"
            "- topic: a 1-3 word keyword, ONLY when scope is TOPIC.\n"
            'Respond with ONLY JSON: {"memories": [{"content","kind","scope",'
            '"topic"}]} — an empty list if nothing is generalizable.'
        )
        user = (
            f"INCOMING:\n{incoming[:1500]}\n\nDRAFT:\n{draft[:2000]}\n\n"
            f"SENT:\n{sent[:2000]}"
        )
        resp, _ = await acompletion_with_fallback(
            model="tier-powerful",
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user}],
            temperature=0, max_tokens=1000,
            response_format={"type": "json_object"},
        )
        data = _safe_json(resp.choices[0].message.content or "")
        items = data.get("memories") if isinstance(data, dict) else None
        out: list[dict[str, str]] = []
        for m in (items or [])[:3]:
            if not isinstance(m, dict):
                continue
            content = (m.get("content") or "").strip()
            if not content:
                continue
            kind = (m.get("kind") or "PREFERENCE").upper()
            if kind not in ("FACT", "PROCEDURE", "PREFERENCE"):
                kind = "PREFERENCE"
            scope = (m.get("scope") or "GLOBAL").upper()
            if scope not in ("SENDER", "DOMAIN", "TOPIC", "GLOBAL"):
                scope = "GLOBAL"
            out.append({
                "content": content[:240], "kind": kind, "scope": scope,
                "topic": (m.get("topic") or "").strip().lower()[:60],
            })
        return out
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.extract_memories_failed", error=str(exc)[:160])
        return []


def _resolve_memory_scope(
    scope: str, topic: str, sender_email: str, domain: str,
) -> tuple[str, str]:
    """Map an extracted scope to a concrete (scope_type, scope_value), demoting
    scopes that have no usable target (e.g. a public mailbox domain) to SENDER or
    GLOBAL so the memory stays retrievable."""
    if scope == "SENDER":
        return ("SENDER", sender_email) if sender_email else ("GLOBAL", "")
    if scope == "DOMAIN":
        if domain and domain not in _PUBLIC_EMAIL_DOMAINS:
            return ("DOMAIN", domain)
        return ("SENDER", sender_email) if sender_email else ("GLOBAL", "")
    if scope == "TOPIC":
        return ("TOPIC", topic) if topic else ("GLOBAL", "")
    return ("GLOBAL", "")


async def _learn_from_sent(account_id: str, thread_id: str, sent_text: str) -> None:
    """Background: if the user edited the assistant's draft for this thread,
    extract scoped reply memories (sender/domain/topic/global) and store them
    (best-effort)."""
    if not thread_id or not (sent_text or "").strip():
        return
    db = await _get_db()
    try:
        row = (await db.execute(text(
            "SELECT draft_text FROM email_ai_drafts "
            "WHERE account_id = :aid AND thread_id = :tid"
        ), {"aid": account_id, "tid": thread_id})).fetchone()
        if not row:
            return
        original = row.draft_text or ""
        await db.execute(text(
            "DELETE FROM email_ai_drafts "
            "WHERE account_id = :aid AND thread_id = :tid"
        ), {"aid": account_id, "tid": thread_id})
        await db.commit()
        if not original.strip() or \
                _normalize_text(original) == _normalize_text(sent_text):
            return  # unchanged → nothing to learn

        # Sender + incoming content, to scope the extracted memories.
        inb = (await db.execute(text(
            """SELECT from_address, body_text, snippet FROM email_messages
               WHERE account_id = :aid AND thread_id = :tid
                 AND LOWER(COALESCE(folder, '')) <> 'sent'
               ORDER BY received_at DESC NULLS LAST LIMIT 1"""
        ), {"aid": account_id, "tid": thread_id})).fetchone()
        sender_email, incoming = "", ""
        if inb:
            frm = inb.from_address if isinstance(inb.from_address, dict) \
                else json.loads(inb.from_address or "{}")
            sender_email = (frm.get("email") or "").strip().lower()
            incoming = inb.body_text or inb.snippet or ""
        domain = sender_email.split("@")[-1] if "@" in sender_email else ""

        memories = await _llm_extract_reply_memories(incoming, original, sent_text)
        if not memories:
            return
        stored: list[str] = []
        for m in memories:
            scope_type, scope_value = _resolve_memory_scope(
                m["scope"], m["topic"], sender_email, domain)
            await db.execute(text(
                """INSERT INTO email_learned_patterns
                     (account_id, pattern, kind, scope_type, scope_value,
                      is_style_evidence)
                   VALUES (:aid, :p, :k, :st, :sv, :ev)
                   ON CONFLICT (account_id, kind, scope_type, scope_value, pattern)
                   DO UPDATE SET weight = email_learned_patterns.weight + 1,
                                 updated_at = now()"""
            ), {"aid": account_id, "p": m["content"], "k": m["kind"],
                "st": scope_type, "sv": scope_value,
                "ev": m["kind"] == "PREFERENCE"})
            stored.append(m["content"])
        await db.commit()
        _log.info("email.learned_memories", account_id=account_id,
                  count=len(stored))
        # Also remember the strongest memory in Mem0 (keyed by the account owner)
        # so it surfaces during future drafting retrieval, not just this table.
        try:
            urow = (await db.execute(text(
                "SELECT user_id FROM email_accounts WHERE id = :aid"
            ), {"aid": account_id})).fetchone()
            uid = (urow.user_id if urow else None) or "default"
            from acb_memory import add_memories_background  # noqa: PLC0415
            await add_memories_background(
                uid,
                [{"role": "assistant",
                  "content": f"Email reply preference: {stored[0]}"}],
                agent_id="email",
            )
        except Exception:  # noqa: BLE001
            pass
        # Regenerate the learned writing style once enough new evidence accrued.
        await _maybe_refresh_learned_style(db, account_id)
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.learn_from_sent_failed", error=str(exc)[:160])
    finally:
        await db.close()


_MIN_STYLE_EVIDENCE = 5
_STYLE_REFRESH_EVERY = 5


async def _llm_summarize_writing_style(prefs: list[str]) -> str:
    """Distil accumulated reply preferences into a concise writing-style guide
    (inbox-zero's aiSummarizeLearnedWritingStyle)."""
    if not prefs:
        return ""
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        sys_prompt = (
            "You distil a user's email writing style from preferences observed in "
            "how they edit the assistant's drafts. Output 3-6 short, concrete "
            "bullet guidelines (tone, length, greeting/sign-off, formatting, what "
            "to include or omit). No preamble — just the bullet lines."
        )
        resp, _ = await acompletion_with_fallback(
            model="tier-powerful",
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": "Preferences:\n"
                       + "\n".join(f"- {p}" for p in prefs[:25])}],
            temperature=0.2, max_tokens=1000,
        )
        return (resp.choices[0].message.content or "").strip()[:1500]
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.summarize_style_failed", error=str(exc)[:160])
        return ""


async def _maybe_refresh_learned_style(db: Any, account_id: str) -> None:
    """Regenerate the learned writing style once enough new PREFERENCE evidence
    has accumulated since the last refresh (inbox-zero parity)."""
    try:
        cnt = (await db.execute(text(
            "SELECT COUNT(*) AS n FROM email_learned_patterns "
            "WHERE account_id = :aid AND is_style_evidence = true"
        ), {"aid": account_id})).fetchone()
        cur = int(cnt.n) if cnt else 0
        if cur == 0:
            return
        srow = (await db.execute(text(
            "SELECT learned_writing_style, learned_style_evidence_count "
            "FROM email_assistant_settings WHERE account_id = :aid"
        ), {"aid": account_id})).fetchone()
        have_style = bool(srow and (srow.learned_writing_style or "").strip())
        last = int(getattr(srow, "learned_style_evidence_count", 0) or 0) if srow else 0
        need = ((not have_style and cur >= _MIN_STYLE_EVIDENCE)
                or (cur - last >= _STYLE_REFRESH_EVERY))
        if not need:
            return
        prefs = [r.pattern for r in (await db.execute(text(
            "SELECT pattern FROM email_learned_patterns "
            "WHERE account_id = :aid AND is_style_evidence = true "
            "ORDER BY weight DESC, updated_at DESC LIMIT 25"
        ), {"aid": account_id})).fetchall() if r.pattern]
        style = await _llm_summarize_writing_style(prefs)
        if not style:
            return
        await db.execute(text(
            "UPDATE email_assistant_settings SET learned_writing_style = :s, "
            "learned_style_evidence_count = :c, updated_at = now() "
            "WHERE account_id = :aid"
        ), {"s": style, "c": cur, "aid": account_id})
        await db.commit()
        _log.info("email.learned_style_refreshed",
                  account_id=account_id, evidence=cur)
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.refresh_style_failed", error=str(exc)[:160])


async def _llm_draft_reply(
    email: dict[str, str], about: str, signature: str,
    instructions: str = "", context: str = "", user_email: str = "",
    *, model: str = "tier-powerful",
) -> str:
    """Draft a reply body with the LLM, using the user's About context plus any
    extra `context` gathered from memory / specialist agents.

    Runs on the account's draft-writing ``model`` (default the powerful tier)
    with the prompt fitted to its context window. A confidence gate may make the
    model return the NO_DRAFT sentinel, which is propagated to the caller.

    Falls back to a neutral template if the LLM is unavailable.
    """
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        # A configured signature is appended after the body, so the model must not
        # add its own closing/sign-off (mirrors inbox-zero's drafter).
        sig_rule = (
            "Do NOT add any closing, sign-off, name, title, or signature block — a "
            "signature is appended automatically."
            if (signature or "").strip()
            else "You do not need to sign off with the user's name; a simple close "
            "(e.g. 'Best regards,') is fine, but NEVER invent a name or leave a "
            "placeholder."
        )
        sys_prompt = (
            "You are an expert assistant that drafts email replies on behalf of "
            "the account owner, replying to the person who sent the email below. "
            "Rules:\n"
            "- Write a properly-formatted email reply. START with a greeting on "
            "its own line that addresses the RECIPIENT by name — 'Dear <name>,' "
            "for a formal thread or 'Hi <first name>,' for a casual one (match "
            "the thread's tone; use a polite 'Hello,' if no name is known). Then "
            "a blank line, then the message in clear, short paragraphs. No "
            "subject line, and NEVER narrate what you are doing (no \"here is a "
            "draft you can use\" or apologies).\n"
            "- You are the account owner writing the reply; you are NOT the "
            "sender. Greet and address the RECIPIENT (the sender of the email "
            "below) — never greet or address the account owner by name.\n"
            "- Do not mention you are an AI or reference these instructions.\n"
            "- Do not simply repeat the sender's content back — respond to it.\n"
            "- Plain text only (markdown links allowed); separate paragraphs with "
            "blank lines; match the language of the email; be clear and "
            "professional, not a single terse line.\n"
            "- Ground every fact in the email or the supplied context and never "
            "invent specifics — if something is missing, keep it open or ask.\n"
            "- Never use placeholders for names (e.g. [Your Name], [Name]). "
            f"{sig_rule}\n"
            "- If the context contains <personal_instructions>, follow them. If "
            "it contains <writing_style>, match that tone, length, and phrasing "
            "(an explicit <writing_style> outranks <learned_writing_style>, which "
            "is auto-derived and advisory). If it contains a <knowledge_base>, "
            "use it for facts only where relevant. If it contains "
            "<learned_patterns> or <reply_memories>, treat them as advisory "
            "preferences/facts from the user's past edits and apply the ones that "
            "fit."
        )
        owner = f"You are drafting as: {user_email}\n" if user_email else ""
        ctx = f"{owner}User context:\n{about}\n\n" if (about or owner) else ""
        if context:
            ctx += f"Context gathered for this reply:\n{context}\n\n"
        thread = (email.get("thread") or "").strip()
        thread_block = (
            "Earlier in this thread (oldest to newest) — read it for full "
            f"context before replying:\n{thread[:_DRAFT_THREAD_MAX_CHARS]}\n\n"
            if thread else ""
        )
        examples = (email.get("sender_examples") or "").strip()
        examples_block = (
            "Past replies you (the owner) have sent to this sender — mirror their "
            "tone, brevity and directness; do NOT reuse their specific facts:\n"
            f"{examples[:2500]}\n\n" if examples else ""
        )
        memories = (email.get("reply_memories") or "").strip()
        memories_block = (
            "Learned reply memories relevant to this sender/topic (advisory — "
            "apply the ones that fit; explicit instructions still win):\n"
            f"{memories[:2000]}\n\n" if memories else ""
        )
        today = datetime.now(timezone.utc).strftime("%A, %d %B %Y")
        user_prompt = (
            f"{ctx}Today is {today}.\n"
            "Draft a reply to this email (it was sent TO the account owner; "
            "write the owner's reply back to the sender).\n"
            "Reply to — greet this recipient by name: "
            f"{email.get('from_name') or email.get('from', '')} "
            f"<{email.get('from', '')}>\n"
            f"Subject: {email.get('subject', '')}\n\n"
            f"{memories_block}"
            f"{examples_block}"
            f"{thread_block}"
            "Latest message — reply to THIS, taking the thread above into "
            f"account:\n{(email.get('body', '') or '')[:_DRAFT_BODY_MAX_CHARS]}\n"
        )
        if instructions:
            user_prompt += f"\nExtra instructions: {instructions}\n"
        _messages = [{"role": "system", "content": sys_prompt},
                     {"role": "user", "content": user_prompt}]
        # Generous output budget — a full reply body (greeting + paragraphs +
        # context) must never be truncated mid-sentence.
        resp, _used = await acompletion_with_fallback(
            model=model,
            messages=_messages, temperature=0.3, max_tokens=3000,
        )
        body = _clean_draft_body((resp.choices[0].message.content or "").strip())
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.llm_draft_failed", error=str(exc)[:200])
        body = "Hi,\n\nThanks for your email — I'll review this and get back to you shortly."
    # Confidence gate: when the drafter declined (or returned nothing), return the
    # CANONICAL sentinel with no signature, so every consumer detects it uniformly
    # via _is_no_draft and exact-equality history logging stays consistent.
    if _is_no_draft(body):
        return DRAFT_NO_DRAFT_SENTINEL
    # Sign a real draft (the signature is appended, not generated by the model).
    if (signature or "").strip() and signature.strip() not in body:
        body = f"{body}\n\n{signature.strip()}"
    return body


async def _llm_compose_assist(
    *, about: str, signature: str, current_body: str, instruction: str,
    mode: str, recipient: str = "", subject: str = "", thread: str = "",
    user_email: str = "", model: str = "tier-powerful",
) -> str:
    """Draft OR improve an outgoing email body for the compose box.

    Unlike ``_llm_draft_reply`` (which always writes a fresh reply to an inbound
    message), this works on the OWNER'S OWN text: when ``current_body`` is set it
    polishes that draft in place; when it's empty it drafts from the instruction
    and context. The trailing quoted conversation is NEVER passed in (the client
    strips it) — ``thread`` is supplied for context only and must not be quoted.

    Returns the NO_DRAFT sentinel if the model declines; otherwise the body with
    the configured signature appended.
    """
    improving = bool((current_body or "").strip())
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        sig_rule = (
            "Do NOT add any closing, sign-off, name, title, or signature block — a "
            "signature is appended automatically."
            if (signature or "").strip()
            else "You do not need to sign off with the user's name; a simple close "
            "(e.g. 'Best regards,') is fine, but NEVER invent a name or leave a "
            "placeholder."
        )
        mode_rule = (
            "- IMPROVE the owner's existing draft (given below): preserve their "
            "intent, facts, names, commitments and any concrete details; fix "
            "clarity, structure, grammar and tone. Do NOT invent new facts, add "
            "new asks, or change the meaning.\n"
            if improving
            else "- DRAFT a new email body from the owner's instruction and "
            "context. Ground every fact in the instruction/context; never invent "
            "specifics — if something is missing, keep it open or ask.\n"
        )
        sys_prompt = (
            "You help the account owner write and refine THEIR OWN outgoing email. "
            "Rules:\n"
            "- Output ONLY the email body the owner will send — no subject line, no "
            "quoted prior conversation, and never narrate what you are doing (no "
            "\"here is a draft\" or apologies).\n"
            "- Write in the owner's first-person voice. Never greet or address the "
            "owner by name; if a greeting fits, address the RECIPIENT.\n"
            f"{mode_rule}"
            "- Plain text only (markdown links allowed); separate paragraphs with "
            "blank lines; match the language of the draft/thread; be clear and "
            "professional, not a single terse line.\n"
            "- Never use placeholders for names (e.g. [Your Name], [Name]). "
            f"{sig_rule}\n"
            "- If the context contains <personal_instructions> or <writing_style>, "
            "follow them. The prior thread (if any) is context ONLY — do not quote, "
            "restate, or reply to it line by line."
        )
        owner = f"You are writing as: {user_email}\n" if user_email else ""
        ctx = f"{owner}User context:\n{about}\n\n" if (about or owner) else ""
        today = datetime.now(timezone.utc).strftime("%A, %d %B %Y")
        parts = [ctx, f"Today is {today}.\n"]
        if mode in ("reply", "forward") and recipient:
            verb = "reply" if mode == "reply" else "forward"
            parts.append(f"This email is a {verb}. Recipient: {recipient}\n")
        elif recipient:
            parts.append(f"Recipient: {recipient}\n")
        if subject:
            parts.append(f"Subject: {subject}\n")
        if thread:
            parts.append(
                "\nPrior conversation for context only (do NOT quote it):\n"
                f"{thread[:_DRAFT_THREAD_MAX_CHARS]}\n"
            )
        if improving:
            parts.append(
                "\nThe owner's current draft — improve THIS, keeping their "
                f"meaning:\n{current_body[:_DRAFT_BODY_MAX_CHARS]}\n"
            )
        guide = (instruction or "").strip()
        if guide:
            parts.append(f"\nThe owner's instruction: {guide}\n")
        elif not improving:
            parts.append(
                "\nThe owner's instruction: Draft a suitable, well-structured "
                "email for the recipient and subject above.\n"
            )
        user_prompt = "".join(parts)
        _messages = [{"role": "system", "content": sys_prompt},
                     {"role": "user", "content": user_prompt}]
        resp, _used = await acompletion_with_fallback(
            model=model,
            messages=_messages, temperature=0.3, max_tokens=3000,
        )
        body = _clean_draft_body((resp.choices[0].message.content or "").strip())
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.compose_assist_failed", error=str(exc)[:200])
        # Fall back to the owner's own text (improve) or a neutral opener (draft).
        return (current_body or "").strip() or DRAFT_NO_DRAFT_SENTINEL
    if _is_no_draft(body):
        return DRAFT_NO_DRAFT_SENTINEL
    if (signature or "").strip() and signature.strip() not in body:
        body = f"{body}\n\n{signature.strip()}"
    return body


async def _draft_consult_plan(email: dict[str, str]) -> list[dict[str, str]]:
    """Decide which specialist agents (if any) could improve this reply.

    Returns [{"agent": "agent-sales-assistant"|"task-manager", "question": "..."}], capped at 2.
    """
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        sys_prompt = (
            "You plan how to draft an email reply. Decide which internal specialist "
            "agents, if any, would provide context that materially improves the "
            "reply. Available agents:\n"
            "- agent-sales-assistant: CRM, deals, pipeline, quotes, customer/account status (Zoho).\n"
            "- task-manager: projects, tasks, deadlines, delivery status (ClickUp).\n"
            "Only include an agent when the email clearly relates to its domain. "
            'Respond ONLY JSON: {"consult": [{"agent": "<name>", "question": '
            '"<specific question to ask that agent>"}]} (empty list if none).'
        )
        user_prompt = (
            f"From: {email.get('from', '')}\nSubject: {email.get('subject', '')}\n"
            f"Body:\n{(email.get('body', '') or '')[:1500]}"
        )
        # A fast routing decision; JSON-forced so the plan is always parseable.
        resp, _ = await acompletion_with_fallback(
            model="tier-fast",
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            temperature=0, max_tokens=500,
            response_format={"type": "json_object"},
        )
        data = _safe_json(resp.choices[0].message.content or "")
        consult = data.get("consult", []) if isinstance(data, dict) else []
        out = []
        for c in consult:
            if isinstance(c, dict) and c.get("agent") in ("agent-sales-assistant", "task-manager") \
                    and c.get("question"):
                out.append({"agent": c["agent"], "question": str(c["question"])})
        return out[:2]
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.draft_plan_failed", error=str(exc)[:200])
        return []


def _strip_draft_markers(text: str) -> str:
    """Remove any standalone '---' fence lines the agent may wrap a draft in."""
    lines = [ln for ln in (text or "").splitlines() if ln.strip() != "---"]
    return "\n".join(lines).strip()


_PLACEHOLDER_LINE_RE = re.compile(
    r"^\s*[\[\(]\s*(your\s+|the\s+)?"
    r"(name|full\s*name|first\s*name|position|title|role|company|signature|"
    r"sender|recipient)\s*[\]\)]\s*$",
    re.IGNORECASE,
)


def _clean_draft_body(body: str) -> str:
    """Strip placeholder-only lines (e.g. "[Your Name]") from a drafted reply so
    they never reach the user's mailbox. The configured signature is appended
    separately by the caller."""
    kept = [
        ln for ln in (body or "").splitlines()
        if not _PLACEHOLDER_LINE_RE.match(ln)
    ]
    # Collapse the trailing blank run left behind by a removed placeholder.
    return "\n".join(kept).strip()


async def _draft_via_maf_agent(
    email: dict[str, str], about: str, signature: str, user_email: str,
    *, instructions: str = "",
) -> str | None:
    """Draft by running the email-assistant MAF agent (which can hand off to
    agent-sales-assistant / task-manager and read memory). Returns None on any failure so the
    caller can fall back to the in-gateway orchestrator."""
    try:
        from acb_skills.memory_tools import _set_memory_user_id  # noqa: PLC0415
        _set_memory_user_id(user_email or "")
    except Exception:  # noqa: BLE001
        pass
    try:
        from orchestrator.executor import run_agent  # noqa: PLC0415
        task = instructions or (
            "Draft a reply to the email below. First gather context: use "
            "remember() for the sender, and call_agent('agent-sales-assistant' or 'task-manager') "
            "ONLY if the email is clearly about a deal or a project."
        )
        thread = (email.get("thread") or "").strip()
        thread_block = (
            "\nEarlier in this thread (oldest to newest):\n"
            f"{thread[:_DRAFT_THREAD_MAX_CHARS]}\n"
            if thread else ""
        )
        msg = (
            f"{task} Then write ONLY the message body — no subject line, no "
            "preamble, no '---' fences, no confidence line.\n\n"
            f"From: {email.get('from', '')}\nSubject: {email.get('subject', '')}\n"
            f"{thread_block}"
            "Latest message (reply to this):\n"
            f"{(email.get('body', '') or '')[:_DRAFT_BODY_MAX_CHARS]}"
        )
        res = await asyncio.wait_for(
            run_agent(
                "email-assistant",
                {"message": msg, "about": about, "signature": signature,
                 "user_email": user_email},
            ),
            timeout=150.0,
        )
        ans = ""
        if isinstance(res, dict):
            ans = res.get("answer") or ""
            if not ans and isinstance(res.get("result"), dict):
                ans = res["result"].get("content") or ""
            if not ans and isinstance(res.get("result"), str):
                ans = res["result"]
        ans = _strip_draft_markers(ans)
        if ans:
            if signature.strip() and signature.strip() not in ans:
                ans = f"{ans}\n\n{signature}"
            return ans
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.maf_draft_failed", error=str(exc)[:200])
    return None


_FOLLOW_UP_INSTRUCTION = (
    "This is my OWN earlier email that hasn't received a reply yet. Write a "
    "brief, polite follow-up that nudges for a response — keep it short, "
    "reference the original subject, and do NOT repeat the full original message."
)


DRAFT_NO_DRAFT_SENTINEL = "NO_DRAFT"

# The drafter is told to emit DRAFT_NO_DRAFT_SENTINEL ("NO_DRAFT") and nothing
# else when a confidence gate fires. Models don't always comply exactly — they
# wrap it in markdown (_NO_DRAFT_, **NO_DRAFT**), quotes, the spaced "NO DRAFT"
# form, a markdown-escaped underscore ("NO\\_DRAFT"), or trailing punctuation.
# Match the WHOLE body (fullmatch) so a real greeting-led reply can NEVER be
# mistaken for a decline, while tolerating those wrappers. (Design + edge cases
# adversarially verified — zero false positives on real drafts.)
_NO_DRAFT_RE = re.compile(
    r'''[\s"'`*_>~()\[\]{}.,:;!?\\-]*no\\?[_\s-]?draft[\s"'`*_>~()\[\]{}.,:;!?\\-]*''',
    re.IGNORECASE,
)


def _is_no_draft(body: str) -> bool:
    """True when the drafter declined to write a reply (confidence gate): an empty
    body, or the NO_DRAFT sentinel — tolerant of case, wrapping quotes/markdown,
    the spaced "NO DRAFT" form, and trailing punctuation, but matched against the
    ENTIRE body so a genuine (greeting-led, multi-line) reply never matches."""
    t = (body or "").strip()
    return not t or bool(_NO_DRAFT_RE.fullmatch(t))


# Granular confidence rubric ported from inbox-zero's drafter, so the NO_DRAFT
# gate reasons about *why* a draft is/ isn't trustworthy, not just "unsure".
_CONFIDENCE_RUBRIC = (
    "Judge your confidence in the draft: HIGH = complete and fully grounded — "
    "every fact comes from the email/thread/context, with no reliance on missing "
    "facts, assumptions, unavailable business or calendar state, or details only "
    "the user can fill in. MEDIUM = a useful reply that leans on reasonable "
    "assumptions or a few user-fillable details. LOW = highly uncertain, needs "
    "broader context, or would mostly just ask/check/follow up."
)

_CONFIDENCE_INSTRUCTIONS = {
    "STANDARD": (
        _CONFIDENCE_RUBRIC + " Draft only when your confidence is MEDIUM or "
        "higher. If it would be LOW (you don't clearly understand the email, or a "
        "reply isn't appropriate), output exactly "
        f"{DRAFT_NO_DRAFT_SENTINEL} and nothing else."
    ),
    "HIGH_CONFIDENCE": (
        _CONFIDENCE_RUBRIC + " Draft ONLY when your confidence is HIGH — a "
        "complete, accurate, fully-grounded reply. At MEDIUM or LOW (any doubt, "
        "missing facts, or assumptions), output exactly "
        f"{DRAFT_NO_DRAFT_SENTINEL} and nothing else."
    ),
}


async def _agent_draft_reply(
    email: dict[str, str], about: str, signature: str, user_email: str,
    *, use_agent: bool = False, max_agents: int = 2, agent_timeout: float = 90.0,
    follow_up: bool = False, confidence: str = "ALL_EMAILS",
    model: str = "tier-powerful",
) -> str:
    """Draft a reply (or a follow-up nudge). When ``use_agent`` is set (background
    rule actions), run the email-assistant MAF agent first; otherwise — and on any
    agent failure — use the fast in-gateway orchestrator.

    ``confidence`` (ALL_EMAILS | STANDARD | HIGH_CONFIDENCE) gates drafting: the
    higher tiers instruct the drafter to return the NO_DRAFT sentinel when it
    isn't confident, which the caller treats as "skip this draft".

    ``model`` is the account's draft-writing model (default the powerful tier)."""
    instructions = _FOLLOW_UP_INSTRUCTION if follow_up else ""
    conf_note = _CONFIDENCE_INSTRUCTIONS.get(confidence or "ALL_EMAILS", "")
    if conf_note:
        instructions = (instructions + "\n" + conf_note).strip()
    # NOTE: we deliberately do NOT use the conversational email-assistant MAF
    # agent to write the draft body — it narrated its work ("I'm sorry, here's a
    # draft you can use:"), greeted the wrong person, and left [Your Name]
    # placeholders in the body. The focused orchestrating drafter gathers the
    # same memory/specialist context and produces a clean reply via
    # _llm_draft_reply. (`use_agent` is kept for call-site compatibility.)
    _ = use_agent
    return await _orchestrate_draft(
        email, about, signature, user_email,
        max_agents=max_agents, agent_timeout=agent_timeout,
        instructions=instructions, model=model,
    )


async def _orchestrate_draft(
    email: dict[str, str], about: str, signature: str, user_email: str,
    *, max_agents: int = 2, agent_timeout: float = 90.0, instructions: str = "",
    model: str = "tier-powerful",
) -> str:
    """In-gateway orchestrating drafter: gather context from memory + specialist
    agents (sales / task-manager), then draft. Best-effort; degrades to an
    About-only draft."""
    context_parts: list[str] = []

    # 1) Memory: what do we know about this sender / relationship?
    try:
        from acb_skills.memory_tools import (  # noqa: PLC0415
            _set_memory_user_id,
            remember,
        )
        _set_memory_user_id(user_email or "")
        mem = await remember(
            f"past context, agreements, and preferences relevant to "
            f"{email.get('from', '')} and: {email.get('subject', '')}"
        )
        if mem and "no relevant" not in mem.lower():
            context_parts.append(f"From memory:\n{mem[:1500]}")
        # Precedent: semantically similar past emails (any sender) and how the
        # account handled them — inbox-zero's <email_history> advisory context.
        precedent = await remember(
            f"similar past emails about '{email.get('subject', '')}' and how "
            f"they were handled or replied to: "
            f"{(email.get('body', '') or '')[:200]}"
        )
        if (precedent and "no relevant" not in precedent.lower()
                and precedent.strip() != (mem or "").strip()):
            context_parts.append(
                "Similar past emails (precedent — advisory, the current thread "
                f"still wins):\n{precedent[:1200]}")
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.draft_memory_failed", error=str(exc)[:160])

    # 2) Specialist agents: delegate via the orchestrator's run_agent.
    plan = await _draft_consult_plan(email)
    if plan:
        try:
            from orchestrator.executor import run_agent  # noqa: PLC0415
            for item in plan[:max_agents]:
                try:
                    res = await asyncio.wait_for(
                        run_agent(
                            item["agent"],
                            {"message": item["question"], "user_email": user_email},
                        ),
                        timeout=agent_timeout,
                    )
                    ans = ""
                    if isinstance(res, dict):
                        ans = str(res.get("answer") or res.get("result") or "")
                    if ans.strip():
                        context_parts.append(
                            f"From the {item['agent']} agent "
                            f"(asked: {item['question']}):\n{ans[:1500]}"
                        )
                except Exception as exc:  # noqa: BLE001
                    _log.warning("email.draft_agent_failed",
                                 agent=item.get("agent"), error=str(exc)[:160])
        except Exception as exc:  # noqa: BLE001
            _log.warning("email.draft_orchestrator_unavailable", error=str(exc)[:160])

    draft = await _llm_draft_reply(
        email, about, signature, instructions=instructions,
        context="\n\n".join(context_parts), user_email=user_email,
        model=model,
    )

    # 3) Record this exchange in Mem0 (episodic, pgvector) so future drafts to
    # this correspondent have context. Use add_memories_background — NOT
    # add_episode, which targets Graphiti/Neo4j (disabled → silent no-op).
    try:
        from acb_memory import add_memories_background  # noqa: PLC0415
        await add_memories_background(
            user_email or "default",
            [
                {"role": "user",
                 "content": (
                     f"Email from {email.get('from', '')} — subject "
                     f"'{email.get('subject', '')}': "
                     f"{(email.get('body', '') or '')[:600]}"
                 )},
                {"role": "assistant",
                 "content": f"I replied: {draft[:600]}"},
            ],
            agent_id="email",
        )
    except Exception:  # noqa: BLE001
        pass

    return draft


class DraftReplyRequest(BaseModel):
    account_id: str
    message_id: str
    create_draft: bool = False  # also save a provider draft (lands in Drafts)
    follow_up: bool = False  # draft a nudge for my own unanswered email instead


@router.post("/draft-reply")
async def draft_reply_smart(
    req: DraftReplyRequest,
    user: UserContext = Depends(get_current_user),
):
    """Draft a context-aware reply with the orchestrating drafter (memory +
    sales/task-manager). Returns the draft text; optionally also creates a
    provider draft in the user's Drafts."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        row = (await db.execute(text(
            """SELECT em.provider_message_id, em.thread_id, em.subject,
                      em.body_text, em.snippet, em.from_address
               FROM email_messages em
               WHERE em.id = :mid AND em.account_id = :aid"""
        ), {"mid": req.message_id, "aid": req.account_id})).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")
        frm = row.from_address if isinstance(row.from_address, dict) \
            else json.loads(row.from_address or "{}")
        email = {
            "subject": row.subject or "", "from": frm.get("email", ""),
            "from_name": frm.get("name", "") or "",
            "body": row.body_text or row.snippet or "",
            "thread_id": row.thread_id or "",
            "thread": await _fetch_thread_context(
                db, req.account_id, row.thread_id or "",
                row.provider_message_id or ""),
            "sender_examples": await _fetch_sender_reply_examples(
                db, req.account_id, frm.get("email", "")),
        }
        email["reply_memories"] = await _fetch_reply_memories(
            db, req.account_id, email)
        about, signature = await _load_assistant_about(db, req.account_id)
        models = await _account_models(db, req.account_id)
        # Synchronous request → keep the orchestration budget under the proxy
        # timeout (one specialist agent, short timeout).
        draft = await _agent_draft_reply(
            email, about, signature, user.email or "",
            max_agents=1, agent_timeout=18.0, follow_up=req.follow_up,
            model=models["draft"],
        )

        # Confidence gate (defense-in-depth): if the drafter declined, never
        # persist or surface a literal "NO_DRAFT" body. (Sync requests default to
        # ALL_EMAILS so this rarely fires, but keeps the gate consistent.)
        if _is_no_draft(draft):
            return {"draft": "", "created": False, "skipped": "low_confidence"}

        # Remember this draft so we can learn from the user's edits on send.
        if not req.follow_up:
            await _store_ai_draft(db, req.account_id, email["thread_id"], draft)

        created = False
        if req.create_draft:
            try:
                provider, pmid, account_id, store = await _provider_for_message(
                    db, req.message_id, user.email or "anonymous"
                )
                if await provider.authenticate():
                    re_subject = (
                        email["subject"]
                        if email["subject"].lower().startswith("re:")
                        else f"Re: {email['subject']}"
                    )
                    provider_id = await provider.create_draft(
                        to=[email["from"]],
                        subject=re_subject,
                        body_text=draft,
                        reply_to_message_id=pmid,
                        thread_id=email["thread_id"] or None,
                    )
                    # Mirror locally so it shows in Drafts + in-thread at once.
                    await _upsert_local_draft(
                        db, account_id, provider_id,
                        thread_id=email["thread_id"] or None,
                        owner_email=user.email or "", to_email=email["from"],
                        subject=re_subject, body=draft,
                    )
                    await _persist_rotated_creds(db, store, account_id, provider)
                    await db.commit()
                    created = True
            except Exception as exc:  # noqa: BLE001
                _log.warning("email.draft_reply_create_failed", error=str(exc)[:160])

        return {"draft": draft, "created": created}
    finally:
        await db.close()


class ComposeAssistRequest(BaseModel):
    account_id: str
    # The current NEW body the user has typed (the quoted trailing chain is
    # stripped client-side, so the model never rewrites the quote). Empty = draft
    # from scratch; non-empty = improve this text in place.
    body: str = ""
    instruction: str = ""           # optional guidance ("make it shorter", …)
    mode: str = "new"               # "new" | "reply" | "forward"
    message_id: str | None = None   # reply/forward: pulls thread context
    to: list[str] | None = None     # new email: recipient(s) for context
    subject: str = ""


@router.post("/compose-assist")
async def compose_assist(
    req: ComposeAssistRequest,
    user: UserContext = Depends(get_current_user),
):
    """Draft or improve the body the user is composing. Operates ONLY on the new
    text (the client strips the quoted trailing email first); for a reply/forward
    the original thread is loaded as context but never quoted back. Returns the
    drafted/improved body."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        about, signature = await _load_assistant_about(db, req.account_id)
        models = await _account_models(db, req.account_id)
        recipient = ""
        subject = req.subject or ""
        thread = ""
        if req.message_id:
            row = (await db.execute(text(
                """SELECT provider_message_id, thread_id, subject, from_address
                   FROM email_messages
                   WHERE id = :mid AND account_id = :aid"""
            ), {"mid": req.message_id, "aid": req.account_id})).fetchone()
            if row:
                # For a reply, the recipient is the message's sender. For a
                # forward, the recipient is whoever the user is forwarding TO
                # (req.to) — NOT the original sender — so only derive it here for
                # replies; the thread/subject are loaded for context either way.
                if req.mode != "forward":
                    frm = row.from_address if isinstance(row.from_address, dict) \
                        else json.loads(row.from_address or "{}")
                    nm, addr = frm.get("name", "") or "", frm.get("email", "") or ""
                    recipient = (f"{nm} <{addr}>" if nm else addr).strip()
                subject = subject or (row.subject or "")
                thread = await _fetch_thread_context(
                    db, req.account_id, row.thread_id or "",
                    row.provider_message_id or "")
        if not recipient and req.to:
            recipient = ", ".join([a for a in req.to if a])

        draft = await _llm_compose_assist(
            about=about, signature=signature, current_body=req.body,
            instruction=req.instruction, mode=req.mode, recipient=recipient,
            subject=subject, thread=thread, user_email=user.email or "",
            model=models["draft"],
        )
        if _is_no_draft(draft):
            return {"draft": "", "skipped": "low_confidence"}
        return {"draft": draft}
    finally:
        await db.close()


async def _upsert_local_draft(
    db: Any, account_id: str, provider_message_id: str, *,
    thread_id: str | None, owner_email: str, to_email: str,
    subject: str, body: str,
) -> str:
    """Persist a just-created/updated provider draft into ``email_messages`` so it
    shows in the Drafts folder and in-thread immediately — without waiting for the
    next provider sweep. Keyed on ``(account_id, provider_message_id)`` so that
    later Drafts sync updates this same row instead of duplicating it. Returns the
    local message id."""
    res = await db.execute(text(
        """INSERT INTO email_messages
             (id, account_id, provider_message_id, thread_id, folder,
              from_address, to_addresses, subject, body_text, snippet,
              is_read, is_starred, is_flagged, received_at, synced_at)
           VALUES (:id, :aid, :pmid, :tid, 'drafts',
              :from_addr, :to_addrs, :subject, :body, :snippet,
              true, false, false, now(), now())
           ON CONFLICT (account_id, provider_message_id) DO UPDATE SET
             thread_id = COALESCE(EXCLUDED.thread_id, email_messages.thread_id),
             to_addresses = EXCLUDED.to_addresses,
             subject = EXCLUDED.subject,
             body_text = EXCLUDED.body_text,
             snippet = EXCLUDED.snippet,
             folder = 'drafts',
             updated_at = now()
           RETURNING id"""
    ), {
        "id": str(uuid4()), "aid": account_id, "pmid": provider_message_id,
        "tid": thread_id or None,
        "from_addr": json.dumps({"name": "", "email": owner_email or ""}),
        "to_addrs": json.dumps(
            [{"name": "", "email": to_email}] if to_email else []),
        "subject": subject or "", "body": body or "",
        "snippet": (body or "")[:200],
    })
    rid = res.fetchone()
    return str(rid.id) if rid else ""


async def _fetch_message_dict(db: Any, message_id: str) -> dict[str, Any]:
    """Return one stored message in the API (snake_case) shape, or {}."""
    row = (await db.execute(text(
        """SELECT em.id, em.provider_message_id, em.thread_id, em.account_id,
                  em.folder, em.labels, em.from_address, em.to_addresses,
                  em.cc_addresses, em.bcc_addresses, em.subject, em.body_text,
                  em.body_html, em.snippet, em.has_attachments, em.is_read,
                  em.is_starred, em.is_flagged, em.importance, em.categories,
                  em.received_at, em.synced_at
           FROM email_messages em WHERE em.id = :id"""
    ), {"id": message_id})).fetchone()
    return _row_to_message(row).model_dump() if row else {}


class DraftUpsertRequest(BaseModel):
    account_id: str
    # Local id of an existing draft to UPDATE in place (omit to create a new one).
    draft_id: str | None = None
    # Local id of the message being replied to (creates a threaded reply draft).
    reply_to_message_id: str | None = None
    to: list[str] = []
    subject: str = ""
    body: str = ""


@router.put("/drafts")
async def upsert_draft(
    req: DraftUpsertRequest,
    user: UserContext = Depends(get_current_user),
):
    """Create or update a draft on the provider AND mirror it locally.

    This is the reverse-sync write path behind Gmail/Outlook-style auto-save:
    the editor saves as you type. ``draft_id`` updates the same provider draft in
    place (no duplicates); ``reply_to_message_id`` threads a new reply draft;
    neither → a standalone draft. Returns the persisted message so the UI can show
    it in the Drafts folder and in-thread at once."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        provider, store, owner_email = await _provider_for_account(
            db, req.account_id, user.email or "anonymous"
        )
        if not await provider.authenticate():
            raise HTTPException(status_code=401, detail="Email account auth failed")

        to = [t for t in (req.to or []) if t]
        subject = req.subject or ""
        thread_id: str | None = None

        if req.draft_id:
            drow = (await db.execute(text(
                "SELECT provider_message_id, thread_id, subject FROM email_messages"
                " WHERE id = :id AND account_id = :aid"
                " AND LOWER(folder) IN ('drafts', 'draft')"
            ), {"id": req.draft_id, "aid": req.account_id})).fetchone()
            if not drow:
                raise HTTPException(status_code=404, detail="Draft not found")
            thread_id = drow.thread_id
            subject = subject or (drow.subject or "")
            try:
                provider_id = await provider.update_draft(
                    drow.provider_message_id, to=to or None,
                    subject=subject or None, body_text=req.body,
                )
            except NotImplementedError:
                # No in-place update primitive → make a fresh draft, drop the old.
                provider_id = await provider.create_draft(
                    to=to, subject=subject, body_text=req.body,
                    thread_id=thread_id or None,
                )
                try:
                    await provider.trash_message(drow.provider_message_id)
                except Exception:  # noqa: BLE001
                    pass
        elif req.reply_to_message_id:
            # Accept either the local message id (inline reply) or the provider
            # message id (full composer pop-out passes providerMessageId).
            rrow = (await db.execute(text(
                "SELECT provider_message_id, thread_id, subject, from_address"
                " FROM email_messages WHERE account_id = :aid"
                " AND (id = :id OR provider_message_id = :id)"
                " LIMIT 1"
            ), {"id": req.reply_to_message_id, "aid": req.account_id})).fetchone()
            if not rrow:
                raise HTTPException(status_code=404, detail="Reply target not found")
            thread_id = rrow.thread_id
            if not subject:
                s0 = rrow.subject or ""
                subject = s0 if s0.lower().startswith("re:") else f"Re: {s0}"
            if not to:
                frm = rrow.from_address if isinstance(rrow.from_address, dict) \
                    else json.loads(rrow.from_address or "{}")
                if frm.get("email"):
                    to = [frm["email"]]
            provider_id = await provider.create_draft(
                to=to, subject=subject, body_text=req.body,
                reply_to_message_id=rrow.provider_message_id,
                thread_id=thread_id or None,
            )
        else:
            provider_id = await provider.create_draft(
                to=to, subject=subject, body_text=req.body,
            )

        local_id = await _upsert_local_draft(
            db, req.account_id, provider_id, thread_id=thread_id,
            owner_email=owner_email, to_email=(to[0] if to else ""),
            subject=subject, body=req.body,
        )
        await _persist_rotated_creds(db, store, req.account_id, provider)
        await db.commit()
        return await _fetch_message_dict(db, local_id)
    finally:
        await db.close()


class DraftSendRequest(BaseModel):
    account_id: str
    draft_id: str  # local email_messages id of the draft to send


@router.post("/drafts/send")
async def send_draft_endpoint(
    req: DraftSendRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Send an existing draft natively (Drafts → Sent, no duplicate) and drop the
    local draft row. Falls back to send-new-then-trash for providers without a
    native send-draft primitive."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        drow = (await db.execute(text(
            "SELECT provider_message_id, subject, to_addresses, body_text,"
            " thread_id"
            " FROM email_messages WHERE id = :id AND account_id = :aid"
            " AND LOWER(folder) IN ('drafts', 'draft')"
        ), {"id": req.draft_id, "aid": req.account_id})).fetchone()
        if not drow:
            raise HTTPException(status_code=404, detail="Draft not found")
        provider, store, _owner = await _provider_for_account(
            db, req.account_id, user.email or "anonymous"
        )
        if not await provider.authenticate():
            raise HTTPException(status_code=401, detail="Email account auth failed")
        try:
            await provider.send_draft(drow.provider_message_id)
        except NotImplementedError:
            recips = drow.to_addresses if isinstance(drow.to_addresses, list) \
                else json.loads(drow.to_addresses or "[]")
            to = [a.get("email") for a in recips if a.get("email")]
            await provider.send_message(
                to=to, subject=drow.subject or "", body_text=drow.body_text or "")
            try:
                await provider.trash_message(drow.provider_message_id)
            except Exception:  # noqa: BLE001
                pass
        # The draft has left the mailbox — remove the local row.
        await db.execute(
            text("DELETE FROM email_messages WHERE id = :id"),
            {"id": req.draft_id},
        )
        await _persist_rotated_creds(db, store, req.account_id, provider)
        await db.commit()
        # Reply complete: learn from the sent body and move the thread out of
        # "To Reply" → Awaiting Reply (same hooks as the full /send path).
        if drow.thread_id:
            from gateway.routes.email.automation.replyzero import (  # noqa: PLC0415
                _mark_thread_replied,
            )
            background.add_task(
                _learn_from_sent, req.account_id, drow.thread_id,
                drow.body_text or "")
            background.add_task(
                _mark_thread_replied, req.account_id, drow.thread_id,
                drow.body_text or "", drow.subject or "")
            # Trash any other drafts left in the thread (e.g. an AI draft).
            background.add_task(
                _cleanup_thread_drafts, req.account_id, drow.thread_id)
        return {"sent": True}
    finally:
        await db.close()


class SaveDraftRequest(BaseModel):
    account_id: str
    message_id: str  # the email being replied to (for thread + recipient)
    body: str


@router.post("/drafts/save")
async def save_draft(
    req: SaveDraftRequest,
    user: UserContext = Depends(get_current_user),
):
    """Save an explicit (possibly user-edited) reply body as a provider draft.

    Powers the chat's interactive draft card: the assistant proposes a draft,
    the user edits it inline, then saves it to their Drafts folder verbatim. The
    draft is mirrored locally so it shows in Drafts/in-thread immediately."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        row = (await db.execute(text(
            "SELECT subject, thread_id, from_address FROM email_messages "
            "WHERE id = :mid AND account_id = :aid"
        ), {"mid": req.message_id, "aid": req.account_id})).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")
        frm = row.from_address if isinstance(row.from_address, dict) \
            else json.loads(row.from_address or "{}")
        provider, pmid, account_id, store = await _provider_for_message(
            db, req.message_id, user.email or "anonymous"
        )
        if not await provider.authenticate():
            return {"created": False, "reason": "auth failed"}
        subject = row.subject or ""
        re_subject = subject if subject.lower().startswith("re:") else f"Re: {subject}"
        to_email = frm.get("email", "")
        provider_id = await provider.create_draft(
            to=[to_email],
            subject=re_subject,
            body_text=req.body,
            reply_to_message_id=pmid,
            thread_id=row.thread_id or None,
        )
        local_id = await _upsert_local_draft(
            db, req.account_id, provider_id, thread_id=row.thread_id,
            owner_email="", to_email=to_email,
            subject=re_subject, body=req.body,
        )
        await _persist_rotated_creds(db, store, account_id, provider)
        await db.commit()
        return {"created": True, "id": local_id}
    finally:
        await db.close()
