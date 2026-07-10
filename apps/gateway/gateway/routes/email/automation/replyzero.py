"""Automation · Reply Zero — needs-reply classification, the reply-zero views,
follow-up reminders, and the inbox AI chat/quick-action endpoints."""

from __future__ import annotations

import contextlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from gateway.routes.email.automation.assistant import _load_assistant_about
from gateway.routes.email.automation.drafting import _agent_draft_reply, _is_no_draft
from gateway.routes.email.automation.identity import (
    resolve_org_domains,
    sender_scope,
)
from gateway.routes.email.core import (
    _assert_account_owner,
    _attachment_summaries,
    _fmt_addr_list,
    _get_db,
    _instantiate_provider,
    _log,
    _persist_rotated_creds,
    _safe_json,
    router,
)
from pydantic import BaseModel
from sqlalchemy import text


class AIChatRequest(BaseModel):
    messages: list[dict[str, str]]
    account_id: str | None = None
    email_context_id: str | None = None
    session_id: str | None = None  # stable per conversation (thread continuity)


class QuickActionRequest(BaseModel):
    action: str  # 'summarize' | 'find_urgent' | 'draft_reply' | 'unsubscribe'
    account_id: str | None = None
    email_id: str | None = None


async def _build_chat_context(
    user_id: str, account_id: str | None, email_context_id: str | None,
    is_first_turn: bool,
) -> tuple[str | None, list[str]]:
    """Resolve which account the assistant should act on (defaulting to the user's
    only account) and assemble the background context it receives via
    ``memory_context``: an account hint, an inbox snapshot on the first turn, and
    the email currently open in the reader. Returns ``(account_id, context_parts)``.
    Best-effort — never raises."""
    parts: list[str] = []
    resolved = account_id
    db = await _get_db()
    try:
        accounts = (await db.execute(text(
            "SELECT id, email_address FROM email_accounts WHERE user_id = :uid "
            "ORDER BY created_at"
        ), {"uid": user_id})).fetchall()
        acc_map = {str(a.id): a.email_address for a in accounts}
        if account_id and account_id in acc_map:
            resolved = account_id
        elif len(accounts) == 1:
            resolved = str(accounts[0].id)

        # The user's OWN addresses — so the model never reports the user as a
        # sender / "someone who emails you"; mail from these was sent BY the user.
        own_addrs = ", ".join(sorted(acc_map.values()))
        if own_addrs:
            parts.append(
                "## You (the account owner)\n"
                f"You are acting on behalf of the user, whose own email "
                f"address(es) are: {own_addrs}. NEVER report any of these as a "
                "sender, a top sender, or someone who emails the user — messages "
                "from them were sent BY the user.")

        if resolved and resolved in acc_map:
            parts.append(
                "## Email account\n"
                f"Act on account id={resolved} ({acc_map[resolved]}). Pass this "
                "account_id to tools unless the user names another account.")
        elif len(accounts) > 1:
            listing = "; ".join(
                f"{a.email_address} (id={a.id})" for a in accounts)
            parts.append(
                "## Email accounts\nThe user has several accounts: " + listing
                + ". Ask which one before account-scoped actions.")

        if resolved and is_first_turn:
            tot = (await db.execute(text(
                "SELECT count(*) AS total, "
                "count(*) FILTER (WHERE is_read = false) AS unread "
                "FROM email_messages WHERE account_id = :aid "
                "AND LOWER(folder) = 'inbox'"
            ), {"aid": resolved})).fetchone()
            nr = (await db.execute(text(
                "SELECT count(*) AS c FROM email_thread_status "
                "WHERE account_id = :aid AND status = 'NEEDS_REPLY'"
            ), {"aid": resolved})).fetchone()
            cats = (await db.execute(text(
                "SELECT category, count(*) AS c FROM email_senders "
                "WHERE account_id = :aid AND category IS NOT NULL "
                "GROUP BY category ORDER BY c DESC LIMIT 6"
            ), {"aid": resolved})).fetchall()
            cat_str = ", ".join(
                f"{r.category}: {r.c}" for r in cats) or "not categorized yet"
            parts.append(
                "## Inbox snapshot\n"
                f"- Inbox: {tot.total if tot else 0} messages, "
                f"{tot.unread if tot else 0} unread\n"
                f"- Needs reply (Reply Zero): {nr.c if nr else 0}\n"
                f"- Sender categories: {cat_str}\n"
                "To answer questions about the WHOLE inbox use query_inbox "
                "(filter by date/category/sender/read-state), get_important_emails, "
                "find_needs_reply, or get_account_overview; read_email for one "
                "email's full content.")

        if email_context_id:
            row = (await db.execute(text(
                "SELECT em.subject, em.body_text, em.from_address, em.received_at "
                "FROM email_messages em "
                "JOIN email_accounts ea ON em.account_id = ea.id "
                "WHERE em.id = :id AND ea.user_id = :uid"
            ), {"id": email_context_id, "uid": user_id})).fetchone()
            if row:
                frm = row.from_address if isinstance(row.from_address, dict) \
                    else json.loads(row.from_address or "{}")
                parts.append(
                    f"## Email open in the reader (id={email_context_id})\n"
                    f"From: {frm.get('name') or ''} <{frm.get('email') or ''}>\n"
                    f"Subject: {row.subject or ''}\n"
                    f"Date: {row.received_at}\n\n"
                    f"{(row.body_text or '')[:5000]}")
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.chat_context_failed", error=str(exc)[:160])
    finally:
        await db.close()
    return resolved, parts


@router.post("/ai/chat")
async def ai_chat(
    req: AIChatRequest,
    user: UserContext = Depends(get_current_user),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """AI assistant chat — streams SSE events from the email assistant agent.

    Routes through the orchestrator's run_agent_stream with the email-assistant
    agent, translating AG-UI protocol events into the frontend SSE format
    (type: 'start' / 'content' / 'done').
    """
    import uuid

    user_id: str = getattr(user, "email", "") or "anonymous"
    run_id = str(uuid.uuid4())

    # ── Set user context for memory tools ──
    # Deliberately the BARE user email, NOT an account-scoped key: the agent
    # reuses this same ContextVar as its X-User-Email gateway-auth identity (see
    # agents._current_user_email), so a "#acct:" suffix would break every tool
    # call. The drafting pipeline's per-account Mem0 scope (email_memory_scope)
    # lives on the gateway side only — the chat agent's free-form remember()
    # intentionally reads the user-global namespace.
    try:
        from acb_skills.memory_tools import _set_memory_user_id  # noqa: PLC0415
        _set_memory_user_id(user_id)
    except ImportError:
        pass

    # Build the agent payload — the last user message + optional email context
    last_user_msg = ""
    if req.messages:
        for m in reversed(req.messages):
            if m.get("role") == "user":
                last_user_msg = m.get("content", "")
                break

    # The agent's context is passed through the channels the orchestrator actually
    # consumes: `messages` (multi-turn history, replayed into the MAF message list)
    # and `memory_context` (injected into the agent's instructions every turn).
    # A plain `conversation_history` string key would be silently dropped.
    is_first_turn = sum(
        1 for m in (req.messages or []) if m.get("role") == "user") <= 1

    account_id, ctx_parts = await _build_chat_context(
        user_id, req.account_id, req.email_context_id, is_first_turn)

    payload: dict[str, Any] = {
        "message": last_user_msg or "Help me with my email",
        "user_query": last_user_msg,
        "messages": req.messages or [],
        "memory_context": "\n\n".join(ctx_parts),
        "account_id": account_id,
        "email_context_id": req.email_context_id,
        "user_email": user_id,
        # Attribute this agent run to the email app on the observability bus
        # (executor reads event_payload["source"]; defaults to "chat" otherwise).
        "source": "email",
    }

    # ── Resolve which LiteLLM tier the email CHAT should use (per-account) ──
    # The chat panel uses its own chat_model setting (default tier-powerful — a
    # strong tool-caller, matching _DEFAULT_TASK_MODELS["chat"]), independent of
    # rule evaluation and draft writing.  This fallback only applies when there
    # is no account_id or the per-account lookup fails.
    chat_model = "tier-powerful"
    if req.account_id:
        try:
            from gateway.routes.email.automation.assistant import _account_models  # noqa: PLC0415
            _mdb = await _get_db()
            try:
                chat_model = (await _account_models(_mdb, req.account_id))["chat"]
            finally:
                await _mdb.close()
        except Exception:  # noqa: BLE001
            pass

    # ── Run the agent through the orchestrator ──
    from orchestrator.executor import run_agent_stream  # noqa: PLC0415

    # A stable session id keeps the agent's thread (memory) continuous across the
    # turns of one conversation; fall back to the per-request run id.
    thread_key = req.session_id or run_id
    agent_gen = run_agent_stream(
        "email-assistant",
        payload,
        run_id=run_id,
        thread_id=f"email-chat:{user_id}:{thread_key}",
        model=chat_model,
    )

    async def event_stream():
        """Translate AG-UI protocol events to frontend SSE format."""
        # Set the memory/user ContextVar HERE — this generator runs in Starlette's
        # streaming context (not the handler body), so the agent's tools and
        # memory see the right user only if it's set inside the stream.
        try:
            from acb_skills.memory_tools import _set_memory_user_id  # noqa: PLC0415
            _set_memory_user_id(user_id)
        except Exception:  # noqa: BLE001
            pass

        yield f"data: {json.dumps({'type': 'start'})}\n\n"

        content_buffer: list[str] = []
        # toolCallId → friendly tool name + accumulated args JSON, so the result
        # event can be labelled and carry the structured input (for rich cards).
        tool_names: dict[str, str] = {}
        tool_args: dict[str, str] = {}
        try:
            async for sse_line in agent_gen:
                if not sse_line.startswith("data: "):
                    continue
                try:
                    evt = json.loads(sse_line[len("data: "):])
                except json.JSONDecodeError:
                    continue

                evt_type = evt.get("type", "")
                if evt_type in (
                    "TEXT_MESSAGE_CONTENT",
                    "REASONING_MESSAGE_CONTENT",
                    "THINKING_TEXT_MESSAGE_CONTENT",
                ):
                    delta = str(evt.get("delta", "") or evt.get("content", ""))
                    if delta:
                        content_buffer.append(delta)
                        yield f"data: {json.dumps({'type': 'content', 'text': delta})}\n\n"

                elif evt_type == "TOOL_CALL_START":
                    # Surface tool activity so the chat can render AG-UI cards
                    # (searched inbox / read email / drafted reply / created rule).
                    name = str(evt.get("toolCallName")
                               or evt.get("tool_call_name") or "tool")
                    tid = str(evt.get("toolCallId") or "")
                    tool_names[tid] = name
                    tool_evt = {"type": "tool", "phase": "start",
                                "id": tid, "name": name}
                    yield f"data: {json.dumps(tool_evt)}\n\n"

                elif evt_type == "TOOL_CALL_ARGS":
                    tid = str(evt.get("toolCallId") or "")
                    tool_args[tid] = tool_args.get(tid, "") + str(
                        evt.get("delta") or evt.get("args") or "")

                elif evt_type in ("TOOL_CALL_END", "TOOL_CALL_RESULT"):
                    tid = str(evt.get("toolCallId") or "")
                    result = str(evt.get("content") or evt.get("result") or "")
                    parsed_args: Any = None
                    raw_args = tool_args.get(tid, "")
                    if raw_args:
                        try:
                            parsed_args = json.loads(raw_args)
                        except Exception:  # noqa: BLE001
                            parsed_args = None
                    tool_evt = {
                        "type": "tool", "phase": "result", "id": tid,
                        "name": tool_names.get(tid, "tool"),
                        "result": result[:2000],
                        "args": parsed_args,
                        "success": evt.get("success") is not False,
                    }
                    yield f"data: {json.dumps(tool_evt)}\n\n"

                elif evt_type in ("RUN_FINISHED", "done"):
                    # Capture any TOOL_CALL_RESULT that might be the final answer
                    # when the agent returns a tool result as its last message
                    result_text = evt.get("result") or ""
                    if result_text:
                        content_buffer.append(result_text)
                        yield f"data: {json.dumps({'type': 'content', 'text': result_text})}\n\n"

                elif evt_type == "RUN_ERROR":
                    error_msg = evt.get("error", "Agent encountered an error")
                    yield f"data: {json.dumps({'type': 'error', 'error': error_msg})}\n\n"
                    yield f"data: {json.dumps({'type': 'done'})}\n\n"
                    return

        except Exception as exc:  # noqa: BLE001
            _log.error("email.ai_chat_stream_error", error=str(exc))
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)})}\n\n"

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

        # ── Save episode to knowledge graph ──
        full_response = "".join(content_buffer)
        if full_response and last_user_msg:
            try:
                from acb_memory import add_episode  # noqa: PLC0415
                background_tasks.add_task(
                    add_episode,
                    name=f"email-assistant:{user_id[:20]}",
                    content=f"Q: {last_user_msg[:300]}\nA: {full_response[:500]}",
                    source_description="email-assistant",
                    group_id=user_id,
                )
            except ImportError:
                pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/ai/quick-action")
async def quick_action(
    req: QuickActionRequest,
    user: UserContext = Depends(get_current_user),
):
    """Trigger a quick AI action (summarize, find urgent, draft reply).

    Calls the email-assistant agent's tool functions directly for fast,
    non-streaming responses to common email workflows.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "email_agent",
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "agent-email-assistant", "agents.py"),
    )
    agent_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(agent_mod)

    # Scope the agent's gateway tool calls to the current user.
    try:
        from acb_skills.memory_tools import _set_memory_user_id  # noqa: PLC0415
        _set_memory_user_id(user.email or "")
    except ImportError:
        pass

    try:
        if req.action == "summarize":
            result = await agent_mod.search_emails(
                query="unread",
                folder="inbox",
                account_id=req.account_id,
            )
        elif req.action == "find_urgent":
            result = await agent_mod.find_urgent(account_id=req.account_id)
        elif req.action == "draft_reply":
            if not req.email_id or not req.account_id:
                raise HTTPException(
                    status_code=400,
                    detail="email_id and account_id are required for draft_reply",
                )
            result = await agent_mod.draft_reply(
                email_id=req.email_id, account_id=req.account_id,
            )
        elif req.action == "unsubscribe":
            result = await agent_mod.suggest_unsubscribes(account_id=req.account_id)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown action: {req.action}. Supported: summarize, find_urgent, draft_reply, unsubscribe",
            )

        return {"action": req.action, "result": result, "ok": True}

    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        _log.error("email.quick_action_error", action=req.action, error=str(exc))
        raise HTTPException(
            status_code=500,
            detail=f"Quick action '{req.action}' failed: {str(exc)}",
        )


def _addr_dict(raw: Any) -> dict:
    return raw if isinstance(raw, dict) else json.loads(raw or "{}")


async def _upsert_thread_status(
    db: Any, account_id: str, thread_id: str, status: str,
    msg_id: Any, msg_at: Any, reason: str, *, preserve_done: bool = False,
) -> None:
    """Write a thread's Reply Zero status.

    ``preserve_done`` is for the AUTOMATED re-projection paths (the live runner
    and the backfill, via ``project_reply_status_from_matches``): a thread the
    user MARKED DONE must not be silently re-opened by a trailing notification or
    FYI. With it set, a DONE thread is only re-opened when the new message
    genuinely NEEDS A REPLY (→ NEEDS_REPLY); any other determined status keeps it
    DONE. Explicit user actions (Mark Done / Reopen / Fix) and the user's own
    reply (``_mark_thread_replied``) leave it False, so their intent still wins."""
    status_expr = "EXCLUDED.status"
    if preserve_done:
        status_expr = (
            "CASE WHEN email_thread_status.status = 'DONE' "
            "AND EXCLUDED.status <> 'NEEDS_REPLY' THEN 'DONE' "
            "ELSE EXCLUDED.status END")
    await db.execute(text(
        f"""INSERT INTO email_thread_status
             (account_id, thread_id, status, last_message_id, last_message_at,
              reason, classified_at)
           VALUES (:aid, :tid, :st, :mid, :mat, :reason, now())
           ON CONFLICT (account_id, thread_id) DO UPDATE SET
             status = {status_expr},
             last_message_id = EXCLUDED.last_message_id,
             last_message_at = EXCLUDED.last_message_at,
             reason = EXCLUDED.reason, classified_at = now(),
             -- Re-arm the follow-up reminder whenever the thread changes hands.
             follow_up_reminded_at = CASE
               WHEN email_thread_status.status IS DISTINCT FROM EXCLUDED.status
                 OR email_thread_status.last_message_id IS DISTINCT FROM EXCLUDED.last_message_id
               THEN NULL ELSE email_thread_status.follow_up_reminded_at END"""
    ), {"aid": account_id, "tid": thread_id, "st": status, "mid": msg_id,
        "mat": msg_at, "reason": reason})


# Reply Zero status → (our thread status, the category label) mapping.
# NOTE: the map/rule KEYS are REPLY / AWAITING_REPLY / FYI / DONE (the user-facing
# labels are "Reply" / "Awaiting Reply" / "FYI" / "Done"). Legacy tokens
# (TO_REPLY / ACTIONED) are still accepted via ``_LEGACY_STATUS_KEYS`` so a stale
# provider label delta or an un-migrated rule name still resolves.
_THREAD_STATUS_MAP = {
    "REPLY": ("NEEDS_REPLY", "Reply"),
    "AWAITING_REPLY": ("AWAITING", "Awaiting Reply"),
    "DONE": ("DONE", "Done"),
    "FYI": ("FYI", "FYI"),
}

# Pre-rename conversation-status tokens → current keys. Applied wherever a
# system_type / rule-name / LLM status token is normalised, so old data keeps
# working after the "To Reply"→"Reply" / "Actioned"→"Done" rename.
_LEGACY_STATUS_KEYS = {"TO_REPLY": "REPLY", "ACTIONED": "DONE"}


def _canon_status_key(key: str | None) -> str:
    """Upper-case a status token and fold any legacy alias to its current key."""
    k = (key or "").upper().strip()
    return _LEGACY_STATUS_KEYS.get(k, k)

# Friendly reason prefix per recompute_thread_status trigger (shown in the UI).
_TRIGGER_REASON = {
    "outbound": "Replied",
    "inbound": "Inbound",
    "backfill": "Backfill",
    "reopen": "Reopened",
}

# The four conversation-status category labels are MUTUALLY EXCLUSIVE per thread
# (inbox-zero's removeConflictingThreadStatusLabels): when a thread's status
# changes, the other three must be cleared so an old label never lingers on the
# previous emails. "Follow-up" is a separate reminder label, cleared whenever the
# thread is no longer awaiting the other person.
_CONVERSATION_LABELS = ("Reply", "Awaiting Reply", "Done", "FYI")
# Pre-rename label strings still living on the provider / local mirror. Always
# swept alongside the current labels so a resync clears the orphaned old tags.
_LEGACY_CONVERSATION_LABELS = ("To Reply", "Actioned")
_FOLLOW_UP_LABEL = "Follow-up"

# Conversation-status rule key → stored Reply Zero status. The rules pipeline is
# the single source of truth: when the engine matches one of these rules for an
# inbound message, the runner projects the corresponding status here (Reply Zero
# is a projection of the rules, not a parallel classifier).
_CONVERSATION_RULE_STATUS = {
    "REPLY": "NEEDS_REPLY",
    "AWAITING_REPLY": "AWAITING",
    "FYI": "FYI",
    "DONE": "DONE",
}
# Priority when several conversation rules match the same email (most actionable
# first) — REPLY must win over AWAITING/FYI/DONE.
_CONVERSATION_PRIORITY = ("REPLY", "AWAITING_REPLY", "FYI", "DONE")


def _match_conversation_key(match: dict[str, Any] | None) -> str:
    """The conversation-status key (REPLY/…) of a matched rule, or ""."""
    if not match:
        return ""
    rule = match.get("rule") or {}
    key = _canon_status_key(rule.get("system_type"))
    if not key:
        key = _canon_status_key((rule.get("name") or "").replace(" ", "_"))
    return key if key in _CONVERSATION_RULE_STATUS else ""


async def project_reply_status_from_matches(
    db: Any, account_id: str, message_row: Any,
    matches: list[dict[str, Any]] | None,
) -> str | None:
    """Store an inbound message's Reply Zero status from the conversation-status
    rule the engine matched — the unified path that makes Reply Zero a projection
    of the rules (no parallel classifier). Called by the rule runner on live runs.

    Picks the highest-priority conversation rule among ``matches``; when none
    matched, stores FYI so the thread stays out of the Reply view and isn't
    re-evaluated by the backfill. Returns the conversation-status LABEL applied
    (e.g. "Reply") when a conversation rule matched — so the caller can
    reconcile the mutually-exclusive thread labels — else None. Best-effort;
    caller commits. Only call for inbound mail (sends → ``_mark_thread_replied``)."""
    thread_id = getattr(message_row, "thread_id", None)
    if not thread_id:
        return None
    chosen, reason = "", ""
    for m in matches or []:
        key = _match_conversation_key(m)
        if not key:
            continue
        if not chosen or (_CONVERSATION_PRIORITY.index(key)
                          < _CONVERSATION_PRIORITY.index(chosen)):
            chosen, reason = key, (m.get("reason") or "")
    status = _CONVERSATION_RULE_STATUS.get(chosen, "FYI")
    # preserve_done: this is an AUTOMATED inbound re-projection — never let a
    # trailing FYI/notification silently re-open a thread the user marked DONE
    # (only a genuine NEEDS_REPLY re-opens it). A non-empty reason keeps the row
    # from looking like an un-determined blank so the backfill doesn't re-chew it.
    await _upsert_thread_status(
        db, account_id, thread_id, status, message_row.id,
        getattr(message_row, "received_at", None),
        reason or "Auto-classified", preserve_done=True)
    return _THREAD_STATUS_MAP[chosen][1] if chosen else None


# The thread-status judgment is hard to do well on a weak model (it's a
# multi-turn "whose court is it?" call), and any wrong/empty answer collapses to
# the AWAITING fallback — so default to a mid tier and ESCALATE once on failure
# rather than silently mis-classifying. Configurable hook left for a future
# per-account "status" model role.
_STATUS_MODEL = "tier-balanced"
_STATUS_MODEL_ESCALATION = "tier-powerful"
# How many chars of the thread the determiner reads. Kept as the TAIL (newest
# messages, incl. the user's closing reply) — never the head, which is what's
# safe to drop as a thread grows.
_THREAD_PROMPT_BUDGET = 8000


def _clip_thread_for_prompt(thread_text: str, limit: int = _THREAD_PROMPT_BUDGET) -> str:
    """Trim ``thread_text`` to its TAIL within ``limit`` chars.

    The determiner reads the thread oldest→newest, but when it's too long the
    OLDEST messages are the safe ones to drop — the status hinges on the NEWEST
    ones (especially the user's closing reply, which callers append last). The
    old ``thread_text[:6000]`` head-slice dropped exactly those, so a long thread
    the user had just replied to read as ending on the other person's message →
    AWAITING. Snap the cut to a message boundary so we never start mid-message,
    and mark the elision."""
    if len(thread_text) <= limit:
        return thread_text
    tail = thread_text[-limit:]
    sep = "\n\n---\n\n"
    idx = tail.find(sep)
    if idx != -1:
        tail = tail[idx + len(sep):]
    return "[… earlier messages omitted …]\n\n---\n\n" + tail


async def _llm_determine_thread_status(
    thread_text: str, user_email: str, about: str, *, user_sent_last: bool = True,
    model: str = _STATUS_MODEL,
) -> tuple[str, bool]:
    """Determine an email thread's status from the user's perspective — a faithful
    port of inbox-zero's aiDetermineThreadStatus.

    Returns ``(status, confident)`` where status is REPLY / AWAITING_REPLY /
    DONE (and FYI only when the user did NOT send last). ``confident`` is
    False when the call FELL BACK (LLM error, unparseable, or out-of-set) — the
    fallback is always AWAITING_REPLY/FYI, a one-directional bias, so callers
    should treat a non-confident status as PROVISIONAL (mark it for re-check)
    instead of trusting a fabricated AWAITING. One escalating retry to a stronger
    tier is attempted before falling back."""
    fallback = "AWAITING_REPLY" if user_sent_last else "FYI"
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        fyi_state = "" if user_sent_last else "\n* FYI - No reply needed"
        fyi_opt = "" if user_sent_last else "FYI, "
        fyi_rules = "" if user_sent_last else (
            "\n- FYI: ONLY when there are absolutely no questions, requests, or "
            "pending actions anywhere in the thread, and the user RECEIVED the "
            "last message. A message where the user is only on Cc (not in To) "
            "and isn't directly asked anything is FYI, not REPLY.")
        last_rule = (
            "\n- Because the user sent the last email, FYI is NOT an option: "
            "choose AWAITING_REPLY if waiting on a response, or DONE if the "
            "thread is complete. If the user's last message asks no question and "
            "makes no commitment (e.g. a thank-you, acknowledgement, or 'sounds "
            "good'), prefer DONE." if user_sent_last else "")
        sys_prompt = (
            "You analyze an email thread and determine its current status from "
            "the user's perspective. It is in ONE of these mutually exclusive "
            "states:\n"
            "* REPLY - the user needs to reply\n"
            "* AWAITING_REPLY - waiting for the other person to respond/act"
            f"{fyi_state}\n* DONE - the thread is complete\n\n"
            "CRITERIA:\n"
            "- REPLY: someone asked the user a direct question or requested "
            "info/action and the user hasn't addressed it; OR the user promised "
            "a follow-up/deliverable and hasn't sent it. A clarifying question "
            "that got answered while a commitment is still pending is still "
            "REPLY.\n"
            "- AWAITING_REPLY: the ball is in the OTHER person's court — the user "
            "asked/requested and is still waiting, or someone else owes an "
            "action. If the user's request was already fulfilled, they are NO "
            "longer awaiting.\n"
            "- DONE: all questions answered and requests fulfilled, the "
            "conversation concluded, or the user sent info/recommendations and "
            "isn't waiting for anything. Taking ownership ('I'll handle it') "
            "fulfils a request unless it promises a later deliverable."
            f"{fyi_rules}\n\n"
            "RULES: weigh the WHOLE thread but the LAST message decides whose "
            "court the ball is in now; an earlier unanswered question/request "
            "still governs only if the last message didn't resolve it. A message "
            "marked '(you sent)' or '(your organisation sent)' is from YOUR side — "
            "a reply from the user's own organisation counts as your side having "
            "acted, so the ball is then in the OTHER party's court. If "
            "SOMEONE ELSE promised something → AWAITING_REPLY; if the USER "
            "promised a future reply/deliverable → REPLY."
            f"{last_rule}\n\n"
            'Respond with ONLY a JSON object: {"status": "<one of REPLY, '
            f'AWAITING_REPLY, {fyi_opt}DONE>", "rationale": "<one line>"}}.'
        )
        ctx = f"You are acting on behalf of: {user_email}\n"
        if (about or "").strip():
            ctx += f"{about.strip()[:1200]}\n"
        user_prompt = (
            f"{ctx}\nEmail thread (oldest to newest):\n"
            f"{_clip_thread_for_prompt(thread_text)}\n\n"
            "Determine the current status of this thread."
        )
        allowed = {"REPLY", "AWAITING_REPLY", "DONE"}
        if not user_sent_last:
            allowed.add("FYI")
        messages = [{"role": "system", "content": sys_prompt},
                    {"role": "user", "content": user_prompt}]
        # Try the configured tier, then escalate once. A wrong/empty answer here
        # always biases AWAITING, so a second stronger attempt is cheap insurance.
        for attempt_model in (model, _STATUS_MODEL_ESCALATION):
            resp, _ = await acompletion_with_fallback(
                model=attempt_model,
                messages=messages,
                temperature=0, max_tokens=500,
                response_format={"type": "json_object"},
            )
            data = _safe_json(resp.choices[0].message.content or "")
            st = ((data.get("status") if isinstance(data, dict) else "") or "")
            st = _canon_status_key(st)  # tolerate a legacy TO_REPLY/ACTIONED reply
            if st in allowed:
                return st, True
        return fallback, False
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.determine_status_failed", error=str(exc)[:160])
        return fallback, False


def _msg_scope(
    r: Any, self_email: str,
    extra_domains: frozenset[str] | set[str] = frozenset(),
) -> str:
    """Direction of one stored message: 'self' (the owner sent it — folder='sent'
    or the from-address is the owner), 'internal' (the owner's organisation sent
    it — same/extra domain), or 'external'. The 'sent' folder is authoritative for
    'self' so an owner reply mirrored before its from-address resolves is still
    recognised as ours."""
    if (getattr(r, "folder", "") or "").lower() == "sent":
        return "self"
    raw = getattr(r, "from_address", None)
    frm = raw if isinstance(raw, dict) else json.loads(raw or "{}")
    return sender_scope(frm.get("email", ""), self_email, extra_domains)


def _fmt_thread_msg(
    r: Any, self_email: str = "",
    extra_domains: frozenset[str] | set[str] = frozenset(),
    attach_line: str = "",
) -> str:
    frm = r.from_address if isinstance(r.from_address, dict) \
        else json.loads(r.from_address or "{}")
    sender = frm.get("name") or frm.get("email") or "?"
    scope = _msg_scope(r, self_email, extra_domains)
    direction = {
        "self": " (you sent)",
        "internal": " (your organisation sent)",
    }.get(scope, "")
    lines = [f"From: {sender}{direction}"]
    # Recipients on INBOUND messages so the determiner can tell a direct (To)
    # recipient from a Cc-only one (Cc-only + no ask → FYI, not Reply).
    if scope == "external":
        to = _fmt_addr_list(getattr(r, "to_addresses", None))
        cc = _fmt_addr_list(getattr(r, "cc_addresses", None))
        if to:
            lines.append(f"To: {to}")
        if cc:
            lines.append(f"Cc: {cc}")
        # Deterministic recipient-role signal — don't make the model infer it from
        # the address lists (Cc-only + no direct ask → FYI, not Reply).
        from gateway.routes.email.automation.engine import (  # noqa: PLC0415
            _recipient_role,
        )
        if _recipient_role(self_email, getattr(r, "to_addresses", None),
                           getattr(r, "cc_addresses", None)) == "cc":
            lines.append("(the user is only Cc'd here, not a direct To recipient)")
    dt = getattr(r, "received_at", None)
    if hasattr(dt, "isoformat"):
        lines.append(f"Date: {dt.isoformat()}")
    lines.append(f"Subject: {r.subject or ''}")
    if attach_line:
        lines.append(attach_line)
    body = (r.body_text or r.snippet or "").strip()
    lines.append(body[:1500])
    return "\n".join(lines)


async def _conversation_rule_for_status(
    db: Any, account_id: str, status: str,
) -> dict[str, Any] | None:
    """The account's enabled conversation rule for a determined status
    (REPLY / AWAITING_REPLY / FYI / DONE), matched by system_type or name.
    None when no such rule is enabled."""
    from gateway.routes.email.automation.rules import _load_rules  # noqa: PLC0415
    for r in await _load_rules(db, account_id):
        if r.get("enabled") and _match_conversation_key({"rule": r}) == status:
            return r
    return None


async def resolve_conversation_status_matches(
    db: Any, account_id: str, message_row: Any,
    matches: list[dict[str, Any]] | None,
) -> list[dict[str, Any]] | None:
    """inbox-zero ``determineConversationStatus`` parity for INBOUND mail.

    The per-message engine match decides only whether the email is a conversation
    (it picked one of the conversation-status rules). When it did, re-determine the
    status from the FULL thread (via ``build_thread_context`` — the same context
    the other triggers use, with ``user_sent_last`` taken from the real last
    message, so a thread your side already replied to can resolve to DONE) and
    replace the conversation match with the rule for the determined status — so the
    RIGHT rule's actions run (e.g. an Done thread doesn't auto-draft a reply)
    and the right label is applied. Non-conversation matches pass through
    unchanged. On any failure (or no enabled rule for the determined status)
    returns the input unchanged, so classification degrades to the per-message
    pick."""
    if not matches or not any(_match_conversation_key(m) for m in matches):
        return matches
    thread_id = getattr(message_row, "thread_id", None)
    if not thread_id:
        return matches
    try:
        about, _sig = await _load_assistant_about(db, account_id)
        acc = (await db.execute(text(
            "SELECT email_address FROM email_accounts WHERE id = :id"
        ), {"id": account_id})).fetchone()
        acc_email = (acc.email_address if acc else "") or ""
        ctx = await build_thread_context(
            db, account_id, thread_id, acc_email)
        if ctx is None:
            return matches
        status, _confident = await _llm_determine_thread_status(
            ctx.thread_text, acc_email, about,
            user_sent_last=ctx.our_side_last)
        target = await _conversation_rule_for_status(db, account_id, status)
        if not target:
            return matches
        non_conv = [m for m in matches if not _match_conversation_key(m)]
        determined = {"rule": target, "reason": f"Thread status: {status}",
                      "source": "thread_status", "is_primary": True}
        return [determined, *non_conv]
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.resolve_conversation_status_failed",
                     account_id=account_id, error=str(exc)[:160])
        return matches


async def _reconcile_thread_labels(
    db: Any, provider: Any, account_id: str, thread_id: str,
    keep_label: str | None,
) -> None:
    """Enforce inbox-zero's mutually-exclusive conversation labels on a thread.

    Across EVERY message in the thread, remove the conversation-status labels
    other than ``keep_label`` (Reply / Awaiting Reply / Done / FYI) — plus
    the "Follow-up" reminder unless the thread is still awaiting — so an old label
    never lingers on the previous emails after the thread changes hands. Then
    ensure ``keep_label`` is present on the latest inbound message. Mirrors the
    change locally (email_messages.categories) and upstream (provider). Best-effort
    per message; caller commits."""
    rows = (await db.execute(text(
        """SELECT id, provider_message_id, categories, folder
           FROM email_messages
           WHERE account_id = :aid AND thread_id = :tid
           ORDER BY received_at ASC NULLS FIRST"""
    ), {"aid": account_id, "tid": thread_id})).fetchall()
    if not rows:
        return
    stale = {lab for lab in (*_CONVERSATION_LABELS, *_LEGACY_CONVERSATION_LABELS)
             if lab != keep_label}
    if keep_label != "Awaiting Reply":  # follow-up only applies while awaiting
        stale.add(_FOLLOW_UP_LABEL)
    for r in rows:
        to_remove = [c for c in list(r.categories or []) if c in stale]
        if not to_remove:
            continue
        # Update our mirror FIRST so the chip reflects the change immediately,
        # even if the provider call fails or lags; the provider apply is a
        # best-effort follow-up (it must NOT gate the local state, or the UI
        # ends up with a label removed and the replacement never applied).
        await db.execute(text(
            "UPDATE email_messages SET categories = ARRAY("
            "  SELECT c FROM unnest(categories) AS c WHERE NOT (c = ANY(:rm))"
            "), updated_at = now() WHERE id = :id"
        ), {"id": r.id, "rm": to_remove})
        try:
            await provider.set_labels(
                r.provider_message_id, add=[], remove=to_remove)
        except Exception:  # noqa: BLE001 — one bad message shouldn't abort
            continue
    if not keep_label:
        return
    # Ensure the new status label is on the latest INBOUND message (the one a
    # reader looks at); fall back to the latest message if all are outbound.
    inbound = [r for r in rows if (r.folder or "").lower() != "sent"]
    target = inbound[-1] if inbound else rows[-1]
    if keep_label in list(target.categories or []):
        return
    # Mirror first (see above), then best-effort provider apply — so a thread
    # that's just been replied to flips to "Done"/"Awaiting Reply" in the UI
    # at once instead of losing "Reply" and showing no tag at all.
    await db.execute(text(
        "UPDATE email_messages SET categories = CASE "
        "WHEN :lbl = ANY(categories) THEN categories "
        "ELSE array_append(categories, :lbl) END, "
        "updated_at = now() WHERE id = :id"
    ), {"id": target.id, "lbl": keep_label})
    with contextlib.suppress(Exception):  # provider apply is best-effort
        await provider.set_labels(
            target.provider_message_id, add=[keep_label], remove=[])


# ── Thread-status authority ──────────────────────────────────────────────────
# One place builds a thread's context and one function determines + writes its
# status, so every trigger (a sent reply, a new inbound, the backfill, a reopen)
# decides identically — over the WHOLE thread, with direction resolved the same
# way — instead of each call site assembling the thread and guessing
# ``user_sent_last`` for itself.


@dataclass
class ThreadContext:
    """A thread prepared for the status determiner.

    ``our_side_last`` — the last message was sent by YOUR side (the owner or the
    owner's organisation), so FYI is off and the determiner weighs Awaiting vs
    Done. ``thread_text`` is direction-annotated (you / your organisation /
    external) and ``last_message_id``/``last_message_at`` are what the status row
    should be stamped with (``now()`` when an unsynced just-sent reply is folded
    in)."""
    thread_id: str
    last_message_id: Any
    last_message_at: Any
    our_side_last: bool
    has_external: bool
    thread_text: str


async def build_thread_context(
    db: Any, account_id: str, thread_id: str, self_email: str, *,
    extra_domains: frozenset[str] | set[str] | None = None,
    pending_reply: tuple[str, str] | None = None,
) -> ThreadContext | None:
    """Load a thread and render it for the determiner, once, for every caller.

    ``extra_domains`` defaults to None → the account's configured org domains are
    resolved here (so every status path is org-domain-aware without each caller
    plumbing it). Pass an explicit set (e.g. ``frozenset()``) to skip the lookup.

    ``pending_reply`` is ``(body, subject)`` of a reply the owner JUST sent that
    isn't mirrored into ``email_messages`` yet — it's appended as the final
    ``(you sent)`` message so the determination is accurate immediately (and
    ``our_side_last`` becomes True). Returns None when the thread has no rows."""
    if extra_domains is None:
        extra_domains = await resolve_org_domains(db, account_id)
    rows = (await db.execute(text(
        """SELECT id, from_address, to_addresses, cc_addresses, subject,
                  body_text, snippet, folder, received_at
           FROM email_messages
           WHERE account_id = :aid AND thread_id = :tid
           ORDER BY received_at ASC NULLS FIRST"""
    ), {"aid": account_id, "tid": thread_id})).fetchall()
    if not rows:
        return None
    latest = rows[-1]
    # Attachment metadata (filename + MIME) per message, so the determiner sees
    # "Attachments: invoice.pdf (…)" — a strong signal for status/intent.
    attach = await _attachment_summaries(db, [r.id for r in rows])
    parts = [_fmt_thread_msg(r, self_email, extra_domains,
                             attach.get(str(r.id), "")) for r in rows]
    scopes = [_msg_scope(r, self_email, extra_domains) for r in rows]
    has_external = any(s == "external" for s in scopes)
    our_side_last = scopes[-1] != "external"

    reply_pending = bool(pending_reply and pending_reply[0]) and (
        (latest.folder or "").lower() != "sent")
    if reply_pending:
        body, subject = pending_reply  # type: ignore[misc]
        parts.append(
            f"From: {self_email} (you sent)\n"
            f"Subject: {subject or latest.subject or ''}\n{body[:1500]}")
        our_side_last = True

    # Anchor last activity to the just-sent reply (not yet in the DB) so the
    # follow-up clock starts from NOW, not the inbound message we replied to.
    last_at = (datetime.now(timezone.utc)
               if reply_pending else latest.received_at)
    return ThreadContext(
        thread_id=thread_id, last_message_id=latest.id, last_message_at=last_at,
        our_side_last=our_side_last, has_external=has_external,
        thread_text="\n\n---\n\n".join(parts))


async def recompute_thread_status(
    db: Any, account_id: str, thread_id: str, *, trigger: str,
    about: str = "", acc_email: str = "",
    extra_domains: frozenset[str] | set[str] | None = None,
    pending_reply: tuple[str, str] | None = None,
    model: str = _STATUS_MODEL,
) -> tuple[str, str] | None:
    """THE thread-status authority: build the context, determine the status over
    the whole thread (with ``user_sent_last`` taken from the real last message —
    not assumed by the trigger), and write it through the single writer.

    ``trigger`` is one of ``outbound`` / ``inbound`` / ``backfill`` / ``reopen``.
    Automated triggers (inbound / backfill) PRESERVE a user's DONE; a reply the
    owner sent (outbound) or an explicit reopen may move it. A low-confidence
    (fallback) determination is tagged ``· auto`` so the backfill re-checks it.
    Returns ``(rz_status, label)`` or None when the thread has no messages.
    Caller commits; reconciling provider labels is the caller's job."""
    ctx = await build_thread_context(
        db, account_id, thread_id, acc_email,
        extra_domains=extra_domains, pending_reply=pending_reply)
    if ctx is None:
        return None
    status, confident = await _llm_determine_thread_status(
        ctx.thread_text, acc_email, about,
        user_sent_last=ctx.our_side_last, model=model)
    rz_status, label = _THREAD_STATUS_MAP.get(
        _canon_status_key(status), ("AWAITING", "Awaiting Reply"))
    prefix = _TRIGGER_REASON.get(trigger, trigger.capitalize())
    # A low-confidence (fallback) determination keeps the "· auto" marker so the
    # backfill re-checks it instead of trusting a guessed AWAITING.
    reason = f"{prefix} — {status}" + ("" if confident else " · auto")
    await _upsert_thread_status(
        db, account_id, thread_id, rz_status, ctx.last_message_id,
        ctx.last_message_at, reason,
        preserve_done=(trigger in ("inbound", "backfill")))
    return rz_status, label


async def _mark_thread_replied(
    account_id: str, thread_id: str,
    sent_body: str | None = None, sent_subject: str | None = None,
) -> None:
    """After the user sends a reply, re-determine the thread's status with the
    AI (exact inbox-zero aiDetermineThreadStatus parity) and reconcile labels:
    set the Reply Zero status and collapse the thread to a SINGLE conversation
    label (removing any stale Reply / Awaiting / FYI / Follow-up). Since the
    user just sent, FYI is excluded — the AI picks AWAITING_REPLY (waiting on
    them) or DONE (done). Best-effort.

    ``sent_body``/``sent_subject`` carry the reply the user just sent. It usually
    isn't mirrored into email_messages yet (it lands on the next sync), so pass it
    here and we append it to the thread the AI reads — making the Awaiting-vs-
    Done call accurate immediately (inbox-zero sees the sent message at once)
    instead of defaulting to Awaiting and only correcting on the next sync."""
    if not thread_id:
        return
    db = await _get_db()
    try:
        about, _sig = await _load_assistant_about(db, account_id)
        acc = (await db.execute(text(
            "SELECT email_address, provider, credentials_encrypted "
            "FROM email_accounts WHERE id = :id"
        ), {"id": account_id})).fetchone()
        acc_email = (acc.email_address if acc else "") or ""

        # The thread-status authority does the whole-thread determination + write
        # (over the SAME context, with the just-sent reply folded in). Outbound
        # trigger: the owner replied, so this may move a DONE thread.
        result = await recompute_thread_status(
            db, account_id, thread_id, trigger="outbound",
            about=about, acc_email=acc_email,
            pending_reply=(sent_body, sent_subject or "") if sent_body else None)
        await db.commit()
        if result is None:
            return
        _rz_status, new_cat = result

        # Reconcile the thread to a SINGLE conversation label (mutually exclusive,
        # inbox-zero parity): clear any stale Reply / Awaiting / FYI / Follow-up
        # across the thread and apply the new status label. Needs the provider.
        if not acc:
            return
        from acb_llm.key_store import get_key_store  # noqa: PLC0415
        store = get_key_store()
        creds = json.loads(store.decrypt(acc.credentials_encrypted))
        provider = _instantiate_provider(acc.provider, creds)
        if not await provider.authenticate():
            return
        await _reconcile_thread_labels(
            db, provider, account_id, thread_id, new_cat)
        if provider.credentials_dirty():
            await _persist_rotated_creds(db, store, account_id, provider)
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.mark_thread_replied_failed", error=str(exc)[:160])
    finally:
        await db.close()


async def _reconcile_labels_bg(
    account_id: str, thread_id: str, keep_label: str | None,
) -> None:
    """Background: instantiate the provider and collapse a thread's Reply Zero
    labels to ``keep_label`` (None clears all conversation + Follow-up labels).

    Used by Mark Done / Reopen so the provider + local labels match the new
    status — without this the status row alone moved the thread in our view but
    left the stale Reply / Awaiting / Follow-up labels behind on the provider.
    Best-effort."""
    if not thread_id:
        return
    db = await _get_db()
    try:
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
        await _reconcile_thread_labels(
            db, provider, account_id, thread_id, keep_label)
        if provider.credentials_dirty():
            await _persist_rotated_creds(db, store, account_id, provider)
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.reconcile_labels_bg_failed",
                     account_id=account_id, error=str(exc)[:160])
    finally:
        await db.close()


async def apply_thread_status_correction(
    account_id: str, thread_id: str, status_key: str,
) -> dict[str, Any]:
    """Force a thread's Reply Zero status to a user-corrected value (the Fix flow).

    Conversation status (Reply / Awaiting / FYI / Done) is re-derived from
    the full thread by the classifier, so a learned sender/subject pattern would be
    OVERRIDDEN — the only correction that sticks is to set the status directly and
    swap the labels. ``status_key`` is REPLY / AWAITING_REPLY / FYI / DONE
    (legacy TO_REPLY / ACTIONED still accepted).
    Best-effort; returns ``{ok, status, label}``."""
    rz_status, label = _THREAD_STATUS_MAP.get(
        _canon_status_key(status_key), ("", ""))
    if not rz_status or not thread_id:
        return {"ok": False}
    db = await _get_db()
    try:
        latest = (await db.execute(text(
            "SELECT id, received_at FROM email_messages "
            "WHERE account_id = :aid AND thread_id = :tid "
            "ORDER BY received_at DESC NULLS LAST LIMIT 1"
        ), {"aid": account_id, "tid": thread_id})).fetchone()
        await _upsert_thread_status(
            db, account_id, thread_id, rz_status,
            latest.id if latest else None,
            latest.received_at if latest else None, "Fix correction")
        await db.commit()
        # Best-effort: swap the provider/local labels to the corrected status.
        acc = (await db.execute(text(
            "SELECT provider, credentials_encrypted FROM email_accounts "
            "WHERE id = :id"
        ), {"id": account_id})).fetchone()
        if acc:
            from acb_llm.key_store import get_key_store  # noqa: PLC0415
            store = get_key_store()
            creds = json.loads(store.decrypt(acc.credentials_encrypted))
            provider = _instantiate_provider(acc.provider, creds)
            if await provider.authenticate():
                await _reconcile_thread_labels(
                    db, provider, account_id, thread_id, label)
                if provider.credentials_dirty():
                    await _persist_rotated_creds(db, store, account_id, provider)
                await db.commit()
        return {"ok": True, "status": rz_status, "label": label}
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.apply_status_correction_failed",
                     account_id=account_id, error=str(exc)[:160])
        return {"ok": False}
    finally:
        await db.close()


# How many newly-detected outbound replies (sent threads) get the full AI status
# determination + label swap per backfill cycle. Replies are bounded USER actions
# (you don't send hundreds a cycle), so this cap is generous. Threads past the cap
# are LEFT UNWRITTEN — NOT stamped a blind AWAITING — so they keep
# `existing[thread] != latest_id` and are re-tried next cycle until they get a
# real determination (newest-first, so the most recent drain first). Stamping a
# blind AWAITING here was the bug that showed concluded replies as "Awaiting".
_REPLY_DETERMINE_CAP = 40
# How many inbound gap threads get an engine match (classification) per cycle.
_BACKFILL_INBOUND_CAP = 25


async def _maybe_classify_threads(account_id: str) -> None:
    """Reply Zero BACKFILL: fill in per-thread status for threads the live rules
    pipeline hasn't classified yet — historical mail, accounts with auto-apply
    off, or anything the runner missed.

    Reuses the SAME rule engine as live classification, so Reply Zero stays a
    projection of the rules and never a parallel classifier.

    Sent-last GAP threads mean a NEW outbound message arrived — whether sent via
    Command Center OR the user's native email client. They get the SAME AI status
    determination + label swap as a CC-initiated reply (``_mark_thread_replied``),
    so a reply sent from Gmail/Outlook directly still reaches Awaiting/Done and
    loses its "Reply" label — inbox-zero handleOutboundMessage parity. This is
    capped per cycle; sent threads beyond the cap are left UNWRITTEN and re-tried
    next cycle (never blind-stamped AWAITING). Inbound-last gap threads are matched
    by the engine (which applies the Reply Zero pre-filter that keeps newsletters/
    broadcasts out of "Reply") and projected via the matched conversation-status
    rule (FYI when none matches). Touches threads whose latest message changed OR
    whose stored status is provisional ("· auto" — a prior LLM fallback), so a
    guessed AWAITING self-heals. Caps work per cycle. Best-effort (never raises)."""
    db = await _get_db()
    try:
        from gateway.routes.email.automation.engine import (  # noqa: PLC0415
            _match_email_to_rule,
            email_dict_from_row,
        )
        rows = (await db.execute(text(
            """WITH latest AS (
                 SELECT DISTINCT ON (thread_id) thread_id, id, subject,
                        from_address, to_addresses, cc_addresses, body_text,
                        snippet, folder, received_at
                 FROM email_messages
                 WHERE account_id = :aid AND thread_id IS NOT NULL
                   AND received_at > now() - interval '30 days'
                 ORDER BY thread_id, received_at DESC
               )
               SELECT * FROM latest ORDER BY received_at DESC LIMIT 200"""
        ), {"aid": account_id})).fetchall()
        if not rows:
            return
        # Carry last_message_id + reason so we can both (a) skip threads whose
        # latest message is unchanged, and (b) STILL re-determine a thread whose
        # stored status is PROVISIONAL — a "· auto" reason means a prior LLM
        # fallback guessed AWAITING. Those self-heal here instead of sticking.
        existing = {
            r.thread_id: (str(r.last_message_id), r.reason or "")
            for r in (await db.execute(text(
                "SELECT thread_id, last_message_id, reason "
                "FROM email_thread_status WHERE account_id = :aid"
            ), {"aid": account_id})).fetchall()
        }
        about, _sig = await _load_assistant_about(db, account_id)
        acc = (await db.execute(text(
            "SELECT email_address FROM email_accounts WHERE id = :id"
        ), {"id": account_id})).fetchone()
        self_email = (acc.email_address if acc else "") or ""
        extra_domains = await resolve_org_domains(db, account_id)

        gap_inbound = []
        sent_handled = 0
        for r in rows:
            prev = existing.get(r.thread_id)
            provisional = bool(prev) and prev[1].endswith("· auto")
            if prev and prev[0] == str(r.id) and not provisional:
                continue  # latest message unchanged + confidently classified
            folder = (r.folder or "").lower()
            if folder == "sent":
                # New outbound message (CC reply OR native-client reply) →
                # re-determine status with the AI and swap labels, exactly like a
                # CC send. Capped per cycle; threads past the cap are left
                # UNWRITTEN (not blind-AWAITING) so they retry next cycle.
                if sent_handled < _REPLY_DETERMINE_CAP:
                    await _mark_thread_replied(account_id, r.thread_id)
                    sent_handled += 1
                # else: overflow — leave it for the next cycle, never guess.
            elif folder == "inbox":
                gap_inbound.append(r)
        await db.commit()

        gap = gap_inbound[:_BACKFILL_INBOUND_CAP]  # cap engine work per cycle
        gap_attach = await _attachment_summaries(db, [r.id for r in gap])
        for r in gap:
            # extra_domains is a KEYWORD arg (positional lands it in self_name).
            email = email_dict_from_row(
                r, self_email, about, extra_domains=extra_domains,
                attachments=gap_attach.get(str(r.id), ""))
            match = await _match_email_to_rule(db, account_id, email)
            # Full-thread status determination (same parity as the live runner)
            # when the match is a conversation.
            matches = await resolve_conversation_status_matches(
                db, account_id, r, [match] if match else [])
            await project_reply_status_from_matches(db, account_id, r, matches)
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.classify_threads_failed",
                     account_id=account_id, error=str(exc)[:200])
    finally:
        await db.close()


async def _reclassify_reply_zero_job(account_id: str) -> None:
    """Rebuild an account's Reply Zero statuses from scratch with the current
    rules-based logic — used when the classifier changed (e.g. to clear threads
    that the old parallel classifier stale-labelled as needs-reply).

    Drops the DERIVED statuses (NEEDS_REPLY / AWAITING / FYI) but PRESERVES DONE,
    so a user's "Mark done" decisions survive a reclassify. Then runs the engine
    backfill a bounded number of times (each pass scans ≤200 threads and
    classifies ≤25 inbound, so this covers the whole recent window without
    unbounded LLM cost). Best-effort."""
    db = await _get_db()
    try:
        await db.execute(text(
            "DELETE FROM email_thread_status "
            "WHERE account_id = :aid AND status <> 'DONE'"
        ), {"aid": account_id})
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.reclassify_reset_failed",
                     account_id=account_id, error=str(exc)[:160])
        await db.close()
        return
    else:
        await db.close()
    # Each pass classifies the next batch of now-statusless threads.
    for _ in range(8):
        await _maybe_classify_threads(account_id)


class ThreadResolveRequest(BaseModel):
    account_id: str
    thread_id: str
    done: bool = True  # True = mark done (resolved); False = reopen


@router.post("/reply-zero/resolve")
async def resolve_thread(
    req: ThreadResolveRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Mark a thread done (inbox-zero's "Mark Done" / resolved=true) or reopen it.

    Done → status='DONE' (shows under the Done tab) and the provider/local labels
    are collapsed to "Done" (clearing stale Reply / Awaiting / Follow-up).
    Reopen → re-derive NEEDS_REPLY/AWAITING from the latest message's folder and
    swap the label back to Reply / Awaiting Reply."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        keep_label = "Done"
        if req.done:
            res = await db.execute(text(
                "UPDATE email_thread_status SET status = 'DONE', "
                "classified_at = now() "
                "WHERE account_id = :aid AND thread_id = :tid"
            ), {"aid": req.account_id, "tid": req.thread_id})
            if res.rowcount == 0:
                # Heuristic mode (no stored status yet) — create one as DONE.
                lm = (await db.execute(text(
                    "SELECT id, received_at FROM email_messages "
                    "WHERE account_id = :aid AND thread_id = :tid "
                    "ORDER BY received_at DESC LIMIT 1"
                ), {"aid": req.account_id, "tid": req.thread_id})).fetchone()
                await db.execute(text(
                    "INSERT INTO email_thread_status (account_id, thread_id, "
                    "status, last_message_id, last_message_at, reason) "
                    "VALUES (:aid, :tid, 'DONE', :lmid, :lmat, 'Marked done') "
                    "ON CONFLICT (account_id, thread_id) "
                    "DO UPDATE SET status = 'DONE', classified_at = now()"
                ), {"aid": req.account_id, "tid": req.thread_id,
                    "lmid": lm.id if lm else None,
                    "lmat": lm.received_at if lm else None})
        else:
            # Reopen: re-derive from the latest message's folder. Resolve the
            # latest message directly (don't rely on last_message_id, which may
            # be NULL) so the UPDATE always lands.
            lm = (await db.execute(text(
                "SELECT folder FROM email_messages "
                "WHERE account_id = :aid AND thread_id = :tid "
                "ORDER BY received_at DESC NULLS LAST LIMIT 1"
            ), {"aid": req.account_id, "tid": req.thread_id})).fetchone()
            new_status = "AWAITING" if (
                lm and (lm.folder or "").lower() == "sent") else "NEEDS_REPLY"
            keep_label = (
                "Awaiting Reply" if new_status == "AWAITING" else "Reply")
            await db.execute(text(
                "UPDATE email_thread_status SET status = :st, classified_at = now() "
                "WHERE account_id = :aid AND thread_id = :tid"
            ), {"st": new_status, "aid": req.account_id, "tid": req.thread_id})
        await db.commit()
        # Collapse the provider/local labels to match the new status (clears the
        # stale Reply / Awaiting / Follow-up that the status update alone left).
        background.add_task(
            _reconcile_labels_bg, req.account_id, req.thread_id, keep_label)
        return {"ok": True, "thread_id": req.thread_id, "done": req.done}
    finally:
        await db.close()


class ReplyZeroReclassifyRequest(BaseModel):
    account_id: str


@router.post("/reply-zero/reclassify")
async def reclassify_reply_zero(
    req: ReplyZeroReclassifyRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Rebuild Reply Zero from scratch with the current rules-based logic.

    Clears the derived statuses (Reply / Awaiting / FYI) — preserving threads
    you've marked Done — then re-runs classification through the rules engine.
    Useful after the classifier changed. Runs in the background; poll
    GET /email/reply-zero to see the rebuilt buckets."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
    finally:
        await db.close()
    background.add_task(_reclassify_reply_zero_job, req.account_id)
    return {"scheduled": True}


@router.get("/reply-zero")
async def reply_zero(
    background: BackgroundTasks,
    account_id: str = Query(...),
    type: str = Query("needs_reply"),  # needs_reply | awaiting | done
    limit: int = Query(50, ge=1, le=200),
    user: UserContext = Depends(get_current_user),
):
    """Threads in a Reply Zero bucket, read straight from the stored,
    rules-derived status (``email_thread_status``).

    Reply Zero is a PROJECTION of the rules pipeline — a thread shows up only once
    a rule has classified it. There is deliberately NO inbox fallback (the old
    "show every inbox thread until the first pass runs" behaviour is what made
    every email appear under "Reply"). On a cold account with nothing
    classified yet we kick off a one-off background backfill so the next poll is
    populated; an existing draft for the thread is surfaced (``draft_id``) so the
    UI offers "View draft" instead of drafting a second reply."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        want = {"awaiting": "AWAITING", "done": "DONE"}.get(type, "NEEDS_REPLY")
        # Trash is hidden from every bucket; archiving a thread also drops it from
        # the ACTIVE buckets ("archived = off my reply queue") while it still shows
        # under Done. (Controlled literal — safe to inline.)
        excluded = ("'trash', 'archive'"
                    if want in ("NEEDS_REPLY", "AWAITING") else "'trash'")
        rows = (await db.execute(text(
            f"""SELECT ts.thread_id, ts.reason, ts.last_message_at,
                      em.id, em.subject, em.from_address, em.is_read,
                      d.id AS draft_id, d.body_text AS draft_text
               FROM email_thread_status ts
               JOIN email_messages em ON em.id = ts.last_message_id
               LEFT JOIN LATERAL (
                 SELECT id, body_text FROM email_messages dm
                 WHERE dm.account_id = ts.account_id
                   AND dm.thread_id = ts.thread_id
                   AND LOWER(COALESCE(dm.folder, '')) IN ('drafts', 'draft')
                 ORDER BY dm.updated_at DESC NULLS LAST, dm.received_at DESC
                 LIMIT 1
               ) d ON true
               WHERE ts.account_id = :aid AND ts.status = :st
                 -- Hide trashed (all buckets) / archived (active buckets) threads.
                 AND LOWER(COALESCE(em.folder, '')) NOT IN ({excluded})
               ORDER BY ts.last_message_at DESC NULLS LAST LIMIT :limit"""
        ), {"aid": account_id, "st": want, "limit": limit})).fetchall()

        # Cold start: nothing classified yet → schedule a one-off backfill so the
        # next poll fills in, instead of the old whole-inbox fallback.
        if not rows:
            has_any = (await db.execute(text(
                "SELECT 1 FROM email_thread_status WHERE account_id = :aid LIMIT 1"
            ), {"aid": account_id})).fetchone()
            if has_any is None:
                background.add_task(_maybe_classify_threads, account_id)

        fu_cutoff = None
        if type == "awaiting":
            fu_row = (await db.execute(text(
                "SELECT follow_up_awaiting_days, follow_up_days "
                "FROM email_assistant_settings WHERE account_id = :aid"
            ), {"aid": account_id})).fetchone()
            fu_days = 0
            if fu_row:
                fu_days = (getattr(fu_row, "follow_up_awaiting_days", 0)
                           or getattr(fu_row, "follow_up_days", 0) or 0)
            # Use the SAME business-day window as the reminder job so the badge
            # appears exactly when the "Follow-up" label / nudge fires — not a
            # day or two early because a weekend was counted.
            if fu_days > 0:
                fu_cutoff = _business_days_cutoff(float(fu_days))
        now = datetime.now(timezone.utc)
        out = []
        for r in rows:
            frm = _addr_dict(r.from_address)
            days = (now - r.last_message_at).days if r.last_message_at else None
            out.append({
                "thread_id": r.thread_id, "message_id": str(r.id),
                "subject": r.subject or "(no subject)",
                "from": frm.get("name") or frm.get("email", ""),
                "from_email": frm.get("email", ""),
                "received_at": (
                    r.last_message_at.isoformat() if r.last_message_at else None
                ),
                "is_read": r.is_read, "reason": r.reason or "",
                "awaiting_days": days,
                "needs_follow_up": bool(
                    fu_cutoff and r.last_message_at is not None
                    and r.last_message_at < fu_cutoff),
                # An existing draft in the thread (auto-drafted or saved) so the
                # UI shows "View draft" rather than drafting another reply.
                "draft_id": str(r.draft_id) if r.draft_id else None,
                "draft_preview": (r.draft_text or "") if r.draft_id else None,
            })
        return {"threads": out, "type": type}
    finally:
        await db.close()


class FollowUpScanRequest(BaseModel):
    account_id: str


@router.post("/follow-ups/scan")
async def scan_follow_ups(
    req: FollowUpScanRequest,
    user: UserContext = Depends(get_current_user),
):
    """On-demand "Find follow-ups" (inbox-zero parity): scan now for threads
    waiting too long for a reply, label them "Follow-up", and — when auto-draft
    is on — draft nudges. Returns ``{configured, scanned, labeled, drafted}``.

    Respects the configured reminder windows; if neither is set, returns
    ``configured: false`` so the UI can prompt the user to set them first."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
    finally:
        await db.close()
    return await _maybe_send_follow_up_reminders(req.account_id)


def _business_days_cutoff(days: float) -> datetime:
    """UTC timestamp ``days`` business days before now (weekends skipped) — the
    follow-up window inbox-zero uses so a Friday email isn't chased on Sunday.
    The whole-day part steps over Mon–Fri; any fraction is applied as hours."""
    d = datetime.now(timezone.utc)
    whole = int(days)
    stepped = 0
    while stepped < whole:
        d -= timedelta(days=1)
        if d.weekday() < 5:  # Mon–Fri
            stepped += 1
    frac = days - whole
    if frac > 0:
        d -= timedelta(hours=frac * 24)
    return d


async def _maybe_send_follow_up_reminders(account_id: str) -> dict[str, int | bool]:
    """Label (and optionally draft a nudge for) threads waiting too long for a
    reply. Runs both on the sync loop (background) and on demand via the
    "Find follow-ups" button (POST /email/follow-ups/scan).

    AWAITING  → they haven't replied to us after follow_up_awaiting_days.
    NEEDS_REPLY → we haven't replied after follow_up_needs_reply_days.
    Each qualifying thread's latest message is labelled "Follow-up"; when
    follow_up_auto_draft is on, AWAITING threads also get a draft nudge.
    Idempotent via email_thread_status.follow_up_reminded_at.

    Returns ``{configured, scanned, labeled, drafted}`` so the UI can report the
    scan outcome (the scheduler ignores the return value).
    """
    result: dict[str, int | bool] = {
        "configured": False, "scanned": 0, "labeled": 0, "drafted": 0,
    }
    db = await _get_db()
    try:
        srow = (await db.execute(text(
            """SELECT follow_up_awaiting_days, follow_up_needs_reply_days,
                      follow_up_auto_draft
               FROM email_assistant_settings WHERE account_id = :aid"""
        ), {"aid": account_id})).fetchone()
        if not srow:
            return result
        awaiting_days = float(getattr(srow, "follow_up_awaiting_days", 0) or 0)
        needs_days = float(getattr(srow, "follow_up_needs_reply_days", 0) or 0)
        auto_draft = bool(getattr(srow, "follow_up_auto_draft", False))
        if awaiting_days <= 0 and needs_days <= 0:
            return result
        result["configured"] = True

        # Business-day windows (inbox-zero parity) — don't chase over the weekend.
        cutoff_aw = _business_days_cutoff(awaiting_days) if awaiting_days > 0 else None
        cutoff_nd = _business_days_cutoff(needs_days) if needs_days > 0 else None

        rows = (await db.execute(text(
            """SELECT ts.thread_id, ts.status, ts.last_message_id,
                      em.provider_message_id, em.subject, em.from_address,
                      em.to_addresses, em.body_text, em.snippet
               FROM email_thread_status ts
               LEFT JOIN email_messages em ON ts.last_message_id = em.id
               WHERE ts.account_id = :aid
                 AND ts.follow_up_reminded_at IS NULL
                 AND (
                   (ts.status = 'AWAITING' AND :caw IS NOT NULL
                    AND ts.last_message_at < :caw)
                   OR (ts.status = 'NEEDS_REPLY' AND :cnd IS NOT NULL
                    AND ts.last_message_at < :cnd)
                 )
               LIMIT 50"""
        ), {"aid": account_id, "caw": cutoff_aw, "cnd": cutoff_nd})).fetchall()
        if not rows:
            return result

        acc = (await db.execute(text(
            "SELECT provider, credentials_encrypted, user_id "
            "FROM email_accounts WHERE id = :id"
        ), {"id": account_id})).fetchone()
        if not acc:
            return result
        from acb_llm.key_store import get_key_store  # noqa: PLC0415
        store = get_key_store()
        creds = json.loads(store.decrypt(acc.credentials_encrypted))
        provider = _instantiate_provider(acc.provider, creds)
        if not await provider.authenticate():
            return result
        about, signature = await _load_assistant_about(db, account_id)
        from gateway.routes.email.automation.assistant import (  # noqa: PLC0415
            _account_models,
        )
        fu_model = (await _account_models(db, account_id))["draft"]

        for r in rows:
            mark = lambda: db.execute(text(  # noqa: E731
                "UPDATE email_thread_status SET follow_up_reminded_at = now() "
                "WHERE account_id = :aid AND thread_id = :tid"
            ), {"aid": account_id, "tid": r.thread_id})
            if not r.provider_message_id:
                await mark()
                continue
            try:
                await provider.set_labels(
                    r.provider_message_id, add=["Follow-up"], remove=[])
                result["labeled"] += 1
            except Exception:  # noqa: BLE001
                pass
            if auto_draft and r.status == "AWAITING":
                try:
                    to_list = r.to_addresses if isinstance(r.to_addresses, list) \
                        else json.loads(r.to_addresses or "[]")
                    to = (to_list[0].get("email") if to_list else "") or ""
                    if to:
                        email = {
                            "subject": r.subject or "",
                            "from": to,  # nudging the recipient of our last msg
                            "body": r.body_text or r.snippet or "",
                            "thread_id": r.thread_id or "",
                        }
                        body = await _agent_draft_reply(
                            email, about, signature, acc.user_id, use_agent=True,
                            follow_up=True, model=fu_model, account_id=account_id,
                        )
                        # Confidence gate (defense-in-depth): don't persist a
                        # declined / empty draft as a real provider draft.
                        if not _is_no_draft(body):
                            await provider.create_draft(
                                to=[to],
                                subject=f"Re: {r.subject or ''}",
                                body_text=body,
                                reply_to_message_id=r.provider_message_id,
                                thread_id=r.thread_id or None,
                            )
                            result["drafted"] += 1
                except Exception as exc:  # noqa: BLE001
                    _log.warning("email.follow_up_draft_failed",
                                 account_id=account_id, error=str(exc)[:160])
            await mark()

        result["scanned"] = len(rows)
        await _persist_rotated_creds(db, store, account_id, provider)
        await db.commit()
        _log.info("email.follow_ups_processed", account_id=account_id,
                  count=len(rows))
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.follow_up_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()
    return result
