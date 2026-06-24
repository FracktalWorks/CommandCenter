"""Automation · Reply Zero — needs-reply classification, the reply-zero views,
follow-up reminders, and the inbox AI chat/quick-action endpoints."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from gateway.routes.email.automation.assistant import _load_assistant_about
from gateway.routes.email.automation.drafting import _agent_draft_reply
from gateway.routes.email.core import (
    _assert_account_owner,
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

    # Build conversation history for the agent
    history = req.messages[:-1] if req.messages else []
    conversation_context = ""
    if history:
        history_lines = []
        for m in history[-10:]:  # keep last 10 for context
            role = m.get("role", "unknown")
            content = m.get("content", "")[:500]
            history_lines.append(f"[{role}]: {content}")
        conversation_context = "## Conversation history\n" + "\n".join(history_lines)

    # Build enriched payload
    payload: dict[str, Any] = {
        "message": last_user_msg or "Help me with my email",
        "user_query": last_user_msg,
        "conversation_history": conversation_context,
        "account_id": req.account_id,
        "email_context_id": req.email_context_id,
        "user_email": user_id,
    }

    # If an email is in context, fetch its full content for the agent
    if req.email_context_id:
        try:
            db = await _get_db()
            result = await db.execute(
                text(
                    """SELECT em.subject, em.body_text, em.from_address,
                              em.received_at
                       FROM email_messages em
                       JOIN email_accounts ea ON em.account_id = ea.id
                       WHERE em.id = :id AND ea.user_id = :uid"""
                ),
                {"id": req.email_context_id, "uid": user.email or "anonymous"},
            )
            email_row = result.fetchone()
            if email_row:
                from_data = email_row.from_address
                if isinstance(from_data, str):
                    from_data = json.loads(from_data)
                from_name = from_data.get("name", "") if isinstance(from_data, dict) else ""
                from_email = from_data.get("email", "") if isinstance(from_data, dict) else ""
                payload["current_email"] = {
                    "id": req.email_context_id,
                    "subject": email_row.subject,
                    "body": (email_row.body_text or "")[:5000],
                    "from": f"{from_name} <{from_email}>",
                    "date": str(email_row.received_at),
                }
            await db.close()
        except Exception:  # noqa: BLE001
            pass

    # ── Resolve which LiteLLM tier the email CHAT should use (per-account) ──
    # The chat panel uses its own chat_model setting (default tier-balanced),
    # independent of rule evaluation and draft writing.
    chat_model = "tier-balanced"
    if req.account_id:
        try:
            from gateway.routes.email.automation.assistant import (  # noqa: PLC0415
                _account_models)
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


async def _llm_needs_reply(items: list[dict[str, str]]) -> dict[int, dict[str, Any]]:
    """Classify which inbound emails actually need a personal reply.

    items: [{subject, from, body}]. Returns {index: {"needs": bool,
    "reason": str}}; empty on LLM failure (callers default to needs=True).
    """
    if not items:
        return {}
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        listing = "\n\n".join(
            f"{i}. From: {it['from']}\nSubject: {it['subject']}\n"
            f"Body: {(it['body'] or '')[:800]}"
            for i, it in enumerate(items)
        )
        sys_prompt = (
            "For each email decide if it NEEDS a personal reply from the "
            "recipient — a real person asking a question, making a request, or "
            "expecting a response — versus FYI / automated / no-action mail "
            "(newsletters, notifications, receipts, marketing, confirmations, "
            "calendar invites). Respond ONLY with a JSON object "
            '{"results": [{"index": <n>, "needs_reply": <bool>, '
            '"reason": "<short why>"}]}.'
        )
        # Classification → fast tier. JSON-forced (object wrapper required by
        # json_object mode); generous budget so a batch isn't truncated.
        resp, _ = await acompletion_with_fallback(
            model="tier-fast",
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": listing}],
            temperature=0, max_tokens=2000,
            response_format={"type": "json_object"},
        )
        data = _safe_json(resp.choices[0].message.content or "")
        rows = data.get("results") if isinstance(data, dict) else (
            data if isinstance(data, list) else None)
        out: dict[int, dict[str, Any]] = {}
        if isinstance(rows, list):
            for d in rows:
                if not isinstance(d, dict):
                    continue
                idx = d.get("index")
                if isinstance(idx, int) and 0 <= idx < len(items):
                    out[idx] = {"needs": bool(d.get("needs_reply")),
                                "reason": str(d.get("reason", ""))[:200]}
        return out
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.needs_reply_failed", error=str(exc)[:200])
        return {}


async def _upsert_thread_status(
    db: Any, account_id: str, thread_id: str, status: str,
    msg_id: Any, msg_at: Any, reason: str,
) -> None:
    await db.execute(text(
        """INSERT INTO email_thread_status
             (account_id, thread_id, status, last_message_id, last_message_at,
              reason, classified_at)
           VALUES (:aid, :tid, :st, :mid, :mat, :reason, now())
           ON CONFLICT (account_id, thread_id) DO UPDATE SET
             status = EXCLUDED.status,
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
_THREAD_STATUS_MAP = {
    "TO_REPLY": ("NEEDS_REPLY", "To Reply"),
    "AWAITING_REPLY": ("AWAITING", "Awaiting Reply"),
    "ACTIONED": ("DONE", "Actioned"),
    "FYI": ("FYI", "FYI"),
}


async def _llm_determine_thread_status(
    thread_text: str, user_email: str, about: str, *, user_sent_last: bool = True,
) -> str:
    """Determine an email thread's status from the user's perspective — a faithful
    port of inbox-zero's aiDetermineThreadStatus. Returns TO_REPLY /
    AWAITING_REPLY / ACTIONED (and FYI only when the user did NOT send last).
    Defaults to AWAITING_REPLY (the user just replied) on any failure."""
    fallback = "AWAITING_REPLY" if user_sent_last else "FYI"
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        fyi_state = "" if user_sent_last else "\n* FYI - No reply needed"
        fyi_opt = "" if user_sent_last else "FYI, "
        fyi_rules = "" if user_sent_last else (
            "\n- FYI: ONLY when there are absolutely no questions, requests, or "
            "pending actions anywhere in the thread, and the user RECEIVED the "
            "last message.")
        last_rule = (
            "\n- Because the user sent the last email, FYI is NOT an option: "
            "choose AWAITING_REPLY if waiting on a response, or ACTIONED if the "
            "thread is complete." if user_sent_last else "")
        sys_prompt = (
            "You analyze an email thread and determine its current status from "
            "the user's perspective. It is in ONE of these mutually exclusive "
            "states:\n"
            "* TO_REPLY - the user needs to reply\n"
            "* AWAITING_REPLY - waiting for the other person to respond/act"
            f"{fyi_state}\n* ACTIONED - the thread is complete\n\n"
            "CRITERIA:\n"
            "- TO_REPLY: someone asked the user a direct question or requested "
            "info/action and the user hasn't addressed it; OR the user promised "
            "a follow-up/deliverable and hasn't sent it. A clarifying question "
            "that got answered while a commitment is still pending is still "
            "TO_REPLY.\n"
            "- AWAITING_REPLY: the ball is in the OTHER person's court — the user "
            "asked/requested and is still waiting, or someone else owes an "
            "action. If the user's request was already fulfilled, they are NO "
            "longer awaiting.\n"
            "- ACTIONED: all questions answered and requests fulfilled, the "
            "conversation concluded, or the user sent info/recommendations and "
            "isn't waiting for anything. Taking ownership ('I'll handle it') "
            "fulfils a request unless it promises a later deliverable."
            f"{fyi_rules}\n\n"
            "RULES: scan the ENTIRE thread, not just the latest message; an "
            "earlier unanswered question/request still governs. If SOMEONE ELSE "
            "promised something → AWAITING_REPLY; if the USER promised a future "
            "reply/deliverable → TO_REPLY."
            f"{last_rule}\n\n"
            'Respond with ONLY a JSON object: {"status": "<one of TO_REPLY, '
            f'AWAITING_REPLY, {fyi_opt}ACTIONED>", "rationale": "<one line>"}}.'
        )
        ctx = f"You are acting on behalf of: {user_email}\n"
        if (about or "").strip():
            ctx += f"{about.strip()[:1200]}\n"
        user_prompt = (
            f"{ctx}\nEmail thread (oldest to newest):\n{thread_text[:6000]}\n\n"
            "Determine the current status of this thread."
        )
        resp, _ = await acompletion_with_fallback(
            model="tier-fast",
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            temperature=0, max_tokens=500,
            response_format={"type": "json_object"},
        )
        data = _safe_json(resp.choices[0].message.content or "")
        st = ((data.get("status") if isinstance(data, dict) else "") or "")
        st = st.strip().upper()
        allowed = {"TO_REPLY", "AWAITING_REPLY", "ACTIONED"}
        if not user_sent_last:
            allowed.add("FYI")
        return st if st in allowed else fallback
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.determine_status_failed", error=str(exc)[:160])
        return fallback


def _fmt_thread_msg(r: Any) -> str:
    frm = r.from_address if isinstance(r.from_address, dict) \
        else json.loads(r.from_address or "{}")
    sender = frm.get("name") or frm.get("email") or "?"
    direction = "(you sent)" if (r.folder or "").lower() == "sent" else ""
    body = (r.body_text or r.snippet or "").strip()
    return f"From: {sender} {direction}\nSubject: {r.subject or ''}\n{body[:1500]}"


async def _mark_thread_replied(account_id: str, thread_id: str) -> None:
    """After the user sends a reply, re-determine the thread's status with the
    AI (exact inbox-zero aiDetermineThreadStatus parity) and relabel: set the
    Reply Zero status and swap the old status category for the new one on the
    inbound messages. Since the user just sent, FYI is excluded — the AI picks
    AWAITING_REPLY (waiting on them) or ACTIONED (done). Best-effort."""
    if not thread_id:
        return
    db = await _get_db()
    try:
        rows = (await db.execute(text(
            """SELECT id, provider_message_id, from_address, subject, body_text,
                      snippet, categories, folder, received_at
               FROM email_messages
               WHERE account_id = :aid AND thread_id = :tid
               ORDER BY received_at ASC NULLS FIRST"""
        ), {"aid": account_id, "tid": thread_id})).fetchall()
        if not rows:
            return
        latest = rows[-1]
        about, _sig = await _load_assistant_about(db, account_id)
        acc = (await db.execute(text(
            "SELECT email_address, provider, credentials_encrypted "
            "FROM email_accounts WHERE id = :id"
        ), {"id": account_id})).fetchone()
        acc_email = (acc.email_address if acc else "") or ""

        thread_text = "\n\n---\n\n".join(_fmt_thread_msg(r) for r in rows)
        status = await _llm_determine_thread_status(
            thread_text, acc_email, about, user_sent_last=True)
        rz_status, new_cat = _THREAD_STATUS_MAP.get(
            status, ("AWAITING", "Awaiting Reply"))

        await _upsert_thread_status(
            db, account_id, thread_id, rz_status, latest.id,
            latest.received_at, f"Replied — {status}")
        await db.commit()

        # Still needs the user's reply (a pending commitment) → leave labels.
        if status == "TO_REPLY":
            return

        # Swap the "To Reply" category → the new status category on inbound
        # messages that carry it, upstream + locally (best-effort).
        targets = [
            r for r in rows
            if (r.folder or "").lower() != "sent"
            and "To Reply" in list(r.categories or [])
        ]
        if not targets or not acc:
            return
        from acb_llm.key_store import get_key_store  # noqa: PLC0415
        store = get_key_store()
        creds = json.loads(store.decrypt(acc.credentials_encrypted))
        provider = _instantiate_provider(acc.provider, creds)
        if not await provider.authenticate():
            return
        for r in targets:
            try:
                await provider.set_labels(
                    r.provider_message_id, add=[new_cat], remove=["To Reply"])
                await db.execute(text(
                    """UPDATE email_messages SET categories = CASE
                         WHEN :newcat = ANY(array_remove(categories, 'To Reply'))
                           THEN array_remove(categories, 'To Reply')
                         ELSE array_append(
                                array_remove(categories, 'To Reply'), :newcat)
                       END, updated_at = now() WHERE id = :id"""
                ), {"id": r.id, "newcat": new_cat})
            except Exception:  # noqa: BLE001 — one bad message shouldn't abort
                continue
        if provider.credentials_dirty():
            await _persist_rotated_creds(db, store, account_id, provider)
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.mark_thread_replied_failed", error=str(exc)[:160])
    finally:
        await db.close()


async def _maybe_classify_threads(account_id: str) -> None:
    """Reply Zero: store a per-thread status (NEEDS_REPLY / FYI / AWAITING).

    Sent-last threads are AWAITING; inbound-last threads are AI-classified into
    NEEDS_REPLY vs FYI. Only re-classifies a thread when its latest message
    changed; caps the LLM work per cycle. Best-effort (never raises to caller)."""
    db = await _get_db()
    try:
        rows = (await db.execute(text(
            """WITH latest AS (
                 SELECT DISTINCT ON (thread_id) thread_id, id, subject,
                        from_address, body_text, snippet, folder, received_at
                 FROM email_messages
                 WHERE account_id = :aid AND thread_id IS NOT NULL
                   AND received_at > now() - interval '30 days'
                 ORDER BY thread_id, received_at DESC
               )
               SELECT * FROM latest ORDER BY received_at DESC LIMIT 200"""
        ), {"aid": account_id})).fetchall()
        if not rows:
            return
        existing = {
            r.thread_id: str(r.last_message_id)
            for r in (await db.execute(text(
                "SELECT thread_id, last_message_id FROM email_thread_status "
                "WHERE account_id = :aid"
            ), {"aid": account_id})).fetchall()
        }
        to_classify = []
        for r in rows:
            if existing.get(r.thread_id) == str(r.id):
                continue  # latest message unchanged → status still valid
            folder = (r.folder or "").lower()
            if folder == "sent":
                await _upsert_thread_status(
                    db, account_id, r.thread_id, "AWAITING", r.id,
                    r.received_at, "")
            elif folder == "inbox":
                to_classify.append(r)
        await db.commit()

        to_classify = to_classify[:25]  # cap LLM work per cycle
        for i in range(0, len(to_classify), 10):
            batch = to_classify[i:i + 10]
            items = [
                {"subject": r.subject or "",
                 "from": _addr_dict(r.from_address).get("email", ""),
                 "body": r.body_text or r.snippet or ""}
                for r in batch
            ]
            verdicts = await _llm_needs_reply(items)
            for j, r in enumerate(batch):
                v = verdicts.get(j, {"needs": True, "reason": ""})
                status = "NEEDS_REPLY" if v["needs"] else "FYI"
                await _upsert_thread_status(
                    db, account_id, r.thread_id, status, r.id,
                    r.received_at, v.get("reason", ""))
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.classify_threads_failed",
                     account_id=account_id, error=str(exc)[:200])
    finally:
        await db.close()


class ThreadResolveRequest(BaseModel):
    account_id: str
    thread_id: str
    done: bool = True  # True = mark done (resolved); False = reopen


@router.post("/reply-zero/resolve")
async def resolve_thread(
    req: ThreadResolveRequest,
    user: UserContext = Depends(get_current_user),
):
    """Mark a thread done (inbox-zero's "Mark Done" / resolved=true) or reopen it.

    Done → status='DONE' (shows under the Done tab). Reopen → re-derive
    NEEDS_REPLY/AWAITING from the latest message's folder."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
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
            await db.execute(text(
                "UPDATE email_thread_status SET status = :st, classified_at = now() "
                "WHERE account_id = :aid AND thread_id = :tid"
            ), {"st": new_status, "aid": req.account_id, "tid": req.thread_id})
        await db.commit()
        return {"ok": True, "thread_id": req.thread_id, "done": req.done}
    finally:
        await db.close()


@router.get("/reply-zero")
async def reply_zero(
    account_id: str = Query(...),
    type: str = Query("needs_reply"),  # needs_reply | awaiting
    limit: int = Query(50, ge=1, le=200),
    user: UserContext = Depends(get_current_user),
):
    """Threads that need a reply or are awaiting one. Prefers the stored,
    AI-classified status (Reply Zero); falls back to the folder heuristic until
    the first classification pass has run."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        has_status = (await db.execute(text(
            "SELECT 1 FROM email_thread_status WHERE account_id = :aid LIMIT 1"
        ), {"aid": account_id})).fetchone() is not None

        if has_status:
            want = {"awaiting": "AWAITING", "done": "DONE"}.get(
                type, "NEEDS_REPLY")
            rows = (await db.execute(text(
                """SELECT ts.thread_id, ts.reason, ts.last_message_at,
                          em.id, em.subject, em.from_address, em.is_read
                   FROM email_thread_status ts
                   JOIN email_messages em ON em.id = ts.last_message_id
                   WHERE ts.account_id = :aid AND ts.status = :st
                   ORDER BY ts.last_message_at DESC NULLS LAST LIMIT :limit"""
            ), {"aid": account_id, "st": want, "limit": limit})).fetchall()
            fu_days = 0
            if type == "awaiting":
                fu_row = (await db.execute(text(
                    "SELECT follow_up_days FROM email_assistant_settings "
                    "WHERE account_id = :aid"
                ), {"aid": account_id})).fetchone()
                fu_days = (fu_row.follow_up_days if fu_row else 0) or 0
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
                        fu_days and days is not None and days >= fu_days),
                })
            return {"threads": out, "type": type}

        # No folder heuristic for "done" — it only exists once a thread has been
        # explicitly resolved (a stored status).
        if type == "done":
            return {"threads": [], "type": type}

        # Fallback: folder heuristic (before the first classification pass).
        folder = "sent" if type == "awaiting" else "inbox"
        rows = (await db.execute(text(
            """WITH latest AS (
                 SELECT DISTINCT ON (thread_id)
                        thread_id, id, subject, from_address, folder,
                        received_at, is_read
                 FROM email_messages
                 WHERE account_id = :aid AND thread_id IS NOT NULL
                 ORDER BY thread_id, received_at DESC
               )
               SELECT thread_id, id, subject, from_address, received_at, is_read
               FROM latest WHERE LOWER(folder) = :folder
               ORDER BY received_at DESC LIMIT :limit"""
        ), {"aid": account_id, "folder": folder, "limit": limit})).fetchall()
        out = []
        for r in rows:
            frm = _addr_dict(r.from_address)
            out.append({
                "thread_id": r.thread_id, "message_id": str(r.id),
                "subject": r.subject or "(no subject)",
                "from": frm.get("name") or frm.get("email", ""),
                "from_email": frm.get("email", ""),
                "received_at": r.received_at.isoformat() if r.received_at else None,
                "is_read": r.is_read, "reason": "",
                "awaiting_days": None, "needs_follow_up": False,
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
                            model=fu_model,
                        )
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
