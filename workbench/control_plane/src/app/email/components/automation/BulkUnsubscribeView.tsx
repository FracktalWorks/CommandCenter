"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Loader2, MailMinus, Archive, Check, ExternalLink, Search, ShieldX,
} from "lucide-react";
import { listSenders, upsertNewsletter } from "../../lib/api";
import { SenderStat, NewsletterStatus } from "../../lib/types";

interface BulkUnsubscribeViewProps {
  accountId: string | null;
}

const STATUS_META: Record<NewsletterStatus, { label: string; cls: string }> = {
  APPROVED: { label: "Approved", cls: "bg-emerald-500/15 text-emerald-400" },
  UNSUBSCRIBED: { label: "Unsubscribed", cls: "bg-red-500/15 text-red-400" },
  AUTO_ARCHIVED: { label: "Auto-archive", cls: "bg-amber-500/15 text-amber-400" },
};

export function BulkUnsubscribeView({ accountId }: BulkUnsubscribeViewProps) {
  const [senders, setSenders] = useState<SenderStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [onlyNewsletters, setOnlyNewsletters] = useState(true);

  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    listSenders(accountId, "inbox", 300)
      .then(setSenders)
      .catch((e) => setError(e.message || "Failed to load senders"))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(load, [load]);

  const act = async (
    s: SenderStat,
    status: NewsletterStatus,
    openLink = false
  ) => {
    if (!accountId) return;
    setBusy(s.email);
    try {
      if (openLink && s.unsubscribe_link) {
        window.open(s.unsubscribe_link, "_blank", "noopener,noreferrer");
      }
      await upsertNewsletter({
        accountId,
        email: s.email,
        name: s.name,
        status,
        unsubscribeLink: s.unsubscribe_link,
      });
      setSenders((prev) =>
        prev.map((x) => (x.email === s.email ? { ...x, status } : x))
      );
    } catch (e) {
      setError((e as Error).message || "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const isNewsletter = (s: SenderStat) =>
    !!s.unsubscribe_link || s.count >= 3 || s.read_rate < 0.4;

  const visible = senders
    .filter((s) => !onlyNewsletters || isNewsletter(s))
    .filter(
      (s) =>
        !filter ||
        s.email.toLowerCase().includes(filter.toLowerCase()) ||
        s.name.toLowerCase().includes(filter.toLowerCase())
    );

  if (!accountId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select an account first.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground gap-2 text-sm">
        <Loader2 className="animate-spin" size={16} /> Analyzing senders…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 bg-secondary rounded-md px-2.5 py-1.5 flex-1 max-w-xs">
          <Search size={13} className="text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter senders…"
            className="bg-transparent outline-none text-xs w-full text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={onlyNewsletters}
            onChange={(e) => setOnlyNewsletters(e.target.checked)}
            className="accent-primary"
          />
          Newsletters only
        </label>
        <span className="text-[11px] text-muted-foreground ml-auto">
          {visible.length} senders
        </span>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs text-destructive bg-destructive/10 border-b border-border">
          {error}
        </div>
      )}

      {/* Sender list */}
      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No senders to show.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visible.map((s) => (
              <div
                key={s.email}
                className="flex items-center gap-3 px-5 py-2.5 hover:bg-secondary/40 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground truncate">
                      {s.name || s.email}
                    </span>
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                        STATUS_META[s.status].cls
                      }`}
                    >
                      {STATUS_META[s.status].label}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {s.email}
                  </div>
                </div>

                {/* Stats */}
                <div className="hidden sm:flex items-center gap-4 text-[11px] text-muted-foreground tabular-nums">
                  <div className="text-center">
                    <div className="text-foreground font-medium">{s.count}</div>
                    <div className="text-[9px]">emails</div>
                  </div>
                  <div className="text-center w-12">
                    <div className="text-foreground font-medium">
                      {Math.round(s.read_rate * 100)}%
                    </div>
                    <div className="text-[9px]">read</div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {busy === s.email ? (
                    <Loader2 className="animate-spin text-muted-foreground" size={14} />
                  ) : (
                    <>
                      <ActionBtn
                        title={
                          s.unsubscribe_link
                            ? "Open unsubscribe link & archive"
                            : "Block sender & archive existing"
                        }
                        onClick={() => act(s, "UNSUBSCRIBED", !!s.unsubscribe_link)}
                        className="hover:bg-red-500/10 hover:text-red-400"
                      >
                        {s.unsubscribe_link ? (
                          <ExternalLink size={13} />
                        ) : (
                          <ShieldX size={13} />
                        )}
                        Unsub
                      </ActionBtn>
                      <ActionBtn
                        title="Auto-archive future mail from this sender"
                        onClick={() => act(s, "AUTO_ARCHIVED")}
                        className="hover:bg-amber-500/10 hover:text-amber-400"
                      >
                        <Archive size={13} /> Archive
                      </ActionBtn>
                      <ActionBtn
                        title="Keep — approve this sender"
                        onClick={() => act(s, "APPROVED")}
                        className="hover:bg-emerald-500/10 hover:text-emerald-400"
                      >
                        <Check size={13} /> Keep
                      </ActionBtn>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex-shrink-0 px-5 py-2 border-t border-border text-[10px] text-muted-foreground flex items-center gap-1.5">
        <MailMinus size={11} />
        Unsubscribe opens the sender&apos;s List-Unsubscribe link when available and
        archives their existing mail. Auto-archive blocks future inbox delivery.
      </div>
    </div>
  );
}

function ActionBtn({
  children,
  onClick,
  title,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground border border-border transition-colors ${className}`}
    >
      {children}
    </button>
  );
}
