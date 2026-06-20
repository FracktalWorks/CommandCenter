"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, Archive, Search, Clock, CheckCheck } from "lucide-react";
import { listSenders, bulkAction } from "../../lib/api";
import { SenderStat } from "../../lib/types";

interface BulkArchiveViewProps {
  accountId: string | null;
  /** Called after archiving so the parent can refresh the email list. */
  onArchived?: () => void;
}

const AGE_OPTIONS = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

export function BulkArchiveView({ accountId, onArchived }: BulkArchiveViewProps) {
  const [senders, setSenders] = useState<SenderStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [olderThan, setOlderThan] = useState(30);
  const [onlyRead, setOnlyRead] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    listSenders(accountId, "inbox", 300)
      .then(setSenders)
      .catch(() => setSenders([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(load, [load]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const archiveByRule = async () => {
    if (!accountId) return;
    if (
      !confirm(
        `Archive ${onlyRead ? "read " : ""}inbox mail older than ${olderThan} days?`
      )
    )
      return;
    setBusy("rule");
    try {
      const res = await bulkAction({
        action: "archive",
        accountId,
        folder: "inbox",
        olderThanDays: olderThan,
        onlyRead,
      });
      flash(`Archived ${res.affected} message(s).`);
      onArchived?.();
      load();
    } catch (e) {
      flash((e as Error).message || "Archive failed");
    } finally {
      setBusy(null);
    }
  };

  const archiveSender = async (s: SenderStat) => {
    if (!accountId) return;
    setBusy(s.email);
    try {
      const res = await bulkAction({
        action: "archive",
        accountId,
        folder: "inbox",
        senderEmail: s.email,
      });
      flash(`Archived ${res.affected} from ${s.name || s.email}.`);
      setSenders((prev) => prev.filter((x) => x.email !== s.email));
      onArchived?.();
    } catch (e) {
      flash((e as Error).message || "Archive failed");
    } finally {
      setBusy(null);
    }
  };

  const visible = senders.filter(
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

  return (
    <div className="h-full flex flex-col relative">
      {/* Rule-based archive */}
      <div className="px-5 py-4 border-b border-border flex-shrink-0">
        <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
          <Clock size={13} className="text-primary" /> Archive old mail
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 bg-secondary rounded-lg p-0.5">
            {AGE_OPTIONS.map((o) => (
              <button
                key={o.days}
                onClick={() => setOlderThan(o.days)}
                className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                  olderThan === o.days
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={onlyRead}
              onChange={(e) => setOnlyRead(e.target.checked)}
              className="accent-primary"
            />
            Only read
          </label>
          <button
            onClick={archiveByRule}
            disabled={busy === "rule"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 ml-auto"
          >
            {busy === "rule" ? (
              <Loader2 className="animate-spin" size={13} />
            ) : (
              <Archive size={13} />
            )}
            Archive matching
          </button>
        </div>
      </div>

      {/* Per-sender archive */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-border flex-shrink-0">
        <CheckCheck size={13} className="text-primary" />
        <span className="text-xs font-semibold text-foreground">
          Archive by sender
        </span>
        <div className="flex items-center gap-2 bg-secondary rounded-md px-2.5 py-1.5 ml-auto max-w-xs">
          <Search size={13} className="text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="bg-transparent outline-none text-xs w-full text-foreground placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground gap-2 text-sm">
            <Loader2 className="animate-spin" size={16} /> Loading senders…
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Inbox is clear.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visible.map((s) => (
              <div
                key={s.email}
                className="flex items-center gap-3 px-5 py-2.5 hover:bg-secondary/40 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-foreground truncate">
                    {s.name || s.email}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {s.email}
                  </div>
                </div>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {s.count} in inbox
                </span>
                <button
                  onClick={() => archiveSender(s)}
                  disabled={busy === s.email}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground border border-border hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50"
                >
                  {busy === s.email ? (
                    <Loader2 className="animate-spin" size={13} />
                  ) : (
                    <Archive size={13} />
                  )}
                  Archive all
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {toast && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-card border border-border shadow-xl rounded-lg px-4 py-2 text-xs text-foreground">
          {toast}
        </div>
      )}
    </div>
  );
}
