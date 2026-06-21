"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, Reply, Clock, PenLine, Mail } from "lucide-react";
import { getReplyZero, triggerQuickAction } from "../../lib/api";
import { ReplyZeroThread } from "../../lib/types";
import { timeLabel } from "../../lib/utils";

interface ReplyZeroViewProps {
  accountId: string | null;
}

type Mode = "needs_reply" | "awaiting";

const MODES: { key: Mode; label: string; icon: React.ElementType }[] = [
  { key: "needs_reply", label: "Needs reply", icon: Reply },
  { key: "awaiting", label: "Awaiting reply", icon: Clock },
];

export function ReplyZeroView({ accountId }: ReplyZeroViewProps) {
  const [mode, setMode] = useState<Mode>("needs_reply");
  const [threads, setThreads] = useState<ReplyZeroThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    getReplyZero(accountId, mode, 100)
      .then(setThreads)
      .catch(() => setThreads([]))
      .finally(() => setLoading(false));
  }, [accountId, mode]);

  useEffect(load, [load]);

  const draft = async (t: ReplyZeroThread) => {
    if (!accountId) return;
    setDrafting(t.message_id);
    try {
      const res = await triggerQuickAction("draft_reply", accountId, t.message_id);
      setDrafts((prev) => ({ ...prev, [t.message_id]: res.result || "(no draft)" }));
    } catch {
      setDrafts((prev) => ({ ...prev, [t.message_id]: "Failed to draft a reply." }));
    } finally {
      setDrafting(null);
    }
  };

  if (!accountId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select an account first.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-3 sm:px-5 py-2 border-b border-border flex-shrink-0">
        {MODES.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
              mode === key
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
        <span className="text-[11px] text-muted-foreground ml-auto">
          {threads.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground gap-2 text-sm">
            <Loader2 className="animate-spin" size={16} /> Loading…
          </div>
        ) : threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 text-sm">
            <Mail size={22} className="opacity-40" />
            {mode === "needs_reply"
              ? "Nothing needs a reply. Inbox zero! 🎉"
              : "No threads awaiting a reply."}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {threads.map((t) => (
              <div key={t.message_id} className="px-3 sm:px-5 py-2.5">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-foreground truncate">
                      {t.subject}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {t.from} · {t.received_at ? timeLabel(t.received_at) : ""}
                    </div>
                  </div>
                  {mode === "needs_reply" && (
                    <button
                      onClick={() => draft(t)}
                      disabled={drafting === t.message_id}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground border border-border hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      {drafting === t.message_id ? (
                        <Loader2 className="animate-spin" size={12} />
                      ) : (
                        <PenLine size={12} />
                      )}
                      Draft reply
                    </button>
                  )}
                </div>
                {drafts[t.message_id] && (
                  <div className="mt-2 text-[11px] text-foreground bg-secondary/50 border border-border rounded-lg p-2 whitespace-pre-wrap">
                    {drafts[t.message_id]}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
