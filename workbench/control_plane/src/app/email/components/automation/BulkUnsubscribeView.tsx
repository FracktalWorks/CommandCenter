"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  Loader2, Archive, ArchiveRestore, Check, ExternalLink, Search,
  ShieldX, Mail, X, MoreHorizontal, Trash2, RotateCcw, Clock,
  ChevronDown,
} from "lucide-react";
import {
  listSenders, upsertNewsletter, unsubscribeSender, bulkAction,
  categorizeSenders,
} from "../../lib/api";
import { SenderStat, NewsletterStatus, SenderStatus } from "../../lib/types";
import { useViewMode } from "@/components/ViewModeProvider";

interface BulkUnsubscribeViewProps {
  accountId: string | null;
  /** Called after a bulk archive/cleanup so the parent can refresh the inbox. */
  onArchived?: () => void;
}

/** Age presets for the "Quick clean" sweep (archive read mail older than N). */
const AGE_OPTIONS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
];

/** AI categories that count as bulk/promotional mail for "Newsletters only". */
const BULK_CATEGORIES = new Set(["Newsletter", "Marketing", "Notification"]);

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

export function BulkUnsubscribeView({
  accountId,
  onArchived,
}: BulkUnsubscribeViewProps) {
  const { isMobile } = useViewMode();
  const [senders, setSenders] = useState<SenderStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [onlyNewsletters, setOnlyNewsletters] = useState(true);
  // "Quick clean" age sweep (folded in from the old Archiver).
  const [olderThan, setOlderThan] = useState(30);
  const [onlyRead, setOnlyRead] = useState(true);
  // Default to the "Unhandled" queue (inbox-zero parity) — the senders that
  // still need a decision, not everything.
  const [statusTab, setStatusTab] = useState<StatusTab>("UNHANDLED");
  const [categorizing, setCategorizing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"count" | "read">("count");

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

  // Auto-dismiss the transient result banner.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Categorisation already runs automatically on every sync (just-in-time, per
  // the ingestion scheduler) — so there's no manual "Categorize" button. If a
  // backlog of uncategorised senders is still showing (e.g. a fresh account the
  // sync hasn't caught up on), kick off ONE catch-up pass per account so the
  // category chips + "Newsletters only" filter fill in on their own.
  const autoCategorized = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!accountId || loading || autoCategorized.current.has(accountId)) return;
    const uncategorized = senders.filter(
      (s) => !s.category || s.category === "Unknown"
    ).length;
    if (uncategorized < 10) return;
    autoCategorized.current.add(accountId);
    void (async () => {
      setCategorizing(true);
      try {
        await categorizeSenders(accountId, 100);
      } catch {
        /* sync will categorise on its next cycle anyway */
      }
      setTimeout(() => {
        load();
        setCategorizing(false);
      }, 8000);
    })();
  }, [accountId, loading, senders, load]);

  const isNewsletter = (s: SenderStat) =>
    // Always keep a sender we've already acted on visible, so the toggle can't
    // hide a decision. For an undecided sender, only treat it as a newsletter on
    // a STRONG signal — a real List-Unsubscribe link, or the AI categorised it as
    // bulk/promotional. (The old `count>=3 || read<0.4` matched almost every
    // sender, so the toggle effectively did nothing.)
    s.status !== "UNHANDLED" ||
    !!s.unsubscribe_link ||
    (s.category ? BULK_CATEGORIES.has(s.category) : false);

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
        )
        .sort((a, b) =>
          // "Most emails" (volume) or "Least read" (read-rate ascending —
          // surfaces the senders most worth unsubscribing from).
          sortBy === "read" ? a.read_rate - b.read_rate : b.count - a.count
        ),
    [senders, onlyNewsletters, statusTab, filter, sortBy]
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

  // Approve / auto-archive — a plain disposition set (the backend also creates a
  // provider auto-archive filter for AUTO_ARCHIVED).
  const act = async (s: SenderStat, status: NewsletterStatus) => {
    setBusy(s.email);
    try {
      await persist(s, status);
      setNotice(
        status === "AUTO_ARCHIVED"
          ? `Auto-archiving future mail from ${s.name || s.email}.`
          : `Keeping ${s.name || s.email}.`
      );
    } catch (e) {
      setError((e as Error).message || "Action failed");
    } finally {
      setBusy(null);
    }
  };

  // Real unsubscribe: the server does a one-click POST / sends the unsubscribe
  // email; if there's no usable link or it fails, the sender is blocked
  // (auto-archived + a provider filter). We reflect whatever actually happened.
  const doUnsubscribe = async (s: SenderStat) => {
    if (!accountId) return;
    setBusy(s.email);
    setError(null);
    try {
      const res = await unsubscribeSender({
        accountId, email: s.email, name: s.name,
        unsubscribeLink: s.unsubscribe_link,
      });
      setSenders((prev) =>
        prev.map((x) => (x.email === s.email ? { ...x, status: res.status } : x))
      );
      if (res.ok) {
        setNotice(
          res.method === "mailto"
            ? `Unsubscribe request emailed for ${s.name || s.email}.`
            : `Unsubscribed from ${s.name || s.email}.`
        );
      } else {
        // Couldn't auto-unsubscribe — future mail is now blocked. Open the link
        // (if any) so the user can finish manually.
        const link = res.unsubscribe_link || s.unsubscribe_link;
        if (link && link.toLowerCase().startsWith("http")) openUnsubscribe(link);
        setNotice(
          `No one-click unsubscribe for ${s.name || s.email} — blocked future mail` +
            (link ? " and opened its unsubscribe page." : ".")
        );
      }
    } catch (e) {
      setError((e as Error).message || "Unsubscribe failed");
    } finally {
      setBusy(null);
    }
  };

  const bulkUnsubscribe = async () => {
    if (!accountId) return;
    const targets = visible.filter((s) => selected.has(s.email));
    if (targets.length === 0) return;
    setBusy("__bulk__");
    setError(null);
    let unsubbed = 0;
    let blocked = 0;
    try {
      // Sequential — each does a real server-side unsubscribe (no tab-opening in
      // bulk; that's reserved for the per-row fallback).
      for (const s of targets) {
        try {
          const res = await unsubscribeSender({
            accountId, email: s.email, name: s.name,
            unsubscribeLink: s.unsubscribe_link,
          });
          setSenders((prev) =>
            prev.map((x) =>
              x.email === s.email ? { ...x, status: res.status } : x
            )
          );
          if (res.ok) unsubbed++;
          else blocked++;
        } catch {
          blocked++;
        }
      }
      clearSelection();
      setNotice(
        `Unsubscribed from ${unsubbed}` +
          (blocked ? `, blocked ${blocked} with no one-click link.` : ".")
      );
    } finally {
      setBusy(null);
    }
  };

  const bulkAct = async (status: NewsletterStatus) => {
    const targets = visible.filter((s) => selected.has(s.email));
    if (targets.length === 0) return;
    setBusy("__bulk__");
    try {
      for (const s of targets) await persist(s, status);
      clearSelection();
      setNotice(
        `${status === "AUTO_ARCHIVED" ? "Auto-archiving" : "Keeping"} ` +
          `${targets.length} sender${targets.length > 1 ? "s" : ""}.`
      );
    } catch (e) {
      setError((e as Error).message || "Bulk action failed");
    } finally {
      setBusy(null);
    }
  };

  // One-off cleanup of a sender's EXISTING mail (no disposition change) — the
  // inbox-zero "Archive all" / "Delete all" row + bulk actions.
  const messagesAction = async (
    s: SenderStat,
    action: "archive" | "trash",
  ) => {
    if (!accountId) return;
    if (action === "trash" &&
        !window.confirm(`Move all mail from ${s.name || s.email} to Trash?`)) {
      return;
    }
    setBusy(s.email);
    try {
      const { affected } = await bulkAction({
        action, accountId, senderEmail: s.email,
      });
      setNotice(
        `${action === "archive" ? "Archived" : "Trashed"} ${affected} ` +
          `email${affected === 1 ? "" : "s"} from ${s.name || s.email}.`
      );
    } catch (e) {
      setError((e as Error).message || "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const bulkMessagesAction = async (action: "archive" | "trash") => {
    if (!accountId) return;
    const targets = visible.filter((s) => selected.has(s.email));
    if (targets.length === 0) return;
    if (action === "trash" &&
        !window.confirm(
          `Move all mail from ${targets.length} sender(s) to Trash?`)) {
      return;
    }
    setBusy("__bulk__");
    let total = 0;
    try {
      for (const s of targets) {
        try {
          const { affected } = await bulkAction({
            action, accountId, senderEmail: s.email,
          });
          total += affected;
        } catch {
          /* skip a failed sender, keep going */
        }
      }
      clearSelection();
      setNotice(
        `${action === "archive" ? "Archived" : "Trashed"} ${total} ` +
          `email(s) from ${targets.length} sender(s).`
      );
    } finally {
      setBusy(null);
    }
  };

  // "Quick clean": archive inbox mail older than N days (optionally read-only),
  // across all senders — a non-sender-specific sweep to hit inbox zero fast.
  const quickClean = async () => {
    if (!accountId) return;
    const ageLabel =
      AGE_OPTIONS.find((o) => o.days === olderThan)?.label ?? `${olderThan}d`;
    if (
      !window.confirm(
        `Archive ${onlyRead ? "read " : ""}inbox mail older than ${ageLabel}?`
      )
    ) {
      return;
    }
    setBusy("__sweep__");
    setError(null);
    try {
      const { affected } = await bulkAction({
        action: "archive",
        accountId,
        folder: "inbox",
        olderThanDays: olderThan,
        onlyRead,
      });
      setNotice(`Archived ${affected} old message${affected === 1 ? "" : "s"}.`);
      onArchived?.();
      load();
    } catch (e) {
      setError((e as Error).message || "Archive failed");
    } finally {
      setBusy(null);
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
        <div className="flex items-center gap-1 bg-secondary rounded-md p-0.5">
          {(["count", "read"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setSortBy(k)}
              title={
                k === "count" ? "Sort by volume" : "Sort by least-read first"
              }
              className={`px-2 py-1 rounded text-[11px] transition-colors ${
                sortBy === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {k === "count" ? "Most emails" : "Least read"}
            </button>
          ))}
        </div>
        {categorizing && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground ml-auto whitespace-nowrap">
            <Loader2 className="animate-spin" size={13} /> Categorizing…
          </div>
        )}
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
      {notice && (
        <div className="px-3 sm:px-5 py-2 text-xs text-primary bg-primary/10 border-b border-border flex items-center gap-1.5">
          <Check size={12} className="flex-shrink-0" />
          {notice}
        </div>
      )}

      {/* Bulk action bar */}
      {selectedVisible.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 sm:px-5 py-2 border-b border-border bg-primary/10 flex-shrink-0 overflow-x-auto scrollbar-hide">
          <span className="text-[11px] font-medium text-foreground">
            {selectedVisible.length} selected
          </span>
          <div className="flex-1" />
          {isMobile ? (
            <ActionMenu
              label="Actions"
              items={[
                { label: "Unsubscribe", icon: <ShieldX size={13} />,
                  onClick: () => bulkUnsubscribe() },
                { label: "Auto-archive future", icon: <ArchiveRestore size={13} />,
                  onClick: () => bulkAct("AUTO_ARCHIVED") },
                { label: "Keep", icon: <Check size={13} />,
                  onClick: () => bulkAct("APPROVED") },
                { sep: true },
                { label: "Archive all existing", icon: <Archive size={13} />,
                  onClick: () => bulkMessagesAction("archive") },
                { label: "Delete all", icon: <Trash2 size={13} />, danger: true,
                  onClick: () => bulkMessagesAction("trash") },
              ]}
            />
          ) : (
            <>
              <ActionBtn
                title="One-click unsubscribe each (blocks future mail when no link)"
                onClick={() => bulkUnsubscribe()}
                className="hover:bg-red-500/10 hover:text-red-400"
              >
                <ShieldX size={13} /> Unsubscribe
              </ActionBtn>
              <ActionBtn
                title="Auto-archive future mail (provider filter)"
                onClick={() => bulkAct("AUTO_ARCHIVED")}
                className="hover:bg-amber-500/10 hover:text-amber-400"
              >
                <ArchiveRestore size={13} /> Auto-archive
              </ActionBtn>
              <ActionBtn
                title="Keep — approve"
                onClick={() => bulkAct("APPROVED")}
                className="hover:bg-emerald-500/10 hover:text-emerald-400"
              >
                <Check size={13} /> Keep
              </ActionBtn>
              <div className="w-px h-4 bg-border mx-0.5" />
              <ActionBtn
                title="Archive all existing mail from the selected senders"
                onClick={() => bulkMessagesAction("archive")}
                className="hover:bg-secondary"
              >
                <Archive size={13} /> Archive all
              </ActionBtn>
              <ActionBtn
                title="Move all existing mail from the selected senders to Trash"
                onClick={() => bulkMessagesAction("trash")}
                className="hover:bg-red-500/10 hover:text-red-400"
              >
                <Trash2 size={13} /> Delete
              </ActionBtn>
            </>
          )}
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
              const blocked =
                s.status === "UNSUBSCRIBED" || s.status === "AUTO_ARCHIVED";
              const approved = s.status === "APPROVED";
              const unsubIcon = isMailto ? (
                <Mail size={13} />
              ) : s.unsubscribe_link ? (
                <ExternalLink size={13} />
              ) : (
                <ShieldX size={13} />
              );
              // One-off existing-mail cleanup (the desktop kebab + part of the
              // mobile "Actions" menu).
              const cleanupItems: MenuItem[] = [
                { label: "Archive all existing", icon: <Archive size={13} />,
                  onClick: () => messagesAction(s, "archive") },
                { label: "Delete all", icon: <Trash2 size={13} />, danger: true,
                  onClick: () => messagesAction(s, "trash") },
              ];
              // Full action set for the mobile single "Actions" button.
              const rowItems: MenuItem[] = [
                ...(blocked
                  ? [{ label: "Resubscribe", icon: <RotateCcw size={13} />,
                       onClick: () => act(s, "APPROVED") }]
                  : [
                      { label: s.unsubscribe_link ? "Unsubscribe" : "Block",
                        icon: unsubIcon, onClick: () => doUnsubscribe(s) },
                      { label: "Auto-archive future",
                        icon: <ArchiveRestore size={13} />,
                        onClick: () => act(s, "AUTO_ARCHIVED") },
                      ...(approved
                        ? []
                        : [{ label: "Keep", icon: <Check size={13} />,
                            onClick: () => act(s, "APPROVED") }]),
                    ]),
                { sep: true },
                ...cleanupItems,
              ];
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
                      {s.filter_active && (
                        <span
                          title="Future mail blocked at the source by a provider filter"
                          className="text-[9px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-400 flex items-center gap-0.5"
                        >
                          <ShieldX size={9} /> Filtered
                        </span>
                      )}
                      {s.category && s.category !== "Unknown" && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
                          {s.category}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">{s.email}</div>
                  </div>

                  {/* Stats — email volume (the priority signal) + a compact
                      read-rate ring. Visible on mobile and desktop alike. */}
                  <div className="flex items-center gap-2.5 flex-shrink-0">
                    <div className="text-right leading-none">
                      <div className="text-xs font-semibold text-foreground tabular-nums">
                        {s.count}
                      </div>
                      <div className="text-[8px] text-muted-foreground mt-0.5">
                        emails
                      </div>
                    </div>
                    <ReadRing value={s.read_rate} />
                  </div>

                  {/* Actions — one "Actions" menu on mobile; on desktop every
                      action is surfaced inline (there's room for the icons). */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {busy === s.email ? (
                      <Loader2 className="animate-spin text-muted-foreground" size={14} />
                    ) : isMobile ? (
                      <ActionMenu label="Actions" items={rowItems} />
                    ) : blocked ? (
                      <>
                        <ActionBtn
                          title="Resubscribe — keep this sender and remove its auto-archive filter"
                          onClick={() => act(s, "APPROVED")}
                          className="hover:bg-emerald-500/10 hover:text-emerald-400"
                        >
                          <RotateCcw size={13} /> Resubscribe
                        </ActionBtn>
                        <ActionBtn
                          title="Archive all existing mail from this sender"
                          onClick={() => messagesAction(s, "archive")}
                          className="hover:bg-secondary"
                        >
                          <Archive size={13} />
                        </ActionBtn>
                        <ActionBtn
                          title="Delete all mail from this sender (move to Trash)"
                          onClick={() => messagesAction(s, "trash")}
                          className="hover:bg-red-500/10 hover:text-red-400"
                        >
                          <Trash2 size={13} />
                        </ActionBtn>
                      </>
                    ) : (
                      <>
                        <ActionBtn
                          title={
                            isMailto
                              ? "Send the unsubscribe email & archive"
                              : s.unsubscribe_link
                                ? "One-click unsubscribe & archive"
                                : "Block sender & archive existing"
                          }
                          onClick={() => doUnsubscribe(s)}
                          className="hover:bg-red-500/10 hover:text-red-400"
                        >
                          {unsubIcon}
                          {s.unsubscribe_link ? "Unsub" : "Block"}
                        </ActionBtn>
                        <ActionBtn
                          title="Auto-archive future mail from this sender"
                          onClick={() => act(s, "AUTO_ARCHIVED")}
                          className="hover:bg-amber-500/10 hover:text-amber-400"
                        >
                          <ArchiveRestore size={13} /> Auto-archive
                        </ActionBtn>
                        {!approved && (
                          <ActionBtn
                            title="Keep — approve this sender"
                            onClick={() => act(s, "APPROVED")}
                            className="hover:bg-emerald-500/10 hover:text-emerald-400"
                          >
                            <Check size={13} /> Keep
                          </ActionBtn>
                        )}
                        <ActionBtn
                          title="Archive all existing mail from this sender"
                          onClick={() => messagesAction(s, "archive")}
                          className="hover:bg-secondary"
                        >
                          <Archive size={13} />
                        </ActionBtn>
                        <ActionBtn
                          title="Delete all mail from this sender (move to Trash)"
                          onClick={() => messagesAction(s, "trash")}
                          className="hover:bg-red-500/10 hover:text-red-400"
                        >
                          <Trash2 size={13} />
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
      {/* Quick clean — age-based bulk archive across ALL senders. Pinned to the
          bottom: it's a standalone sweep, independent of the sender list above. */}
      <div className="flex-shrink-0 flex items-center flex-wrap gap-2 px-3 sm:px-5 py-2 border-t border-border bg-card/40">
        <Clock size={12} className="text-primary flex-shrink-0" />
        <span className="text-[11px] text-muted-foreground">
          Archive {onlyRead ? "read " : ""}mail older than
        </span>
        <div className="flex items-center gap-0.5 bg-secondary rounded-md p-0.5">
          {AGE_OPTIONS.map((o) => (
            <button
              key={o.days}
              onClick={() => setOlderThan(o.days)}
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                olderThan === o.days
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={onlyRead}
            onChange={(e) => setOnlyRead(e.target.checked)}
            className="accent-primary"
          />
          Only read
        </label>
        <button
          onClick={quickClean}
          disabled={busy === "__sweep__"}
          title="Archive old inbox mail in one sweep (all senders)"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 ml-auto"
        >
          {busy === "__sweep__" ? (
            <Loader2 className="animate-spin" size={12} />
          ) : (
            <Archive size={12} />
          )}
          Archive old mail
        </button>
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

/** Compact circular read-rate indicator — fits on mobile and web without the
 *  horizontal space a linear bar needs. Amber when the read rate is low (a
 *  strong "worth unsubscribing" signal), primary otherwise. */
function ReadRing({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  const r = 9;
  const circ = 2 * Math.PI * r;
  const low = value < 0.3;
  return (
    <div
      className="relative flex items-center justify-center flex-shrink-0"
      title={`${pct}% read`}
    >
      <svg width="26" height="26" viewBox="0 0 26 26" className="-rotate-90">
        <circle
          cx="13" cy="13" r={r} fill="none" strokeWidth="3"
          className="stroke-secondary"
        />
        <circle
          cx="13" cy="13" r={r} fill="none" strokeWidth="3" strokeLinecap="round"
          className={low ? "stroke-amber-400" : "stroke-primary"}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct / 100)}
        />
      </svg>
      <span
        className={`absolute text-[8px] font-semibold tabular-nums ${
          low ? "text-amber-400" : "text-foreground"
        }`}
      >
        {pct}
      </span>
    </div>
  );
}

type MenuItem =
  | { sep: true }
  | {
      label: string;
      icon: React.ReactNode;
      onClick: () => void;
      danger?: boolean;
    };

/** Dropdown of actions. With `label` it renders a labelled "Actions ▾" button
 *  (used on mobile to collapse the row/bulk buttons into one); without one it's a
 *  compact kebab. Mirrors the popover pattern used in EmailToolbar. */
function ActionMenu({ items, label }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title={label || "More actions"}
        className={`flex items-center gap-1 rounded-md text-[11px] text-muted-foreground border border-border hover:text-foreground hover:bg-secondary transition-colors ${
          label ? "px-2.5 py-1.5 font-medium" : "p-1.5"
        }`}
      >
        {label ? (
          <>
            {label}
            <ChevronDown size={12} />
          </>
        ) : (
          <MoreHorizontal size={13} />
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-20 bg-popover border border-border rounded-lg shadow-xl py-1 w-52 text-xs max-h-[60vh] overflow-y-auto">
            {items.map((it, i) =>
              "sep" in it ? (
                <div key={i} className="my-1 h-px bg-border" />
              ) : (
                <button
                  key={i}
                  onClick={() => {
                    setOpen(false);
                    it.onClick();
                  }}
                  className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${
                    it.danger
                      ? "text-red-400 hover:bg-red-500/10"
                      : "text-foreground hover:bg-secondary"
                  }`}
                >
                  {it.icon}
                  {it.label}
                </button>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}
