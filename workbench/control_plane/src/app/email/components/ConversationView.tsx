"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown, Paperclip, PenLine, Send, Loader2, Trash2,
  Reply, ReplyAll, Forward,
} from "lucide-react";
import { Email } from "../lib/types";
import { fullDateLabel, initials, buildOptimisticSent } from "../lib/utils";
import {
  getEmail, fetchFullBody, composeAssist, detectReplyCommitment,
} from "../lib/api";
import { splitQuotedText } from "../lib/quoting";
import { useEmailStore } from "../lib/emailStore";
import { ComposerQuote, AiButton, AiAssistBar } from "./ComposerAI";
import { MessageContent } from "./MessageContent";
import { AttachmentList } from "./AttachmentList";
import { SignaturePreview } from "./SignaturePreview";
import { TaskCaptureModal, type CommitmentContext } from "./TaskCaptureModal";

const isDraft = (m: Email) =>
  (m.folder || "").toLowerCase() === "drafts" ||
  (m.folder || "").toLowerCase() === "draft";

const isTrashed = (m: Email) => {
  const f = (m.folder || "").toLowerCase();
  return f === "trash" || f === "deleted";
};

const INPUT =
  "w-full bg-background border border-border rounded-md px-2.5 py-2 text-xs " +
  "text-foreground outline-none focus:border-primary transition-colors";

/**
 * Gmail-style conversation view: the messages of a thread stacked oldest→newest.
 * Collapsed cards show sender + snippet; the opened message and the latest are
 * expanded by default. Bodies hydrate lazily when a card is expanded. Draft
 * messages in the thread render as an editable composer you can send or discard.
 */
export function ConversationView({
  messages,
  openedId,
  onReply,
  onSent,
}: {
  messages: Email[];
  openedId: string;
  /** Reply / Reply All / Forward a specific message in the thread. Opens the
   *  composer (in EmailDetail) threaded onto that message. */
  onReply?: (message: Email, mode: "reply" | "reply-all" | "forward") => void;
  /** Called after an in-thread draft is sent so the parent can surface the
   *  reply immediately and pull the real synced copy. */
  onSent?: (sent?: Email) => void;
}) {
  // Locally-discarded drafts hide instantly (the provider delete is async).
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  // Hide messages deleted upstream (trash) so the conversation reflects the
  // live mailbox — except the one the user explicitly opened — and any draft the
  // user just discarded.
  const visible = messages.filter(
    (m) => (!isTrashed(m) || m.id === openedId) && !dismissed.has(m.id)
  );
  const lastId = visible[visible.length - 1]?.id;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([openedId, lastId].filter(Boolean) as string[])
  );
  const [hydrated, setHydrated] = useState<Record<string, Email>>({});
  // A detected commitment awaiting the user's confirm in the "Add to Tasks"
  // popup, plus the account it belongs to (null = no popup open).
  const [commitment, setCommitment] = useState<
    { accountId: string; ctx: CommitmentContext } | null
  >(null);

  // The newest non-draft message — the one a draft reply is threaded onto.
  const replyTarget = [...visible].reverse().find((m) => !isDraft(m));

  // After a reply sends, ask the backend whether it committed the user to a
  // task. Only when it did do we surface the popup — a silent no-op otherwise,
  // so a plain "thanks, will do" never interrupts. Best-effort: a detector
  // failure just means no popup, never a broken send.
  const checkCommitment = async (c: {
    accountId: string;
    threadId: string;
    subject: string;
    body: string;
    replyToMessageId: string | null;
  }) => {
    try {
      const res = await detectReplyCommitment({
        accountId: c.accountId,
        threadId: c.threadId,
        body: c.body,
        subject: c.subject,
        replyToMessageId: c.replyToMessageId,
      });
      if (!res.isCommitment || !res.draft) return;
      setCommitment({
        accountId: c.accountId,
        ctx: {
          threadId: c.threadId,
          body: c.body,
          subject: c.subject,
          replyToMessageId: c.replyToMessageId,
          draft: res.draft,
          similar: res.similar,
        },
      });
    } catch {
      /* detection is best-effort — no popup on failure */
    }
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Hydrate expanded messages that arrived incomplete: either body-less, or
  // carrying attachments (has_attachments) whose file rows weren't included in
  // the thread payload — so each card can show its own attachment thumbnails.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    visible.forEach((m) => {
      const needsBody = !m.bodyHtml && !m.bodyText;
      const needsAttachments =
        m.hasAttachments && (!m.attachments || m.attachments.length === 0);
      if (
        expanded.has(m.id) &&
        !hydrated[m.id] &&
        (needsBody || needsAttachments) &&
        !isDraft(m)
      ) {
        getEmail(m.id)
          .then((full) => setHydrated((h) => ({ ...h, [m.id]: full })))
          // On failure, cache the list row so the effect doesn't retry this
          // message forever every time `hydrated` changes for another card.
          .catch(() => setHydrated((h) => ({ ...h, [m.id]: m })));
      }
    });
  }, [expanded, visible, hydrated]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="flex flex-col gap-2">
      {visible.map((m) => {
        if (isDraft(m)) {
          return (
            <DraftCard
              key={m.id}
              draft={m}
              replyTo={replyTarget}
              onSent={onSent}
              onCommitment={checkCommitment}
              onDismiss={() =>
                setDismissed((s) => new Set(s).add(m.id))
              }
            />
          );
        }
        const isOpen = expanded.has(m.id);
        const view = hydrated[m.id] ?? m;
        return (
          <div
            key={m.id}
            className={`border border-border rounded-lg overflow-hidden ${
              isOpen ? "" : "bg-secondary/20"
            }`}
          >
            <button
              onClick={() => toggle(m.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/40 transition-colors"
            >
              <div className="w-7 h-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-semibold flex-shrink-0">
                {initials(m.from.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate flex items-center gap-1">
                  {m.from.name}
                  {!m.isRead && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
                  )}
                </div>
                {!isOpen && (
                  <div className="text-[11px] text-muted-foreground truncate">
                    {m.snippet}
                  </div>
                )}
              </div>
              {m.hasAttachments && (
                <Paperclip size={11} className="text-muted-foreground flex-shrink-0" />
              )}
              <span className="text-[10px] text-muted-foreground whitespace-nowrap flex-shrink-0">
                {fullDateLabel(m.receivedAt)}
              </span>
              <ChevronDown
                size={13}
                className={`text-muted-foreground flex-shrink-0 transition-transform ${
                  isOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            {isOpen && (
              <div className="px-3 pb-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="text-[11px] text-muted-foreground min-w-0 truncate">
                    To: {m.to.map((t) => t.name || t.email).join(", ")}
                  </div>
                  {onReply && (
                    <div className="flex items-center gap-0.5 flex-shrink-0 -mt-0.5">
                      <CardAction
                        icon={Reply}
                        label="Reply"
                        onClick={() => onReply(view, "reply")}
                      />
                      <CardAction
                        icon={ReplyAll}
                        label="Reply all"
                        onClick={() => onReply(view, "reply-all")}
                      />
                      <CardAction
                        icon={Forward}
                        label="Forward"
                        onClick={() => onReply(view, "forward")}
                      />
                    </div>
                  )}
                </div>
                {view.bodyHtml || view.bodyText ? (
                  <MessageContent html={view.bodyHtml} text={view.bodyText} />
                ) : (
                  <div className="text-xs text-muted-foreground italic py-2">
                    No preview text.
                  </div>
                )}
                {/* Per-message attachments — same card UI (with image
                    thumbnails) as the single-message reader, so a thread's
                    earlier messages surface their files too. */}
                {view.hasAttachments && (
                  <AttachmentList
                    attachments={view.attachments}
                    className="mt-4 pt-3 border-t border-border"
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
      {/* "You committed to a task" popup — same UI as an inbound capture, keyed
          on the just-sent reply. Opens only when the detector found a real
          commitment; dismissible (Cancel / Esc / backdrop). */}
      {commitment && (
        <TaskCaptureModal
          accountId={commitment.accountId}
          commitment={commitment.ctx}
          onClose={() => setCommitment(null)}
          onCaptured={() => setCommitment(null)}
        />
      )}
    </div>
  );
}

/** Small per-message action button (Reply / Reply All / Forward) on a card. */
function CardAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
    >
      <Icon size={13} />
    </button>
  );
}

export const isDraftEmail = isDraft;

/** Inline editable draft: edit the body/recipients and send it into the thread. */
export function DraftCard({
  draft,
  replyTo,
  onDismiss,
  onSent,
  onCommitment,
}: {
  draft: Email;
  replyTo?: Email;
  onDismiss?: () => void;
  onSent?: (sent?: Email) => void;
  /** After a reply is sent, hand its context up so the parent can check whether
   *  it committed the user to a task (and offer the "Add to Tasks" popup). Only
   *  fired for real replies (a reply target exists), not from-scratch composes. */
  onCommitment?: (ctx: {
    accountId: string;
    threadId: string;
    subject: string;
    body: string;
    replyToMessageId: string | null;
  }) => void;
}) {
  const {
    deleteEmail, selectedAccountId, saveDraft, sendDraft, accounts,
  } = useEmailStore();
  const ownEmail = accounts
    .find((a) => a.id === (draft.accountId || selectedAccountId))
    ?.emailAddress?.toLowerCase();
  // A real inbound message to reply to (vs a from-scratch / compose draft) —
  // gates the Reply / Reply All toggle and the reply-all recipient maths.
  const hasReplyTarget = !!replyTo && replyTo.id !== draft.id;
  // REPLY-ALL recipients: the original sender + everyone on To, minus yourself;
  // original Cc carried over. Falls back to whatever the draft already has.
  const replyAllTo = (() => {
    if (!replyTo) return draft.to.map((t) => t.email).filter(Boolean);
    const all = [
      replyTo.from?.email,
      ...(replyTo.to || []).map((t) => t.email),
    ];
    const deduped = all.filter(
      (e, i) => e && all.indexOf(e) === i && e.toLowerCase() !== ownEmail
    );
    return deduped.length ? deduped : draft.to.map((t) => t.email).filter(Boolean);
  })();
  const replyAllCc = (replyTo?.cc || [])
    .map((c) => c.email)
    .filter((e) => e && e.toLowerCase() !== ownEmail);
  // REPLY (sender only) recipients.
  const replyOnlyTo = (() => {
    const from = replyTo?.from?.email;
    if (from && from.toLowerCase() !== ownEmail) return [from];
    return draft.to.map((t) => t.email).filter(Boolean);
  })();

  // Split any quoted trailing chain out of the draft body so the editable box
  // holds only the new text (and AI never rewrites the quote); it's reattached
  // on send. `initSplit` covers a draft that already arrived with a body.
  const initSplit = splitQuotedText(draft.bodyText || "");
  const [hydratedBody, setHydratedBody] = useState<string | null>(null);
  const [body, setBody] = useState(initSplit.main);
  const [quote, setQuote] = useState(initSplit.quoted || "");
  const [to, setTo] = useState(replyAllTo.join(", "));
  const [cc, setCc] = useState(replyAllCc.join(", "));
  const [bcc, setBcc] = useState("");
  // Default to reply-all when replying to a real message (parity with
  // EmailDetail); the toggle narrows to the sender only.
  const [replyAll, setReplyAll] = useState(hasReplyTarget);
  // Show Cc/Bcc up-front on a reply so they're always visible; keep them behind
  // the reveal button only for a from-scratch draft.
  const [showCc, setShowCc] = useState(hasReplyTarget || replyAllCc.length > 0);

  /** Flip Reply ↔ Reply All, recomputing To/Cc from the original message.
   *  Reply All reveals the Cc/Bcc fields; Reply (sender only) hides them and
   *  clears their contents so you don't silently keep other recipients. */
  const applyReplyAll = (next: boolean) => {
    setReplyAll(next);
    dirty.current = true;
    if (next) {
      setTo(replyAllTo.join(", "));
      setCc(replyAllCc.join(", "));
      setShowCc(true);
    } else {
      setTo(replyOnlyTo.join(", "));
      setCc("");
      setBcc("");
      setShowCc(false);
    }
  };
  const [sending, setSending] = useState(false);
  const dirty = useRef(false);
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved">("idle");
  // AI draft/improve bar.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  /** The full outgoing body: the editable text plus the quoted trailing chain. */
  const combinedBody = () =>
    quote ? `${body.replace(/\s+$/, "")}\n\n${quote}` : body;

  const ccList = () => cc.split(",").map((s) => s.trim()).filter(Boolean);
  const bccList = () => bcc.split(",").map((s) => s.trim()).filter(Boolean);

  // The draft almost always arrives body-less: provider drafts (incl. the ones
  // the AI agent creates) sync header-only, so the DB copy has no body. Pull the
  // DB row first, then fall back to the provider's authoritative draft body so
  // the editor is pre-filled with the actual AI draft — not an empty box.
  useEffect(() => {
    if ((draft.bodyText || draft.bodyHtml) || hydratedBody !== null) return;
    let cancelled = false;
    (async () => {
      let text = "";
      try {
        const full = await getEmail(draft.id);
        text = full.bodyText || "";
      } catch {
        /* fall through to provider fetch */
      }
      if (!text) {
        try {
          const fb = await fetchFullBody(draft.id);
          text = fb.body_text || "";
        } catch {
          /* leave empty */
        }
      }
      if (cancelled) return;
      setHydratedBody(text);
      const sp = splitQuotedText(text);
      setBody((b) => (b ? b : sp.main));
      setQuote((q) => q || sp.quoted || "");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  const recipients = () =>
    to.split(",").map((s) => s.trim()).filter(Boolean);

  // Auto-save edits to the draft in place (debounced) so changes persist to the
  // provider Drafts and survive a refresh — keyed on the draft's own id.
  useEffect(() => {
    const accountId = draft.accountId || selectedAccountId;
    if (!accountId || !dirty.current) return;
    const handle = setTimeout(async () => {
      try {
        setDraftStatus("saving");
        await saveDraft({
          accountId,
          draftId: draft.id,
          to: recipients(),
          cc: ccList(),
          bcc: bccList(),
          subject: draft.subject || "",
          body: combinedBody(),
        });
        setDraftStatus("saved");
      } catch {
        setDraftStatus("idle");
      }
    }, 1200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, quote, to]);

  const send = async () => {
    const accountId = draft.accountId || selectedAccountId;
    if (!accountId || recipients().length === 0) return;
    setSending(true);
    try {
      // Persist the latest edits — Cc/Bcc included, now carried on the provider
      // draft — then send THIS draft natively (Drafts → Sent, no duplicate).
      // sendDraft removes it from the list. No more full-send detour for a Cc'd
      // reply, which used to start a fresh (unthreaded) message.
      await saveDraft({
        accountId,
        draftId: draft.id,
        to: recipients(),
        cc: ccList(),
        bcc: bccList(),
        subject: draft.subject || "",
        body: combinedBody(),
      });
      await sendDraft(accountId, draft.id);
      // Surface the reply in the conversation at once + pull the real copy.
      const sentThreadId = replyTo?.threadId || draft.threadId;
      onSent?.(
        buildOptimisticSent({
          accountId,
          threadId: sentThreadId,
          fromEmail: ownEmail || "",
          to: recipients(),
          cc: ccList(),
          subject: draft.subject || "",
          bodyText: combinedBody(),
        })
      );
      // If this was a real reply, check whether it committed me to a task. Pass
      // only the NEW reply text (`body`), not the quoted chain, so the detector
      // reasons about what I just wrote — not the whole thread as my words.
      if (hasReplyTarget && sentThreadId && body.trim()) {
        onCommitment?.({
          accountId,
          threadId: sentThreadId,
          subject: draft.subject || "",
          body,
          replyToMessageId: replyTo?.providerMessageId || null,
        });
      }
    } catch {
      /* send failure — the draft stays in Drafts so the user can retry */
    } finally {
      setSending(false);
    }
  };

  const discard = async () => {
    if (!confirm("Discard this draft?")) return;
    onDismiss?.(); // hide instantly; the provider delete is async
    try {
      await deleteEmail(draft.id);
    } catch {
      /* already hidden locally; the sweep will reconcile */
    }
  };

  /** Draft or improve the reply with AI — operates on the NEW text only (the
   *  quoted trailing chain is kept separate, never sent). */
  const runAi = async () => {
    const accountId = draft.accountId || selectedAccountId;
    if (!accountId || aiBusy) return;
    setAiBusy(true);
    try {
      const res = await composeAssist({
        accountId,
        body,
        instruction: aiInstruction.trim(),
        mode: replyTo ? "reply" : "new",
        messageId: replyTo?.id,
        to: recipients(),
        subject: draft.subject || "",
      });
      if (res.draft) {
        dirty.current = true;
        setBody(res.draft);
        setAiOpen(false);
        setAiInstruction("");
      }
    } catch {
      /* leave the draft as-is on failure; the user can retry */
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="border border-primary/40 rounded-lg bg-primary/5 px-3 py-3">
      <div className="flex items-center gap-1.5 mb-2">
        <PenLine size={12} className="text-primary" />
        <span className="text-xs font-medium text-primary">Draft</span>
        {hasReplyTarget && (
          <div className="flex items-center bg-background border border-border rounded-md p-0.5 ml-1.5">
            <button
              type="button"
              onClick={() => applyReplyAll(false)}
              title="Reply to sender only"
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap transition-colors ${
                !replyAll ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Reply size={11} className="flex-shrink-0" /> Reply
            </button>
            <button
              type="button"
              onClick={() => applyReplyAll(true)}
              title="Reply to everyone"
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap transition-colors ${
                replyAll ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <ReplyAll size={11} className="flex-shrink-0" /> Reply All
            </button>
          </div>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[45%]">
          {draft.subject}
        </span>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            value={to}
            onChange={(e) => { dirty.current = true; setTo(e.target.value); }}
            placeholder="To (comma-separated)"
            className={`${INPUT} flex-1`}
          />
          {!showCc && (
            <button
              type="button"
              onClick={() => setShowCc(true)}
              className="text-[10px] text-muted-foreground hover:text-foreground whitespace-nowrap px-1"
            >
              Cc/Bcc
            </button>
          )}
        </div>
        {showCc && (
          <>
            <input
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="Cc (comma-separated)"
              className={INPUT}
            />
            <input
              value={bcc}
              onChange={(e) => setBcc(e.target.value)}
              placeholder="Bcc (comma-separated)"
              className={INPUT}
            />
          </>
        )}
        <textarea
          value={body}
          onChange={(e) => { dirty.current = true; setBody(e.target.value); }}
          rows={7}
          placeholder="Write your reply…"
          className={`${INPUT} resize-y leading-relaxed`}
        />
        {/* Signature as it will be appended on send (Outlook/Gmail style). */}
        <SignaturePreview accountId={draft.accountId || selectedAccountId} />
        {/* Quoted trailing email — collapsed, read-only (reattached on send) */}
        <ComposerQuote quote={quote} className="" />
      </div>
      {aiOpen && (
        <div className="mt-2 -mx-3 border-y border-border">
          <AiAssistBar
            instruction={aiInstruction}
            onInstruction={setAiInstruction}
            busy={aiBusy}
            hasText={body.trim().length > 0}
            onRun={runAi}
            onClose={() => setAiOpen(false)}
          />
        </div>
      )}
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={send}
          disabled={sending || recipients().length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {sending ? (
            <Loader2 className="animate-spin" size={13} />
          ) : (
            <Send size={13} />
          )}
          Send
        </button>
        <button
          onClick={discard}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-destructive hover:bg-secondary transition-colors"
        >
          <Trash2 size={13} /> Discard
        </button>
        <AiButton active={aiOpen} onClick={() => setAiOpen((v) => !v)} />
        <span className="text-[10px] text-muted-foreground ml-auto">
          {draftStatus === "saving"
            ? "Saving draft…"
            : draftStatus === "saved"
              ? "Draft saved · sends into this conversation"
              : "Sends into this conversation"}
        </span>
      </div>
    </div>
  );
}
