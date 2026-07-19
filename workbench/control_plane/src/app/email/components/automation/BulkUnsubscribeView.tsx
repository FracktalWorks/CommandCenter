"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  Loader2, Archive, ArchiveRestore, Check, ExternalLink, Search,
  ShieldX, Mail, X, MoreHorizontal, Trash2, RotateCcw, Clock,
  ChevronDown, ChevronRight, Sparkles, HelpCircle,
} from "lucide-react";
import {
  listSenders, upsertNewsletter, unsubscribeSender, bulkAction,
  searchEmails, previewAutoCategorize, runAutoCategorize, getCleanupStatus,
  CleanupSweepResult,
} from "../../lib/api";
import { SenderStat, NewsletterStatus, SenderStatus, Email } from "../../lib/types";
import { chipColors } from "../../lib/labelColors";
import { useEmailStore } from "../../lib/emailStore";
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

/** Cleanup categories used as filter tabs — derived from the rule-labelled
 *  per-message categories (email_messages.categories), most-cleanable first.
 *  Driving the cleaner off these (not a provisional sender guess) is what makes
 *  newsletters / marketing / notifications / cold email actually surface. */
const CATEGORY_TABS = [
  "Newsletter", "Marketing", "Notification", "Cold Email", "Receipt", "Calendar",
] as const;

/** Pseudo-category for senders the rules never labelled at all. Not a real
 *  category — it's the *absence* of one, and it's the pile the auto-categorize
 *  sweep exists to drain. Kept separate from the real chips so it can never be
 *  confused for a classification. */
const UNCATEGORIZED = "__uncategorized__";

const STATUS_META: Record<SenderStatus, { label: string; cls: string; help: string }> = {
  UNHANDLED: {
    label: "Unhandled", cls: "bg-secondary text-muted-foreground",
    help: "No decision yet",
  },
  APPROVED: {
    label: "Kept", cls: "bg-emerald-500/15 text-emerald-400",
    help: "Approved — stays in your inbox",
  },
  UNSUBSCRIBED: {
    label: "Unsubscribed", cls: "bg-red-500/15 text-red-400",
    help: "We sent a real unsubscribe request to the sender",
  },
  AUTO_ARCHIVED: {
    label: "Auto-archived", cls: "bg-amber-500/15 text-amber-400",
    help: "Future mail is archived automatically (blocked at the source)",
  },
};

/** Display status: "blocked" is not a stored status — it's the auto-archive
 *  fallback when a sender has no unsubscribe link (we couldn't unsubscribe, so we
 *  block future mail via a provider filter). Surface it distinctly from a
 *  deliberate "Auto-archived" so the user can tell them apart. */
function displayStatus(s: SenderStat): { label: string; cls: string; help: string } {
  if (s.status === "AUTO_ARCHIVED" && s.filter_active && !s.unsubscribe_link) {
    return {
      label: "Blocked", cls: "bg-orange-500/15 text-orange-400",
      help: "No unsubscribe link — future mail is blocked at the source by a provider filter",
    };
  }
  return STATUS_META[s.status];
}

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
  const labelColors = useEmailStore((s) => s.labelColors);
  const [senders, setSenders] = useState<SenderStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Category filter (derived from per-message rule labels). "all" = every sender.
  const [categoryTab, setCategoryTab] = useState<string>("all");
  // "Quick clean" age sweep (folded in from the old Archiver).
  const [olderThan, setOlderThan] = useState(30);
  const [onlyRead, setOnlyRead] = useState(true);
  // Show every sender by default so nothing is hidden — the category chips and
  // status tabs narrow it. (The old "Unhandled + newsletters-only" default hid
  // most notification/marketing senders, the reported problem.)
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [categorizing, setCategorizing] = useState(false);
  // Dry-run verdict for the uncategorized sweep: what it *would* do.
  const [preview, setPreview] = useState<CleanupSweepResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"count" | "read">("count");
  // Which sender row is expanded to show its individual messages (drill-down).
  const [expanded, setExpanded] = useState<string | null>(null);

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

  // Preview of what the auto-categorize sweep would do, fetched once per account.
  // It's a dry run — decides everything, writes nothing — so it's safe to fire on
  // load and it tells the user the honest split: how much can be resolved from
  // what they've already taught the assistant, and how much genuinely needs the
  // rules to run. The previous version of this effect silently POSTed a
  // categorize job and waited 8s on a timer; it re-projected the same labels it
  // already had, so it could never change anything the user was looking at.
  const previewed = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!accountId || loading || previewed.current.has(accountId)) return;
    previewed.current.add(accountId);
    let alive = true;
    void (async () => {
      try {
        const r = await previewAutoCategorize(accountId, 500);
        if (alive) setPreview(r);
      } catch {
        /* the sweep is an offer, not a requirement — stay quiet on failure */
      }
    })();
    return () => {
      alive = false;
    };
  }, [accountId, loading]);

  // A sender matches the active category when any of its mail carries that
  // rule-label (its derived `categories`). "all" matches everyone, and the
  // Uncategorized pseudo-tab matches senders the rules never labelled.
  const matchesCategory = useCallback(
    (s: SenderStat) => {
      if (categoryTab === "all") return true;
      if (categoryTab === UNCATEGORIZED) return !(s.labelled ?? 0);
      return (s.categories || []).includes(categoryTab);
    },
    [categoryTab]
  );

  const visible = useMemo(
    () =>
      senders
        .filter(matchesCategory)
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
    [senders, matchesCategory, statusTab, filter, sortBy]
  );

  // Status-tab badges: count within the active category (not status).
  const counts = useMemo(() => {
    const base = senders.filter(matchesCategory);
    const c: Record<string, number> = { all: base.length };
    for (const s of base) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [senders, matchesCategory]);

  // Category-chip badges: count within the active status (not category).
  const categoryCounts = useMemo(() => {
    const base = senders.filter(
      (s) => statusTab === "all" || s.status === statusTab
    );
    const c: Record<string, number> = { all: base.length };
    for (const cat of CATEGORY_TABS) {
      c[cat] = base.filter((s) => (s.categories || []).includes(cat)).length;
    }
    c[UNCATEGORIZED] = base.filter((s) => !(s.labelled ?? 0)).length;
    return c;
  }, [senders, statusTab]);

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
      // The sender's inbox mail just left for Archive/Trash, so its row is stale.
      // Drop it optimistically (and from any selection) rather than leaving it on
      // screen with a now-wrong count until a manual reload — the reported bug.
      if (affected > 0) {
        setSenders((prev) => prev.filter((x) => x.email !== s.email));
        setSelected((prev) => {
          const n = new Set(prev);
          n.delete(s.email);
          return n;
        });
      }
      setNotice(
        `${action === "archive" ? "Archived" : "Trashed"} ${affected} ` +
          `email${affected === 1 ? "" : "s"} from ${s.name || s.email}.`
      );
      // Keep the main inbox pane in sync with what we just removed.
      onArchived?.();
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
    const done: string[] = [];
    try {
      for (const s of targets) {
        try {
          const { affected } = await bulkAction({
            action, accountId, senderEmail: s.email,
          });
          total += affected;
          if (affected > 0) done.push(s.email);
        } catch {
          /* skip a failed sender, keep going */
        }
      }
      // Drop the senders whose mail we just cleared out — their rows are stale.
      if (done.length) {
        const gone = new Set(done);
        setSenders((prev) => prev.filter((x) => !gone.has(x.email)));
      }
      clearSelection();
      setNotice(
        `${action === "archive" ? "Archived" : "Trashed"} ${total} ` +
          `email(s) from ${targets.length} sender(s).`
      );
      onArchived?.();
    } finally {
      setBusy(null);
    }
  };

  // Auto-categorize: drain the uncategorized pile by projecting what the
  // assistant already knows — learned patterns first, then this sender's own
  // label history, then their domain's. It runs no classifier of its own, so
  // anything it can't justify is left alone and reported as needing a rules run.
  // Runs in the background (a provider label write per message), so we poll.
  const autoCategorize = async () => {
    if (!accountId || !preview?.categorized) return;
    setCategorizing(true);
    setError(null);
    try {
      await runAutoCategorize(accountId, 500);
      // Poll to completion, with a hard ceiling so a stalled job can't leave the
      // spinner running forever.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await getCleanupStatus(accountId);
        if (st.status === "done") {
          const n = st.categorized ?? st.applied ?? 0;
          setNotice(
            `Categorized ${n} email${n === 1 ? "" : "s"} from patterns you've ` +
              `already taught the assistant.`
          );
          break;
        }
        if (st.status === "error") {
          setError("Auto-categorize failed — see the assistant history.");
          break;
        }
        if (i === 59) {
          setNotice("Still categorizing — the list will catch up on refresh.");
        }
      }
      setPreview(null);
      load();
      onArchived?.();
    } catch (e) {
      setError((e as Error).message || "Auto-categorize failed");
    } finally {
      setCategorizing(false);
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

      {/* Category filter — driven off per-message rule labels, so newsletters,
          marketing, notifications & cold email actually surface here (the old
          "Newsletters only" toggle hid most of them). */}
      <div className="flex items-center gap-1.5 px-3 sm:px-5 py-2 border-b border-border flex-shrink-0 overflow-x-auto scrollbar-hide">
        <button
          onClick={() => setCategoryTab("all")}
          className={`px-2.5 py-1 rounded-full text-[11px] whitespace-nowrap transition-colors ${
            categoryTab === "all"
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary"
          }`}
        >
          All <span className="opacity-60">{categoryCounts.all ?? 0}</span>
        </button>
        {CATEGORY_TABS.map((cat) => {
          const active = categoryTab === cat;
          const c = chipColors(cat, labelColors);
          return (
            <button
              key={cat}
              onClick={() => setCategoryTab(active ? "all" : cat)}
              style={active ? { backgroundColor: c.bg, color: c.text } : undefined}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] whitespace-nowrap border transition-colors ${
                active
                  ? "border-transparent"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
              }`}
            >
              {!active && (
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: c.bg }}
                />
              )}
              {cat}
              <span className="opacity-60">{categoryCounts[cat] ?? 0}</span>
            </button>
          );
        })}
        {/* Not a category — the absence of one. Kept visually distinct (dashed,
            muted, no colour dot) so it never reads as a classification. */}
        {(categoryCounts[UNCATEGORIZED] ?? 0) > 0 && (
          <button
            onClick={() =>
              setCategoryTab(
                categoryTab === UNCATEGORIZED ? "all" : UNCATEGORIZED
              )
            }
            title="Senders whose mail your rules have never labelled"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] whitespace-nowrap border border-dashed transition-colors ${
              categoryTab === UNCATEGORIZED
                ? "border-primary text-primary bg-primary/10"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
          >
            <HelpCircle size={10} />
            Uncategorized
            <span className="opacity-60">{categoryCounts[UNCATEGORIZED]}</span>
          </button>
        )}
      </div>

      {/* Auto-categorize offer. Only shown when the sweep actually has evidence
          to act on, and it states plainly what it can and cannot resolve — the
          leftover is mail no pattern covers, which needs the assistant's rules
          to run rather than a guess from here. */}
      {preview && preview.categorized > 0 && (
        <div className="flex items-center flex-wrap gap-2 px-3 sm:px-5 py-2 border-b border-border bg-primary/5 flex-shrink-0">
          <Sparkles size={13} className="text-primary flex-shrink-0" />
          <span className="text-[11px] text-foreground">
            <strong className="font-semibold">{preview.categorized}</strong>{" "}
            uncategorized email
            {preview.categorized === 1 ? "" : "s"} match patterns you&apos;ve
            already taught the assistant
            {preview.no_evidence > 0 && (
              <span className="text-muted-foreground">
                {" "}
                · {preview.no_evidence} need the rules to run
              </span>
            )}
          </span>
          <button
            onClick={autoCategorize}
            disabled={categorizing}
            title="Apply the categories these emails' senders, domains and learned patterns already imply"
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {categorizing ? (
              <Loader2 className="animate-spin" size={12} />
            ) : (
              <Sparkles size={12} />
            )}
            Categorize
          </button>
        </div>
      )}

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
              // Older payloads have no in_folder — fall back to count so the
              // number never renders as 0 against a populated row.
              const inInbox = s.in_folder ?? s.count;
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
                  className={expanded === s.email ? "bg-secondary/20" : ""}
                >
                <div
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
                  <button
                    onClick={() =>
                      setExpanded(expanded === s.email ? null : s.email)
                    }
                    title={
                      expanded === s.email
                        ? "Hide this sender's messages"
                        : "Show this sender's messages"
                    }
                    aria-label="Toggle messages"
                    className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0"
                  >
                    {expanded === s.email ? (
                      <ChevronDown size={13} />
                    ) : (
                      <ChevronRight size={13} />
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-foreground truncate">
                        {s.name || s.email}
                      </span>
                      {(() => {
                        const d = displayStatus(s);
                        return (
                          <span
                            title={d.help}
                            className={`text-[9px] px-1.5 py-0.5 rounded-full ${d.cls}`}
                          >
                            {d.label}
                          </span>
                        );
                      })()}
                      {s.filter_active && (
                        <span
                          title="Future mail blocked at the source by a provider filter"
                          className="text-[9px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-400 flex items-center gap-0.5"
                        >
                          <ShieldX size={9} /> Filtered
                        </span>
                      )}
                      {/* Category chips — the rule-labelled cleanup categories on
                          this sender's mail (never a provisional guess), coloured
                          with the same scheme as chips app-wide. */}
                      {(s.categories || []).slice(0, 2).map((cat) => {
                        const c = chipColors(cat, labelColors);
                        return (
                          <span
                            key={cat}
                            title="From your rules — same categorization as the rest of the app"
                            style={{ backgroundColor: c.bg, color: c.text }}
                            className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                          >
                            {cat}
                          </span>
                        );
                      })}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">{s.email}</div>
                  </div>

                  {/* Stats — email volume (the priority signal) + a compact
                      read-rate ring. Visible on mobile and desktop alike. */}
                  <div className="flex items-center gap-2.5 flex-shrink-0">
                    <div
                      className="text-right leading-none"
                      title={
                        inInbox === s.count
                          ? `${s.count} emails in your inbox`
                          : `${inInbox} in your inbox · ${s.count} total (the rest are already archived or trashed)`
                      }
                    >
                      <div className="text-xs font-semibold text-foreground tabular-nums">
                        {inInbox}
                        {inInbox !== s.count && (
                          <span className="text-muted-foreground font-normal">
                            /{s.count}
                          </span>
                        )}
                      </div>
                      <div className="text-[8px] text-muted-foreground mt-0.5">
                        {inInbox === s.count ? "emails" : "in inbox"}
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
                {expanded === s.email && (
                  <SenderMessages
                    accountId={accountId}
                    email={s.email}
                    labelColors={labelColors}
                  />
                )}
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

/** Drill-down: the individual messages from one sender, so the user can see
 *  exactly which emails are affected (blocked / auto-archived / …) and act on
 *  them one at a time. Fetched on demand via the search endpoint (from: sender)
 *  across all folders. */
function SenderMessages({
  accountId,
  email,
  labelColors,
}: {
  accountId: string;
  email: string;
  labelColors: Record<string, string | null>;
}) {
  const [msgs, setMsgs] = useState<Email[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    searchEmails({ accountId, fromAddr: email, folder: "all", pageSize: 25 })
      .then((r) => {
        if (alive) setMsgs(r.emails);
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message || "Failed to load messages");
      });
    return () => {
      alive = false;
    };
  }, [accountId, email]);

  const act = async (id: string, action: "archive" | "trash") => {
    setBusyId(id);
    try {
      await bulkAction({ action, accountId, messageIds: [id] });
      setMsgs((prev) => (prev || []).filter((m) => m.id !== id));
    } catch (e) {
      setErr((e as Error).message || "Action failed");
    } finally {
      setBusyId(null);
    }
  };

  if (err) {
    return <div className="px-10 py-2 text-[11px] text-destructive">{err}</div>;
  }
  if (!msgs) {
    return (
      <div className="px-10 py-3 text-[11px] text-muted-foreground flex items-center gap-1.5">
        <Loader2 className="animate-spin" size={12} /> Loading messages…
      </div>
    );
  }
  if (msgs.length === 0) {
    return (
      <div className="px-10 py-2 text-[11px] text-muted-foreground">
        No messages found for this sender.
      </div>
    );
  }
  return (
    <div className="pl-10 pr-3 sm:pr-5 pb-2 divide-y divide-border/60">
      {msgs.map((m) => (
        <div key={m.id} className="flex items-center gap-2 py-1.5">
          {!m.isRead && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0"
              title="Unread"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-foreground truncate">
              {m.subject || "(no subject)"}
            </div>
            {m.snippet && (
              <div className="text-[10px] text-muted-foreground truncate">
                {m.snippet}
              </div>
            )}
          </div>
          {(m.categories || []).slice(0, 2).map((cat) => {
            const c = chipColors(cat, labelColors);
            return (
              <span
                key={cat}
                style={{ backgroundColor: c.bg, color: c.text }}
                className="text-[9px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0"
              >
                {cat}
              </span>
            );
          })}
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground flex-shrink-0 capitalize">
            {m.folder}
          </span>
          <span className="text-[10px] text-muted-foreground tabular-nums flex-shrink-0 w-12 text-right">
            {m.receivedAt
              ? new Date(m.receivedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })
              : ""}
          </span>
          {busyId === m.id ? (
            <Loader2
              className="animate-spin text-muted-foreground flex-shrink-0"
              size={12}
            />
          ) : (
            <>
              <button
                onClick={() => act(m.id, "archive")}
                title="Archive this message"
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0"
              >
                <Archive size={12} />
              </button>
              <button
                onClick={() => act(m.id, "trash")}
                title="Delete this message (move to Trash)"
                className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors flex-shrink-0"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
      ))}
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
