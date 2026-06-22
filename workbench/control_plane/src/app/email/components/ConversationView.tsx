"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Paperclip, PenLine, Send, Loader2, Trash2 } from "lucide-react";
import { Email } from "../lib/types";
import { fullDateLabel, initials } from "../lib/utils";
import { getEmail } from "../lib/api";
import { useEmailStore } from "../lib/emailStore";
import { MessageContent } from "./MessageContent";

const isDraft = (m: Email) =>
  (m.folder || "").toLowerCase() === "drafts" ||
  (m.folder || "").toLowerCase() === "draft";

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
}: {
  messages: Email[];
  openedId: string;
}) {
  const lastId = messages[messages.length - 1]?.id;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([openedId, lastId].filter(Boolean) as string[])
  );
  const [hydrated, setHydrated] = useState<Record<string, Email>>({});

  // The newest non-draft message — the one a draft reply is threaded onto.
  const replyTarget = [...messages].reverse().find((m) => !isDraft(m));

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
    messages.forEach((m) => {
      if (
        expanded.has(m.id) &&
        !hydrated[m.id] &&
        !m.bodyHtml &&
        !m.bodyText &&
        !isDraft(m)
      ) {
        getEmail(m.id)
          .then((full) => setHydrated((h) => ({ ...h, [m.id]: full })))
          .catch(() => {});
      }
    });
  }, [expanded, messages, hydrated]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="flex flex-col gap-2">
      {messages.map((m) => {
        if (isDraft(m)) {
          return <DraftCard key={m.id} draft={m} replyTo={replyTarget} />;
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
                <div className="text-[11px] text-muted-foreground mb-2">
                  To: {m.to.map((t) => t.name || t.email).join(", ")}
                </div>
                {view.bodyHtml || view.bodyText ? (
                  <MessageContent html={view.bodyHtml} text={view.bodyText} />
                ) : (
                  <div className="text-xs text-muted-foreground italic py-2">
                    No preview text.
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const isDraftEmail = isDraft;

/** Inline editable draft: edit the body/recipients and send it into the thread. */
export function DraftCard({ draft, replyTo }: { draft: Email; replyTo?: Email }) {
  const { sendEmail, deleteEmail, selectedAccountId } = useEmailStore();
  const [hydratedBody, setHydratedBody] = useState<string | null>(null);
  const [body, setBody] = useState(draft.bodyText || "");
  const [to, setTo] = useState(draft.to.map((t) => t.email).filter(Boolean).join(", "));
  const [sending, setSending] = useState(false);

  // The draft may have arrived body-less (header-only sync) — hydrate it.
  useEffect(() => {
    if (!draft.bodyText && !draft.bodyHtml && hydratedBody === null) {
      getEmail(draft.id)
        .then((full) => {
          setHydratedBody(full.bodyText || "");
          setBody((b) => (b ? b : full.bodyText || ""));
        })
        .catch(() => setHydratedBody(""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  const recipients = () =>
    to.split(",").map((s) => s.trim()).filter(Boolean);

  const send = async () => {
    const accountId = draft.accountId || selectedAccountId;
    if (!accountId || recipients().length === 0) return;
    setSending(true);
    try {
      await sendEmail({
        accountId,
        to: recipients(),
        subject: draft.subject || "(no subject)",
        bodyText: body,
        replyToMessageId: replyTo?.providerMessageId,
      });
      // The draft has been sent — remove the lingering provider draft.
      await deleteEmail(draft.id);
    } finally {
      setSending(false);
    }
  };

  const discard = async () => {
    if (confirm("Discard this draft?")) await deleteEmail(draft.id);
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
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="To (comma-separated)"
          className={INPUT}
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={7}
          placeholder="Write your reply…"
          className={`${INPUT} resize-y leading-relaxed`}
        />
      </div>
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
        <span className="text-[10px] text-muted-foreground ml-auto">
          Sends into this conversation · 5s undo
        </span>
      </div>
    </div>
  );
}
