"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Loader2, MailMinus, Archive, Check, ExternalLink, Search, ShieldX, Tags,
  Mail, X,
} from "lucide-react";
import { listSenders, upsertNewsletter, categorizeSenders } from "../../lib/api";
import { SenderStat, NewsletterStatus, SenderStatus } from "../../lib/types";

interface BulkUnsubscribeViewProps {
  accountId: string | null;
}

const STATUS_META: Record<SenderStatus, { label: string; cls: string }> = {
  UNHANDLED: { label: "Unhandled", cls: "bg-secondary text-muted-foreground" },
  APPROVED: { label: "Approved", cls: "bg-emerald-500/15 text-emerald-400" },
  UNSUBSCRIBED: { label: "Unsubscribed", cls: "bg-red-500/15 text-red-400" },
  AUTO_ARCHIVED: { label: "Auto-archive", cls: "bg-amber-500/15 text-amber-400" },
};

type StatusTab = "all" | SenderStatus;
const STATUS_TABS: { key: StatusTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "UNHANDLED", label: "Unhandled" },
  { key: "UNSUBSCRIBED", label: "Unsubscribed" },
  { key: "AUTO_ARCHIVED", label: "Auto-archive" },
  { key: "APPROVED", label: "Approved" },
];

/** Open a List-Unsubscribe target — mailto opens the mail client, http opens a tab. */
function openUnsubscribe(link: string) {
  if (link.toLowerCase().startsWith("mailto:")) {
    window.location.href = link;
  } else {
    window.open(link, "_blank", "noopener,noreferrer");
  }
}

export function BulkUnsubscribeView({ accountId }: BulkUnsubscribeViewProps) {
  const [senders, setSenders] = useState<SenderStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [onlyNewsletters, setOnlyNewsletters] = useState(true);
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [categorizing, setCategorizing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  const isNewsletter = (s: SenderStat) =>
    !!s.unsubscribe_link || s.count >= 3 || s.read_rate < 0.4;

  const visible = useMemo(
    () =>
      senders
        .filter((s) => !onlyNewsletters || isNewsletter(s))
        .filter((s) => statusTab === "all" || s.status === statusTab)
        .filter(
          (s) =>
            !filter ||
            s.email.toLowerCase().includes(filter.toLowerCase()) ||
            s.name.toLowerCase().includes(filter.toLowerCase())
        ),
    [senders, onlyNewsletters, statusTab, filter]
  );

  // Status counts for the tab badges (respecting the newsletters-only toggle).
  const counts = useMemo(() => {
    const base = senders.filter((s) => !onlyNewsletters || isNewsletter(s));
    const c: Record<string, number> = { all: base.length };
    for (const s of base) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [senders, onlyNewsletters]);

  // Drop selections that are no longer visible (e.g. after a filter change).
  const visibleEmails = useMemo(() => new Set(visible.map((s) => s.email)), [visible]);
  const selectedVisible = useMemo(
    () => [...selected].filter((e) => visibleEmails.has(e)),
    [selected, visibleEmails]
  );
  const allSelected = visible.length > 0 && selectedVisible.length === visible.length;

  const toggleOne = (email: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(visible.map((s) => s.email)));
  const clearSelection = () => setSelected(new Set());
  // inbox-zero's "Select suggested": senders you rarely read (<30% read rate)
  // with enough volume to be worth unsubscribing from.
  const suggested = visible.filter((s) => s.read_rate < 0.3 && s.count >= 3);
  const selectSuggested = () =>
    setSelected(new Set(suggested.map((s) => s.email)));

  const persist = async (s: SenderStat, status: NewsletterStatus) => {
    if (!accountId) return;
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
  };

  const act = async (s: SenderStat, status: NewsletterStatus, openLink = false) => {
    setBusy(s.email);
    try {
      if (openLink && s.unsubscribe_link) openUnsubscribe(s.unsubscribe_link);
      await persist(s, status);
    } catch (e) {
      setError((e as Error).message || "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const bulkAct = async (status: NewsletterStatus) => {
    const targets = visible.filter((s) => selected.has(s.email));
    if (targets.length === 0) return;
    setBusy("__bulk__");
    try {
      // Sequential to keep optimistic updates simple; no link auto-open in bulk
      // (opening dozens of tabs is hostile — use per-row Unsub for the link).
      for (const s of targets) await persist(s, status);
      clearSelection();
    } catch (e) {
      setError((e as Error).message || "Bulk action failed");
    } finally {
      setBusy(null);
    }
  };

  const runCategorize = async () => {
    if (!accountId) return;
    setCategorizing(true);
    try {
      await categorizeSenders(accountId, 100);
      setTimeout(() => {
        load();
        setCategorizing(false);
      }, 8000);
    } catch {
      setCategorizing(false);
    }
  };

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
      <div className="flex items-center gap-2 px-3 sm:px-5 py-3 border-b border-border flex-shrink-0">
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
        <button
          onClick={runCategorize}
          disabled={categorizing}
          title="Auto-categorize senders with AI"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50 ml-auto"
        >
          {categorizing ? <Loader2 className="animate-spin" size={13} /> : <Tags size={13} />}
          {categorizing ? "Categorizing…" : "Categorize"}
        </button>
      </div>

      {/* Status filter tabs */}
      <div className="flex items-center gap-1 px-3 sm:px-5 py-2 border-b border-border flex-shrink-0 overflow-x-auto scrollbar-hide">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatusTab(t.key)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] whitespace-nowrap transition-colors ${
              statusTab === t.key
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
          >
            {t.label}
            <span className="opacity-60">{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="px-3 sm:px-5 py-2 text-xs text-destructive bg-destructive/10 border-b border-border">
          {error}
        </div>
      )}

      {/* Bulk action bar */}
      {selectedVisible.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 sm:px-5 py-2 border-b border-border bg-primary/10 flex-shrink-0 overflow-x-auto scrollbar-hide">
          <span className="text-[11px] font-medium text-foreground">
            {selectedVisible.length} selected
          </span>
          <div className="flex-1" />
          <ActionBtn
            title="Unsubscribe & archive existing mail"
            onClick={() => bulkAct("UNSUBSCRIBED")}
            className="hover:bg-red-500/10 hover:text-red-400"
          >
            <ShieldX size={13} /> Unsubscribe
          </ActionBtn>
          <ActionBtn
            title="Auto-archive future mail"
            onClick={() => bulkAct("AUTO_ARCHIVED")}
            className="hover:bg-amber-500/10 hover:text-amber-400"
          >
            <Archive size={13} /> Archive
          </ActionBtn>
          <ActionBtn
            title="Keep — approve"
            onClick={() => bulkAct("APPROVED")}
            className="hover:bg-emerald-500/10 hover:text-emerald-400"
          >
            <Check size={13} /> Keep
          </ActionBtn>
          <button
            onClick={clearSelection}
            title="Clear selection"
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Select-all header */}
      {visible.length > 0 && (
        <div className="flex items-center gap-2 px-3 sm:px-5 py-1.5 border-b border-border flex-shrink-0 bg-card/60">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = selectedVisible.length > 0 && !allSelected;
            }}
            onChange={toggleAll}
            className="accent-primary"
            title={allSelected ? "Deselect all" : "Select all"}
          />
          <span className="text-[10px] text-muted-foreground">
            {selectedVisible.length > 0 ? `${selectedVisible.length} selected` : "Select all"}
          </span>
          {suggested.length > 0 && (
            <button
              onClick={selectSuggested}
              className="ml-auto text-[10px] text-primary hover:opacity-80"
              title="Select senders you rarely read (under 30% read)"
            >
              Select {suggested.length} suggested
            </button>
          )}
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
            {visible.map((s) => {
              const isSel = selected.has(s.email);
              const isMailto = (s.unsubscribe_link || "").toLowerCase().startsWith("mailto:");
              return (
                <div
                  key={s.email}
                  className={`flex items-center gap-3 px-3 sm:px-5 py-2.5 transition-colors ${
                    isSel ? "bg-primary/5" : "hover:bg-secondary/40"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => toggleOne(s.email)}
                    className="accent-primary flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-foreground truncate">
                        {s.name || s.email}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${STATUS_META[s.status].cls}`}>
                        {STATUS_META[s.status].label}
                      </span>
                      {s.category && s.category !== "Unknown" && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
                          {s.category}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">{s.email}</div>
                  </div>

                  {/* Stats */}
                  <div className="hidden sm:flex items-center gap-4 text-[11px] text-muted-foreground tabular-nums">
                    <div className="text-center">
                      <div className="text-foreground font-medium">{s.count}</div>
                      <div className="text-[9px]">emails</div>
                    </div>
                    <div className="w-20">
                      <div className="flex items-center justify-between mb-0.5">
                        <span
                          className={`font-medium ${
                            s.read_rate < 0.3 ? "text-amber-400" : "text-foreground"
                          }`}
                        >
                          {Math.round(s.read_rate * 100)}%
                        </span>
                        <span className="text-[9px]">read</span>
                      </div>
                      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            s.read_rate < 0.3 ? "bg-amber-400" : "bg-primary"
                          }`}
                          style={{ width: `${Math.round(s.read_rate * 100)}%` }}
                        />
                      </div>
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
                            isMailto
                              ? "Send unsubscribe email & archive"
                              : s.unsubscribe_link
                                ? "Open unsubscribe link & archive"
                                : "Block sender & archive existing"
                          }
                          onClick={() => act(s, "UNSUBSCRIBED", !!s.unsubscribe_link)}
                          className="hover:bg-red-500/10 hover:text-red-400"
                        >
                          {isMailto ? (
                            <Mail size={13} />
                          ) : s.unsubscribe_link ? (
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
              );
            })}
          </div>
        )}
      </div>
      <div className="flex-shrink-0 px-3 sm:px-5 py-2 border-t border-border text-[10px] text-muted-foreground flex items-center gap-1.5">
        <MailMinus size={11} />
        Unsubscribe opens the sender&apos;s List-Unsubscribe link (or email) when
        available and archives their existing mail. Auto-archive blocks future inbox delivery.
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
