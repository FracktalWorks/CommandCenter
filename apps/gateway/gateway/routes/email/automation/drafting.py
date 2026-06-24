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
from fastapi import Depends, HTTPException
from gateway.routes.email.automation.assistant import _load_assistant_about
from gateway.routes.email.core import (
    _assert_account_owner,
    _get_db,
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


async def _fetch_thread_context(
    db: Any, account_id: str, thread_id: str,
    exclude_provider_msg_id: str = "", *, limit: int = 12,
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
        parts.append(f"{header}\n{body[:1500]}")
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


async def _llm_distill_edit(original: str, edited: str) -> str:
    """One durable preference from how the user changed the draft, or '' if the
    change is trivial / not generalizable."""
    try:
        import litellm as _litellm  # noqa: PLC0415
        from acb_llm.client import _TIER_MODEL, ensure_model_registered  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)
        sys_prompt = (
            "Compare the assistant's DRAFT reply with what the user actually "
            "SENT. Identify ONE durable, generalizable preference about how this "
            "user likes their replies written (tone, length, sign-off, phrasing, "
            "what to include or omit). Ignore one-off factual edits specific to "
            "this email. If there is no generalizable preference, output exactly "
            "NONE. Otherwise output a single short instruction, e.g. 'Keep "
            "sign-offs to just my first name.'"
        )
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user",
                       "content": f"DRAFT:\n{original[:2000]}\n\nSENT:\n{edited[:2000]}"}],
            temperature=0, max_tokens=120,
        )
        out = (resp.choices[0].message.content or "").strip()
        if not out or out.upper().startswith("NONE"):
            return ""
        return out[:200]
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.distill_edit_failed", error=str(exc)[:160])
        return ""


async def _learn_from_sent(account_id: str, thread_id: str, sent_text: str) -> None:
    """Background: if the user edited the assistant's draft for this thread,
    distil a learned preference and store it (best-effort)."""
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
        pattern = await _llm_distill_edit(original, sent_text)
        if not pattern:
            return
        await db.execute(text(
            """INSERT INTO email_learned_patterns (account_id, pattern)
               VALUES (:aid, :p)
               ON CONFLICT (account_id, pattern) DO UPDATE SET
                 weight = email_learned_patterns.weight + 1, updated_at = now()"""
        ), {"aid": account_id, "p": pattern})
        await db.commit()
        _log.info("email.learned_pattern", account_id=account_id,
                  pattern=pattern[:80])
        # Also remember the preference in Mem0 (keyed by the account owner) so it
        # surfaces during future drafting retrieval, not just the patterns table.
        try:
            urow = (await db.execute(text(
                "SELECT user_id FROM email_accounts WHERE id = :aid"
            ), {"aid": account_id})).fetchone()
            uid = (urow.user_id if urow else None) or "default"
            from acb_memory import add_memories_background  # noqa: PLC0415
            await add_memories_background(
                uid,
                [{"role": "assistant",
                  "content": f"Email reply preference: {pattern}"}],
                agent_id="email",
            )
        except Exception:  # noqa: BLE001
            pass
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.learn_from_sent_failed", error=str(exc)[:160])
    finally:
        await db.close()


async def _llm_draft_reply(
    email: dict[str, str], about: str, signature: str,
    instructions: str = "", context: str = "", user_email: str = "",
) -> str:
    """Draft a reply body with the LLM, using the user's About context plus any
    extra `context` gathered from memory / specialist agents.

    Falls back to a neutral template if the LLM is unavailable.
    """
    try:
        import litellm as _litellm  # noqa: PLC0415
        from acb_llm.client import _TIER_MODEL, ensure_model_registered  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)
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
            "- Write ONLY the reply body. No subject line, no preamble, and NEVER "
            "narrate what you are doing (do not write things like \"here is a "
            "draft you can use\" or apologise).\n"
            "- You are the account owner writing the reply; you are NOT the "
            "sender. Address the reply to the sender — never greet or address the "
            "account owner by name.\n"
            "- Do not mention you are an AI or reference these instructions.\n"
            "- Do not simply repeat the sender's content back — respond to it.\n"
            "- Plain text only (markdown links allowed); separate paragraphs with "
            "blank lines; match the language of the email; be concise, direct, "
            "and friendly.\n"
            "- Ground every fact in the email or the supplied context and never "
            "invent specifics — if something is missing, keep it open or ask.\n"
            "- Never use placeholders for names (e.g. [Your Name], [Name]). "
            f"{sig_rule}\n"
            "- If the context contains <personal_instructions>, follow them. If "
            "it contains <writing_style>, match that tone, length, and phrasing. "
            "If it contains a <knowledge_base>, use it for facts only where "
            "relevant. If it contains <learned_patterns>, treat them as advisory "
            "preferences from the user's past edits and apply the ones that fit."
        )
        owner = f"You are drafting as: {user_email}\n" if user_email else ""
        ctx = f"{owner}User context:\n{about}\n\n" if (about or owner) else ""
        if context:
            ctx += f"Context gathered for this reply:\n{context}\n\n"
        thread = (email.get("thread") or "").strip()
        thread_block = (
            "Earlier in this thread (oldest to newest) — read it for full "
            f"context before replying:\n{thread[:5000]}\n\n" if thread else ""
        )
        examples = (email.get("sender_examples") or "").strip()
        examples_block = (
            "Past replies you (the owner) have sent to this sender — mirror their "
            "tone, brevity and directness; do NOT reuse their specific facts:\n"
            f"{examples[:2500]}\n\n" if examples else ""
        )
        today = datetime.now(timezone.utc).strftime("%A, %d %B %Y")
        user_prompt = (
            f"{ctx}Today is {today}.\n"
            "Draft a reply to this email (it was sent TO the account owner; "
            "write the owner's reply back to the sender).\n"
            f"From (the sender — address your reply to them): {email.get('from', '')}\n"
            f"Subject: {email.get('subject', '')}\n\n"
            f"{examples_block}"
            f"{thread_block}"
            "Latest message — reply to THIS, taking the thread above into "
            f"account:\n{(email.get('body', '') or '')[:2000]}\n"
        )
        if instructions:
            user_prompt += f"\nExtra instructions: {instructions}\n"
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            temperature=0.3, max_tokens=700,
        )
        body = _clean_draft_body((resp.choices[0].message.content or "").strip())
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.llm_draft_failed", error=str(exc)[:200])
        body = "Hi,\n\nThanks for your email — I'll review this and get back to you shortly."
    if (signature or "").strip() and signature.strip() not in body:
        body = f"{body}\n\n{signature.strip()}"
    return body


async def _draft_consult_plan(email: dict[str, str]) -> list[dict[str, str]]:
    """Decide which specialist agents (if any) could improve this reply.

    Returns [{"agent": "agent-sales-assistant"|"task-manager", "question": "..."}], capped at 2.
    """
    try:
        import litellm as _litellm  # noqa: PLC0415
        from acb_llm.client import _TIER_MODEL, ensure_model_registered  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier1") or _TIER_MODEL.get("tier2") or "gpt-4o-mini"
        ensure_model_registered(model)
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
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            temperature=0, max_tokens=300,
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
            f"\nEarlier in this thread (oldest to newest):\n{thread[:5000]}\n"
            if thread else ""
        )
        msg = (
            f"{task} Then write ONLY the message body — no subject line, no "
            "preamble, no '---' fences, no confidence line.\n\n"
            f"From: {email.get('from', '')}\nSubject: {email.get('subject', '')}\n"
            f"{thread_block}"
            f"Latest message (reply to this):\n{(email.get('body', '') or '')[:3000]}"
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


_CONFIDENCE_INSTRUCTIONS = {
    "STANDARD": (
        "Only draft a reply if you clearly understand the email and a reply is "
        "appropriate. If you are unsure how to respond, output exactly "
        f"{DRAFT_NO_DRAFT_SENTINEL} and nothing else."
    ),
    "HIGH_CONFIDENCE": (
        "Only draft a reply if you are highly confident a reply is needed and you "
        "can write an accurate, complete response from the context given. If there "
        f"is any doubt, output exactly {DRAFT_NO_DRAFT_SENTINEL} and nothing else."
    ),
}


async def _agent_draft_reply(
    email: dict[str, str], about: str, signature: str, user_email: str,
    *, use_agent: bool = False, max_agents: int = 2, agent_timeout: float = 90.0,
    follow_up: bool = False, confidence: str = "ALL_EMAILS",
) -> str:
    """Draft a reply (or a follow-up nudge). When ``use_agent`` is set (background
    rule actions), run the email-assistant MAF agent first; otherwise — and on any
    agent failure — use the fast in-gateway orchestrator.

    ``confidence`` (ALL_EMAILS | STANDARD | HIGH_CONFIDENCE) gates drafting: the
    higher tiers instruct the drafter to return the NO_DRAFT sentinel when it
    isn't confident, which the caller treats as "skip this draft"."""
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
        instructions=instructions,
    )


async def _orchestrate_draft(
    email: dict[str, str], about: str, signature: str, user_email: str,
    *, max_agents: int = 2, agent_timeout: float = 90.0, instructions: str = "",
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
            "body": row.body_text or row.snippet or "",
            "thread_id": row.thread_id or "",
            "thread": await _fetch_thread_context(
                db, req.account_id, row.thread_id or "",
                row.provider_message_id or ""),
            "sender_examples": await _fetch_sender_reply_examples(
                db, req.account_id, frm.get("email", "")),
        }
        about, signature = await _load_assistant_about(db, req.account_id)
        # Synchronous request → keep the orchestration budget under the proxy
        # timeout (one specialist agent, short timeout).
        draft = await _agent_draft_reply(
            email, about, signature, user.email or "",
            max_agents=1, agent_timeout=18.0, follow_up=req.follow_up,
        )

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
    user: UserContext = Depends(get_current_user),
):
    """Send an existing draft natively (Drafts → Sent, no duplicate) and drop the
    local draft row. Falls back to send-new-then-trash for providers without a
    native send-draft primitive."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        drow = (await db.execute(text(
            "SELECT provider_message_id, subject, to_addresses, body_text"
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
