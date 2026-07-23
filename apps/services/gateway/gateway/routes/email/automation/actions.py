"""Automation · actions — executing a matched rule's actions on the mailbox.

The single label writer (``apply_label`` / ``remove_label`` — provider FIRST,
then the local mirror), the Fix correction that reuses it, and the rule-action
dispatcher ``_apply_rule_actions`` with its helpers (sensitive-content guard,
action attachments, ``{{...}}`` template fill). Moved out of ``runner.py``
(2.3 split): these are the mailbox-mutating MECHANICS, distinct from the jobs
and HTTP routes that decide when to run them.

``runner`` re-exports every name here, so lazy importers (the cleaner's sweep,
senders, rules) and tests keep addressing the runner seam.
"""

from __future__ import annotations

import re
from typing import Any

import httpx
from gateway.routes.email.automation.drafting import (
    _agent_draft_reply,
    _build_reply_context,
    _fetch_reply_memories,
    _fetch_sender_reply_examples,
    _fetch_thread_context,
    _is_no_draft,
    _resolve_existing_thread_draft,
    _store_ai_draft,
    _upsert_local_draft,
)
from gateway.routes.email.core import (
    RESERVED_INDICATORS,
    _attachment_summaries,
    _log,
    _provider_for_message,
)
from sqlalchemy import text


async def apply_label(
    db: Any, provider: Any, message_id: str, provider_msg_id: str, label: str,
) -> None:
    """THE way a category label gets onto a message. One writer, two surfaces.

    Writes the provider FIRST, then mirrors into ``email_messages.categories``
    so the viewer shows the chip immediately instead of waiting for the next
    upstream sync. Both halves matter:

    * local-only would be erased on the next re-sync, because providers that
      round-trip labels are authoritative (see EmailMessage.categories_
      authoritative) — and ``rules_processed_at`` is already stamped, so the
      rules would never re-apply it;
    * provider-only leaves the label invisible in-app until a sync catches up.

    The mirror is an atomic append-if-absent on the TEXT[] (race-free, no
    read-modify-write). Every categorizer — the rule engine's LABEL action and
    the uncategorized-inbox sweep — goes through here, so there is exactly one
    place that decides what "applying a label" means.
    """
    lbl = (label or "").strip()
    if not lbl:
        return
    if lbl.lower() in RESERVED_INDICATORS:
        # "Uncategorized" is the ABSENCE of a category, not a category — an
        # AI-resolved label or a hand-authored rule could still produce it,
        # and writing it (provider or mirror) would make the state permanent.
        _log.warning("email.apply_label_reserved_indicator",
                     message_id=message_id, label=lbl)
        return
    if provider is not None and provider_msg_id:
        await provider.set_labels(provider_msg_id, add=[lbl], remove=[])
    await db.execute(text(
        "UPDATE email_messages SET categories = "
        "CASE WHEN :lbl = ANY(categories) THEN categories "
        "ELSE array_append(categories, :lbl) END, "
        "updated_at = now() WHERE id = :id"
    ), {"id": message_id, "lbl": lbl})


async def remove_label(
    db: Any, provider: Any, message_id: str, provider_msg_id: str, label: str,
) -> None:
    """The mirror image of ``apply_label``: strip ONE category off a message.

    Same one-writer discipline — provider FIRST (so an authoritative round-trip
    provider like Outlook doesn't re-add it on the next sync), then the local
    ``categories`` mirror via a race-free ``array_remove``. This is what makes a
    Fix correction visible on the message it was corrected from, not just on
    future mail.
    """
    lbl = (label or "").strip()
    if not lbl:
        return
    if provider is not None and provider_msg_id:
        await provider.set_labels(provider_msg_id, add=[], remove=[lbl])
    await db.execute(text(
        "UPDATE email_messages SET categories = array_remove(categories, :lbl), "
        "updated_at = now() WHERE id = :id"
    ), {"id": message_id, "lbl": lbl})


async def _rule_label_values(db: Any, rule_id: str) -> list[str]:
    """The category label(s) a rule's LABEL action applies — the exact strings
    the undo path removes, so a Fix strips precisely what the rule put on."""
    rows = (await db.execute(text(
        "SELECT label FROM email_actions WHERE rule_id = :rid "
        "AND type = 'LABEL' AND label IS NOT NULL"
    ), {"rid": str(rule_id)})).fetchall()
    return [r.label for r in rows if r.label]


async def correct_applied_labels(
    db: Any, account_id: str, message_id: str, owner: str, *,
    remove_rule_ids: list[str], add_rule_id: str | None = None,
) -> dict[str, list[str]]:
    """Make a Fix correction show on the message it came from: strip the label(s)
    the wrongly-matched cleanup rules applied, and — when the correction names a
    cleanup rule — apply that rule's label instead.

    Reuses the one-writer ``remove_label``/``apply_label`` (provider-first), so
    the fix sticks across the next re-sync. Best-effort and self-contained: a
    provider failure updates the local mirror and returns what it managed, never
    unwinding what ``rule_feedback`` already taught."""
    provider: Any = None
    pmid = ""
    try:
        provider, pmid, _aid, _store = await _provider_for_message(
            db, message_id, owner)
        if provider is not None and not await provider.authenticate():
            provider = None  # local-mirror only; can't reach the provider
    except Exception:  # noqa: BLE001
        provider, pmid = None, ""

    add_labels = (await _rule_label_values(db, add_rule_id)
                  if add_rule_id else [])
    to_remove: set[str] = set()
    for rid in remove_rule_ids:
        if rid:
            to_remove.update(await _rule_label_values(db, rid))
    # Never strip a label we're about to (re-)apply as the correct one.
    to_remove -= set(add_labels)

    removed: list[str] = []
    for lbl in sorted(to_remove):
        await remove_label(db, provider, message_id, pmid, lbl)
        removed.append(lbl)
    added: list[str] = []
    for lbl in add_labels:
        await apply_label(db, provider, message_id, pmid, lbl)
        added.append(lbl)
    return {"removed": removed, "added": added}


_SENSITIVE_RE = re.compile(
    r"\b("
    r"one[\s-]?time\s*(pass(word|code)|code)|\bOTP\b|verification\s+code|"
    r"security\s+code|2fa|two[\s-]?factor|"
    r"password\s*[:=]|reset\s+your\s+password|"
    r"social\s+security|ssn|sort\s+code|routing\s+number|iban|"
    r"card\s+number|cvv|cvc|account\s+number"
    r")\b",
    re.IGNORECASE,
)


_LONG_NUMBER_RE = re.compile(r"(?:\d[ -]?){13,16}")


def _email_looks_sensitive(email: dict[str, str] | None) -> bool:
    """True if the email subject/body looks like it carries secrets (OTP,
    password, card/account numbers). Conservative — favours false negatives."""
    if not email:
        return False
    blob = f"{email.get('subject', '')}\n{email.get('body', '')}"
    if not blob.strip():
        return False
    if _SENSITIVE_RE.search(blob):
        return True
    return bool(_LONG_NUMBER_RE.search(blob))


def _load_action_attachments(a: dict[str, Any]) -> list[dict[str, Any]]:
    """Read the files a draft/forward action attaches (stored as
    ``attachments: [{path, name}]`` referencing the email-assistant workspace),
    returning ``[{filename, content, mime_type}]`` for the provider. Best-effort
    and path-traversal-safe."""
    atts = a.get("attachments") or []
    if not atts:
        return []
    out: list[dict[str, Any]] = []
    try:
        import mimetypes  # noqa: PLC0415

        from gateway.routes.workspace import (  # noqa: PLC0415
            _agent_workspace_dir,
        )
        ws = _agent_workspace_dir("email-assistant")
        if not ws:
            return []
        ws_root = ws.resolve()
        for att in atts:
            if not isinstance(att, dict):
                continue
            rel = (att.get("path") or "").strip()
            if not rel:
                continue
            full = (ws / rel).resolve()
            if not str(full).startswith(str(ws_root)) or not full.is_file():
                continue
            mime, _ = mimetypes.guess_type(full.name)
            out.append({
                "filename": att.get("name") or full.name,
                "content": full.read_bytes(),
                "mime_type": mime or "application/octet-stream",
            })
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.attachment_load_failed", error=str(exc)[:120])
    return out


async def _render_template(template: str, email: dict[str, str]) -> str:
    """Fill an inbox-zero-style ``{{...}}`` template against the email context.

    Placeholders describe what to generate, e.g. ``{{choose "urgent",
    "normal"}}`` for a LABEL prompt or ``{{summarize the request}}`` in a draft.
    Returns the input unchanged when it has no ``{{`` placeholders (the common
    case) so static fields never incur an LLM call. Best-effort: falls back to
    the raw template on any error."""
    if not template or "{{" not in template:
        return template
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        ctx = (
            f"From: {email.get('from', '')}\n"
            f"Subject: {email.get('subject', '')}\n\n"
            f"{(email.get('body', '') or '')[:3000]}"
        )
        sys_prompt = (
            "You fill in templates for an email automation rule. The template "
            "contains {{...}} placeholders describing the value to generate "
            '(e.g. {{choose "urgent","normal"}} or {{summarize the request}}). '
            "Replace every {{...}} with an appropriate value based on the email. "
            "Keep all text outside the braces exactly as written. Output ONLY "
            "the filled-in result — no quotes, labels, or commentary."
        )
        # Field-fill is part of rule evaluation → fast tier. Prose output (a
        # filled template), so no JSON mode.
        resp, _ = await acompletion_with_fallback(
            model="tier-fast",
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user",
                       "content": f"Template:\n{template}\n\nEmail:\n{ctx}"}],
            temperature=0, max_tokens=1000,
        )
        out = (resp.choices[0].message.content or "").strip()
        return out or template
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.template_render_failed", error=str(exc)[:200])
        return template


async def _apply_rule_actions(
    db: Any, provider: Any, message_id: str, provider_msg_id: str,
    actions: list[dict[str, Any]], email: dict[str, str] | None = None,
    about: str = "", signature: str = "", user_email: str = "",
    account_id: str = "", errors_out: list[dict[str, str]] | None = None,
) -> list[str]:
    """Apply a rule's actions. Reply/forward/draft create provider DRAFTS (never
    auto-send) so a misfiring rule can't email anyone without review.

    If ``errors_out`` is provided, each action that raises is appended as
    ``{"type", "error"}`` so the History view can show inbox-zero-style
    "Action issues" (the action is still dropped from the returned list)."""
    email = email or {}
    done: list[str] = []
    # Draft-confidence threshold (gates AI-written REPLY/DRAFT_EMAIL drafts).
    draft_conf = "ALL_EMAILS"
    sensitive_protection = True
    # The draft-writing model for AI rule actions (REPLY / DRAFT_EMAIL).
    # Defaults to the powerful tier; overridden from settings below.
    draft_model = "tier-powerful"
    if account_id and any(
        a.get("type") in ("REPLY", "DRAFT_EMAIL") and not (a.get("content") or "").strip()
        for a in actions
    ):
        cr = (await db.execute(text(
            "SELECT draft_confidence, sensitive_data_protection, draft_model "
            "FROM email_assistant_settings WHERE account_id = :aid"
        ), {"aid": account_id})).fetchone()
        if cr and cr.draft_confidence:
            draft_conf = cr.draft_confidence
        if cr and getattr(cr, "sensitive_data_protection", None) is not None:
            sensitive_protection = bool(cr.sensitive_data_protection)
        if cr and getattr(cr, "draft_model", None):
            draft_model = cr.draft_model
    # Sensitive-data protection: don't auto-draft on emails that look like they
    # carry secrets (OTPs, passwords, card/account numbers) when the setting is on.
    skip_ai_drafts = sensitive_protection and _email_looks_sensitive(email)
    for a in actions:
        t = a.get("type")
        try:
            # PROVIDER FIRST, then mirror locally — the same order apply_label
            # uses, and the opposite of what these branches used to do. A rule
            # action that the mail server refuses (Outlook re-keyed or deleted
            # the message, a 404, throttling) must leave NO local change: the
            # old order stamped folder='trash'/'archive' locally, the provider
            # call then raised into errors_out, and the fabricated folder was
            # committed anyway — analytics read it as truth, and a failed TRASH
            # even excluded itself from its own repair. With provider-first, a
            # raised call skips the local UPDATE below and the row is untouched.
            if t == "ARCHIVE":
                await provider.move_to_folder(provider_msg_id, "archive")
                await db.execute(text("UPDATE email_messages SET folder='archive', updated_at=now() WHERE id=:id"), {"id": message_id})
            elif t == "TRASH":
                await provider.trash_message(provider_msg_id)
                await db.execute(text("UPDATE email_messages SET folder='trash', updated_at=now() WHERE id=:id"), {"id": message_id})
            elif t == "MARK_SPAM":
                await provider.move_to_folder(provider_msg_id, "junk")
                await db.execute(text("UPDATE email_messages SET folder='junk', updated_at=now() WHERE id=:id"), {"id": message_id})
            elif t == "MARK_READ":
                await provider.apply_flags(provider_msg_id, is_read=True)
                await db.execute(text("UPDATE email_messages SET is_read=true, updated_at=now() WHERE id=:id"), {"id": message_id})
            elif t == "STAR":
                await provider.apply_flags(provider_msg_id, is_starred=True)
                await db.execute(text("UPDATE email_messages SET is_starred=true, updated_at=now() WHERE id=:id"), {"id": message_id})
            elif t == "MOVE_FOLDER" and a.get("label"):
                # Store the canonical (lowercased) key locally, but hand the
                # ORIGINAL-CASE name to the provider so a created folder reads
                # "Cold Email", not "cold email".
                from email_ingestion.providers.base import canonical_folder  # noqa: PLC0415
                dest = a["label"].strip()
                canon = canonical_folder(dest)
                # Provider first: if the move raises, the local folder is NOT
                # rewritten to a destination the message never reached.
                new_pid = await provider.move_to_folder(provider_msg_id, dest)
                await db.execute(text("UPDATE email_messages SET folder=:f, updated_at=now() WHERE id=:id"), {"id": message_id, "f": canon})
                if new_pid:
                    # Outlook /move re-keys the message — keep follow-up actions valid.
                    await db.execute(text("UPDATE email_messages SET provider_message_id=:pid WHERE id=:id"), {"id": message_id, "pid": new_pid})
                    provider_msg_id = new_pid
                elif canon not in ("inbox", "sent", "drafts", "trash", "junk", "archive"):
                    # A user folder that produced no move id usually means the
                    # provider couldn't resolve/create it — surface it.
                    _log.info("email.move_folder_noop", account_id=account_id, folder=canon)
            elif t == "LABEL" and a.get("label"):
                # label_ai: the label is an AI prompt ({{...}}) resolved per-email.
                lbl = a["label"]
                if a.get("label_ai"):
                    lbl = (await _render_template(lbl, email)).strip()
                if lbl:
                    await apply_label(
                        db, provider, message_id, provider_msg_id, lbl)
            elif t in ("REPLY", "DRAFT_EMAIL"):
                # Manual template wins; otherwise the AI drafts. A template with
                # {{...}} placeholders is rendered against the email first.
                raw = (a.get("content") or "").strip()
                manual = bool(a.get("content_manual")) or bool(raw)
                tmpl = await _render_template(raw, email) if (manual and raw) else ""
                # Sensitive-data protection: never auto-draft an AI reply on an
                # email that looks like it carries secrets (static templates are
                # fine — the user authored them).
                if not tmpl and skip_ai_drafts:
                    _log.info("email.draft_skipped_sensitive", account_id=account_id)
                    continue
                # Dedup (inbox-zero handlePreviousDraftDeletion parity): at most
                # one AI draft per thread — replace an unmodified prior draft,
                # preserve one the user edited. Checked BEFORE generating so we
                # don't waste an LLM call when preserving the user's draft.
                tid = email.get("thread_id") or ""
                if tid and account_id and provider is not None:
                    if await _resolve_existing_thread_draft(
                            db, provider, account_id, tid) == "keep":
                        _log.info("email.draft_skipped_existing",
                                  account_id=account_id)
                        continue
                # Static template wins; otherwise the orchestrating drafter
                # (memory + sales/task-manager + thread history) writes a
                # context-aware reply. Only the AI path needs the thread.
                if tmpl:
                    body = tmpl
                else:
                    # Build the draft context through the SAME single builder the
                    # interactive paths use (/draft-reply, "Draft with AI"), so the
                    # highest-volume path gets full parity: hydrated body, thread,
                    # sender examples + reply memories AND the direction/recipient-
                    # role signals (self / sender_scope / To / Cc) that make the
                    # drafter greet the right person and pick the right register.
                    # Those signals were silently absent on the rule path before —
                    # the hand-assembled dict carried neither sender_scope nor the
                    # To/Cc lines. Fall back to a hydrated copy of the base dict if
                    # the row can't be resolved (it always should here).
                    draft_email = await _build_reply_context(
                        db, account_id, str(message_id), user_email)
                    if draft_email is None:
                        from gateway.routes.email.core import (  # noqa: PLC0415
                            hydrate_message_body,
                        )
                        _hb = await hydrate_message_body(
                            db, str(message_id), user_email)
                        draft_email = {
                            **email,
                            "body": (_hb or "").strip() or email.get("body", ""),
                            "thread": await _fetch_thread_context(
                                db, account_id, email.get("thread_id", ""),
                                provider_msg_id) if email.get("thread_id") else "",
                            "sender_examples": await _fetch_sender_reply_examples(
                                db, account_id, email.get("from", "")),
                            "reply_memories": await _fetch_reply_memories(
                                db, account_id, email),
                            "attachments": (await _attachment_summaries(
                                db, [message_id])).get(str(message_id), ""),
                        }
                    body = await _agent_draft_reply(
                        draft_email, about, signature, user_email, use_agent=True,
                        confidence=draft_conf,
                        model=draft_model, account_id=account_id,
                    )
                # Draft-confidence gate: the drafter returns the NO_DRAFT
                # sentinel (or empty) when it isn't confident enough — skip.
                if not tmpl and _is_no_draft(body):
                    _log.info("email.draft_skipped_low_confidence",
                              account_id=account_id, confidence=draft_conf)
                    continue
                subj = await _render_template(
                    a.get("subject") or f"Re: {email.get('subject', '')}", email)
                to = a.get("to_address") or email.get("from", "")
                if not to:
                    continue
                draft_pid = await provider.create_draft(
                    to=[to], subject=subj, body_text=body,
                    reply_to_message_id=provider_msg_id,
                    thread_id=email.get("thread_id") or None,
                    attachments=_load_action_attachments(a) or None,
                )
                # Mirror the draft locally so it shows in the Drafts folder and
                # in-thread immediately (matches the manual draft write-path).
                if draft_pid and account_id:
                    await _upsert_local_draft(
                        db, account_id, draft_pid,
                        thread_id=email.get("thread_id") or None,
                        owner_email=user_email, to_email=to,
                        subject=subj, body=body,
                    )
                # AI-written (non-template) drafts: remember for edit-learning.
                if not tmpl and account_id:
                    await _store_ai_draft(
                        db, account_id, email.get("thread_id") or "", body)
            elif t == "FORWARD" and a.get("to_address"):
                note = await _render_template(
                    (a.get("content") or "").strip(), email)
                fwd = (
                    f"{note}\n\n" if note else ""
                ) + (
                    "---------- Forwarded message ----------\n"
                    f"From: {email.get('from', '')}\n"
                    f"Subject: {email.get('subject', '')}\n\n"
                    f"{(email.get('body', '') or '')[:4000]}"
                )
                fwd_subject = a.get("subject") or f"Fwd: {email.get('subject', '')}"
                fwd_pid = await provider.create_draft(
                    to=[a["to_address"]],
                    subject=fwd_subject,
                    body_text=fwd,
                    attachments=_load_action_attachments(a) or None,
                )
                if fwd_pid and account_id:
                    await _upsert_local_draft(
                        db, account_id, fwd_pid, thread_id=None,
                        owner_email=user_email, to_email=a["to_address"],
                        subject=fwd_subject, body=fwd,
                    )
            elif t == "CALL_WEBHOOK" and a.get("url"):
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(a["url"], json={"message_id": message_id})
            else:
                continue
            done.append(t)
        except Exception as exc:  # noqa: BLE001
            _log.warning("email.rule_action_failed", action=t, error=str(exc)[:120])
            if errors_out is not None:
                errors_out.append({"type": t or "?", "error": str(exc)[:160]})
    return done
