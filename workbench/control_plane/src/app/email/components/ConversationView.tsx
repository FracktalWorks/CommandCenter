"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown, Paperclip, PenLine, Send, Loader2, Trash2,
  Reply, ReplyAll, Forward,
} from "lucide-react";
import { Email } from "../lib/types";
import { fullDateLabel, initials, buildOptimisticSent } from "../lib/utils";
import { getEmail, fetchFullBody, composeAssist } from "../lib/api";
import { splitQuotedText } from "../lib/quoting";
import { useEmailStore } from "../lib/emailStore";
import { ComposerQuote, AiButton, AiAssistBar } from "./ComposerAI";
import { MessageContent } from "./MessageContent";
import { AttachmentList } from "./AttachmentList";

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

  // The newest non-draft message — the one a draft reply is threaded onto.
  const replyTarget = [...visible].reverse().find((m) => !isDraft(m));

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Hydrate full bodies for expanded messages that arrived body-less.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    visible.forEach((m) => {
      if (
        expanded.has(m.id) &&
        !hydrated[m.id] &&
        !m.bodyHtml &&
        !m.bodyText &&
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
                        icon={ReplyAll}
                        label="Reply all"
                        onClick={() => onReply(view, "reply-all")}
                      />
                      <CardAction
                        icon={Reply}
                        label="Reply"
                        onClick={() => onReply(view, "reply")}
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
                {/* This message's own attachments, in its own card. */}
                <AttachmentList
                  attachments={view.attachments}
                  className="mt-4 pt-3 border-t border-border"
                />
              </div>
            )}
          </div>
        );
      })}
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
}: {
  draft: Email;
  replyTo?: Email;
  onDismiss?: () => void;
  onSent?: (sent?: Email) => void;
}) {
  const {
    deleteEmail, selectedAccountId, saveDraft, sendDraft, sendEmail, accounts,
  } = useEmailStore();
  const ownEmail = accounts
    .find((a) => a.id === (draft.accountId || selectedAccountId))
    ?.emailAddress?.toLowerCase();
  // Default to REPLY-ALL: the original sender + everyone on To, minus yourself;
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
  const [showCc, setShowCc] = useState(replyAllCc.length > 0);
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
      if (ccList().length || bccList().length) {
        // Cc/Bcc aren't carried by the draft write-path, so send via the full
        // path (threaded) and remove the saved draft so it doesn't linger.
        await sendEmail({
          accountId,
          to: recipients(),
          cc: ccList(),
          bcc: bccList(),
          subject: draft.subject || "",
          bodyText: combinedBody(),
          replyToMessageId: replyTo?.providerMessageId,
        });
        onDismiss?.();
        try {
          await deleteEmail(draft.id);
        } catch {
          /* the message was sent; the leftover draft cleanup is best-effort */
        }
      } else {
        // Persist the latest edits, then send THIS draft natively (Drafts →
        // Sent, no duplicate). sendDraft removes it from the list.
        await saveDraft({
          accountId,
          draftId: draft.id,
          to: recipients(),
          subject: draft.subject || "",
          body: combinedBody(),
        });
        await sendDraft(accountId, draft.id);
      }
      // Surface the reply in the conversation at once + pull the real copy.
      onSent?.(
        buildOptimisticSent({
          accountId,
          threadId: replyTo?.threadId || draft.threadId,
          fromEmail: ownEmail || "",
          to: recipients(),
          cc: ccList(),
          subject: draft.subject || "",
          bodyText: combinedBody(),
        })
      );
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
        <span className="text-[10px] text-muted-foreground ml-auto">
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
