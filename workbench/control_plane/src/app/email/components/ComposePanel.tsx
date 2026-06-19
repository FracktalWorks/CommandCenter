"use client";

import { useState } from "react";
import { X, Loader2 } from "lucide-react";

interface ComposePanelProps {
  open: boolean;
  onClose: () => void;
  accountId: string;
  onSend: (params: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    bodyText: string;
    replyToMessageId?: string;
  }) => Promise<void>;
  defaultTo?: string;
  defaultSubject?: string;
  replyToBody?: string;
  replyToMessageId?: string;
}

export function ComposePanel({
  open,
  onClose,
  accountId,
  onSend,
  defaultTo = "",
  defaultSubject = "",
  replyToBody,
  replyToMessageId,
}: ComposePanelProps) {
  const [to, setTo] = useState(defaultTo);
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(replyToBody || "");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  if (!open) return null;

  const handleSend = async () => {
    if (!to.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend({
        to: to.split(",").map((s) => s.trim()).filter(Boolean),
        cc: cc ? cc.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        subject,
        bodyText: body,
        replyToMessageId: replyToMessageId,
      });
      // onClose is called by the store after successful send
    } catch (err: any) {
      setSendError(err.message || "Failed to send");
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-12 sm:pt-20 px-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Compose window */}
      <div className="relative w-full max-w-2xl bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/50">
          <span className="text-sm font-medium text-foreground">New Message</span>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Fields */}
        <div className="px-4 py-3 space-y-3">
          {/* To */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-8 flex-shrink-0">To:</span>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="Email address..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>

          {/* Cc */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-8 flex-shrink-0">Cc:</span>
            <input
              type="text"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="Cc..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>

          {/* Subject */}
          <div className="flex items-center gap-2 border-t border-border pt-3">
            <span className="text-xs text-muted-foreground w-8 flex-shrink-0">Subj:</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>

          {/* Body */}
          <div className="border-t border-border pt-3">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message..."
              rows={12}
              autoFocus
              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none resize-none leading-relaxed"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between">
          <div className="flex-1">
            {sendError && (
              <span className="text-[10px] text-red-500">{sendError}</span>
            )}
            {!sendError && (
              <span className="text-[10px] text-muted-foreground">
                Sent from your connected email account
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={sending}
              className="px-3 py-1.5 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
            >
              Discard
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !to.trim()}
              className="px-4 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {sending && <Loader2 size={12} className="animate-spin" />}
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
