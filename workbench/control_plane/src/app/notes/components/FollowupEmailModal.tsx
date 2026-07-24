"use client";

/**
 * FollowupEmailModal — HITL compose preview for a meeting recap email.
 * Fetches an LLM draft + the user's email accounts, lets them edit everything,
 * and sends via the existing /email/send (spec §3.9). Nothing sends on its own.
 */

import { useEffect, useState } from "react";
import { Loader2, Send, X } from "lucide-react";
import {
  draftFollowupEmail,
  listEmailAccounts,
  sendEmail,
} from "../lib/api";
import type { EmailAccount } from "../lib/types";

export default function FollowupEmailModal({
  meetingId,
  onClose,
  onSent,
}: {
  meetingId: string;
  onClose: () => void;
  onSent: (msg: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [draft, accts] = await Promise.all([
          draftFollowupEmail(meetingId),
          listEmailAccounts().catch(() => [] as EmailAccount[]),
        ]);
        setTo(draft.to.join(", "));
        setSubject(draft.subject);
        setBody(draft.body_text);
        setAccounts(accts);
        setAccountId(accts.find((a) => a.is_default)?.id ?? accts[0]?.id ?? "");
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setLoading(false);
      }
    })();
  }, [meetingId]);

  async function send() {
    const recipients = to
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!accountId) return setError("Choose an account to send from.");
    if (recipients.length === 0)
      return setError("Add at least one recipient.");
    setSending(true);
    setError(null);
    try {
      await sendEmail({
        account_id: accountId,
        to: recipients,
        subject,
        body_text: body,
      });
      onSent(`Follow-up sent to ${recipients.length} recipient(s)`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-foreground">
            Send follow-up email
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary tech-transition"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="p-4 space-y-3 overflow-y-auto">
            {error && (
              <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
            {accounts.length === 0 ? (
              <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                No email account connected. Add one in the Email app to send.
              </div>
            ) : (
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  From
                </span>
                <select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label || a.email_address}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                To (comma-separated)
              </span>
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="name@example.com, …"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Subject
              </span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Message
              </span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
              />
            </label>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground tech-transition"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={sending || loading || accounts.length === 0}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition disabled:opacity-60"
          >
            <span className="flex items-center gap-1.5">
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              Send
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
