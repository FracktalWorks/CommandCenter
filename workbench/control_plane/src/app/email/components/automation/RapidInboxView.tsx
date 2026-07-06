"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  Loader2, Reply, Clock, PenLine, Mail, Check, CheckCircle2, RotateCcw,
  RefreshCw, Info, Newspaper, Megaphone, Calendar, Receipt, Bell, Snowflake,
  Archive, Trash2, ChevronRight, Send, Search, X, Sparkles, Paperclip,
  BellRing, Keyboard,
} from "lucide-react";
import {
  getReplyZero, draftReplySmart, resolveThread, reclassifyReplyZero,
  listEmails, getEmail, updateEmail, deleteEmail, sendEmail, saveDraftText,
  scanFollowUps,
} from "../../lib/api";
import { ReplyZeroThread, Email } from "../../lib/types";
import { timeLabel, fullDateLabel } from "../../lib/utils";
import { deterministicPreset, presetHex, textOn } from "../../lib/labelColors";
import { MessageContent } from "../MessageContent";

interface RapidInboxViewProps {
  accountId: string | null;
  /** Called after an archive/delete so the parent can refresh the inbox. */
  onArchived?: () => void;
}

/**
 * A Rapid Inbox category. "Needs you" buckets (To Reply / Awaiting / Done) come
 * from the Reply Zero thread-status projection and carry the reason + existing
 * draft; the "Sorted" categories are provider labels applied by the rules, read
 * straight from the message list (`listEmails({ label })`). Both collapse to the
 * same `RapidItem` so a single card renders every category.
 */
type CatSource = "bucket" | "label";
type Bucket = "needs_reply" | "awaiting" | "done";

interface Category {
  key: string;
  label: string;
  icon: React.ElementType;
  source: CatSource;
  group: "needs" | "sorted";
  bucket?: Bucket;
  /** Active-chip + tag palette (works on light & dark). */
  cls: string;
}

const CATEGORIES: Category[] = [
  { key: "to_reply", label: "To Reply", icon: Reply, source: "bucket",
    group: "needs", bucket: "needs_reply",
    cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  { key: "awaiting", label: "Awaiting", icon: Clock, source: "bucket",
    group: "needs", bucket: "awaiting",
    cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  { key: "done", label: "Done", icon: CheckCircle2, source: "bucket",
    group: "needs", bucket: "done",
    cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  { key: "fyi", label: "FYI", icon: Info, source: "label", group: "sorted",
    cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  { key: "newsletter", label: "Newsletter", icon: Newspaper, source: "label",
    group: "sorted",
    cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  { key: "marketing", label: "Marketing", icon: Megaphone, source: "label",
    group: "sorted",
    cls: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  { key: "calendar", label: "Calendar", icon: Calendar, source: "label",
    group: "sorted",
    cls: "bg-teal-500/15 text-teal-600 dark:text-teal-400" },
  { key: "receipt", label: "Receipt", icon: Receipt, source: "label",
    group: "sorted",
    cls: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400" },
  { key: "notification", label: "Notification", icon: Bell, source: "label",
    group: "sorted",
    cls: "bg-slate-500/15 text-slate-600 dark:text-slate-300" },
  { key: "cold", label: "Cold Email", icon: Snowflake, source: "label",
    group: "sorted",
    cls: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400" },
];

type SortKey = "newest" | "oldest" | "unread";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "unread", label: "Unread" },
];

/** The one shape every category's rows render as. */
interface RapidItem {
  messageId: string;
  threadId?: string;
  subject: string;
  from: string;
  fromEmail: string;
  receivedAt: string | null;
  isRead: boolean;
  preview?: string;
  reason?: string;
  draftId?: string | null;
  draftPreview?: string | null;
  awaitingDays?: number | null;
  needsFollowUp?: boolean;
}

function fromThread(t: ReplyZeroThread): RapidItem {
  return {
    messageId: t.message_id,
    threadId: t.thread_id,
    subject: t.subject,
    from: t.from,
    fromEmail: t.from_email,
    receivedAt: t.received_at,
    isRead: t.is_read,
    preview: t.reason || undefined,
    reason: t.reason,
    draftId: t.draft_id,
    draftPreview: t.draft_preview,
    awaitingDays: t.awaiting_days,
    needsFollowUp: t.needs_follow_up,
  };
}

function fromEmail(e: Email): RapidItem {
  return {
    messageId: e.id,
    threadId: e.threadId,
    subject: e.subject || "(no subject)",
    from: e.from.name || e.from.email,
    fromEmail: e.from.email,
    receivedAt: e.receivedAt,
    isRead: e.isRead,
    preview: e.snippet || undefined,
  };
}

export function RapidInboxView({ accountId, onArchived }: RapidInboxViewProps) {
  const [catKey, setCatKey] = useState<string>("to_reply");
  const cat = useMemo(
    () => CATEGORIES.find((c) => c.key === catKey) ?? CATEGORIES[0],
    [catKey],
  );

  const [items, setItems] = useState<RapidItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [reclassifying, setReclassifying] = useState(false);
  const [scanningFu, setScanningFu] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [showKeys, setShowKeys] = useState(false);

  // Which card is expanded, and which has its reply composer open. Both are
  // parent-owned so keyboard shortcuts can drive them.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [replyForId, setReplyForId] = useState<string | null>(null);
  const [fullCache, setFullCache] = useState<Record<string, Email>>({});
  const [fullLoading, setFullLoading] = useState<string | null>(null);

  // Keyboard focus (the "cursor" for j/k triage).
  const [focusIdx, setFocusIdx] = useState(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Bulk selection (inbox-cleaner parity).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  // A transient toast: a message plus an optional Undo action.
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);

  // ── Load the active category ──
  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setExpandedId(null);
    setReplyForId(null);
    const active = CATEGORIES.find((c) => c.key === catKey) ?? CATEGORIES[0];
    const req: Promise<RapidItem[]> =
      active.source === "bucket"
        ? getReplyZero(accountId, active.bucket!, 100).then((ts) => ts.map(fromThread))
        : listEmails({ accountId, label: active.label, pageSize: 60 }).then((r) =>
            r.emails.map(fromEmail),
          );
    req
      .then((its) => setItems(its))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [accountId, catKey]);

  useEffect(load, [load]);

  // ── Category counts, fetched in the background so the chips fill in ──
  const loadCounts = useCallback(() => {
    if (!accountId) return;
    CATEGORIES.forEach((c) => {
      const p =
        c.source === "bucket"
          ? getReplyZero(accountId, c.bucket!, 100).then((ts) => ts.length)
          : listEmails({ accountId, label: c.label, pageSize: 1 }).then(
              (r) => r.total,
            );
      p.then((n) => setCounts((prev) => ({ ...prev, [c.key]: n }))).catch(
        () => undefined,
      );
    });
  }, [accountId]);

  useEffect(() => {
    setCounts({});
    loadCounts();
  }, [loadCounts]);

  // Auto-dismiss the toast (undo toasts linger a little longer).
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo ? 7000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Derived list (filter + sort) ──
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (it) =>
            it.subject.toLowerCase().includes(q) ||
            it.from.toLowerCase().includes(q) ||
            it.fromEmail.toLowerCase().includes(q),
        )
      : items;
    const at = (it: RapidItem) =>
      it.receivedAt ? new Date(it.receivedAt).getTime() : 0;
    const sorted = [...filtered];
    if (sort === "oldest") sorted.sort((a, b) => at(a) - at(b));
    else if (sort === "unread")
      sorted.sort((a, b) => Number(a.isRead) - Number(b.isRead) || at(b) - at(a));
    else sorted.sort((a, b) => at(b) - at(a));
    return sorted;
  }, [items, filter, sort]);

  // Keep the keyboard cursor in range as the list changes (auto-advance falls
  // out of this: after a drop the same index now points at the next item).
  useEffect(() => {
    setFocusIdx((i) => Math.min(Math.max(0, i), Math.max(0, visible.length - 1)));
  }, [visible.length]);

  // Scroll the focused row into view when the cursor moves.
  useEffect(() => {
    rowRefs.current[focusIdx]?.scrollIntoView({ block: "nearest" });
  }, [focusIdx]);

  // ── Expand a card: fetch the full message once ──
  const openFull = useCallback(
    (messageId: string) => {
      if (fullCache[messageId]) return;
      setFullLoading(messageId);
      getEmail(messageId)
        .then((e) => setFullCache((prev) => ({ ...prev, [messageId]: e })))
        .catch(() => undefined)
        .finally(() => setFullLoading(null));
    },
    [fullCache],
  );

  const toggleExpand = useCallback(
    (it: RapidItem, withReply = false) => {
      if (expandedId === it.messageId && !withReply) {
        setExpandedId(null);
        setReplyForId(null);
        return;
      }
      setExpandedId(it.messageId);
      openFull(it.messageId);
      // Surface an existing draft, or open the composer on an explicit reply.
      setReplyForId(withReply || it.draftId ? it.messageId : null);
    },
    [expandedId, openFull],
  );

  // ── Row-level state changes ──
  const drop = useCallback((messageId: string) => {
    setItems((prev) => prev.filter((x) => x.messageId !== messageId));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(messageId);
      return next;
    });
    setExpandedId((cur) => (cur === messageId ? null : cur));
    setReplyForId((cur) => (cur === messageId ? null : cur));
  }, []);

  const bump = useCallback((delta: number) => {
    setCounts((c) => ({ ...c, [catKey]: Math.max(0, (c[catKey] ?? 0) + delta) }));
  }, [catKey]);

  // Archive / delete are instant + reversible (inbox-zero style, no confirm).
  const archive = useCallback(
    async (it: RapidItem) => {
      drop(it.messageId);
      bump(-1);
      try {
        await updateEmail(it.messageId, { folder: "archive" });
        setToast({
          msg: `Archived “${trim(it.subject)}”.`,
          undo: async () => {
            await updateEmail(it.messageId, { folder: "inbox" });
            setToast(null);
            load();
            loadCounts();
          },
        });
        onArchived?.();
      } catch {
        setToast({ msg: "Couldn't archive that email." });
        load();
      }
    },
    [drop, bump, load, loadCounts, onArchived],
  );

  const remove = useCallback(
    async (it: RapidItem) => {
      drop(it.messageId);
      bump(-1);
      try {
        await deleteEmail(it.messageId);
        setToast({
          msg: `Deleted “${trim(it.subject)}”.`,
          undo: async () => {
            await updateEmail(it.messageId, { folder: "inbox" });
            setToast(null);
            load();
            loadCounts();
          },
        });
        onArchived?.();
      } catch {
        setToast({ msg: "Couldn't delete that email." });
        load();
      }
    },
    [drop, bump, load, loadCounts, onArchived],
  );

  // Mark done / reopen — only meaningful for the conversation buckets.
  const resolve = useCallback(
    async (it: RapidItem, done: boolean) => {
      if (!accountId || !it.threadId) return;
      drop(it.messageId);
      bump(-1);
      try {
        await resolveThread(accountId, it.threadId, done);
        loadCounts();
      } catch {
        load();
      }
    },
    [accountId, drop, bump, load, loadCounts],
  );

  const onSent = useCallback(
    (it: RapidItem) => {
      drop(it.messageId);
      bump(-1);
      setToast({ msg: `Reply sent to ${it.from}.` });
    },
    [drop, bump],
  );

  // ── Bulk actions ──
  const selectedItems = useMemo(
    () => visible.filter((x) => selected.has(x.messageId)),
    [visible, selected],
  );
  const toggleSel = (messageId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });

  const bulk = async (action: "archive" | "trash") => {
    if (selectedItems.length === 0) return;
    setBusy("__bulk__");
    const targets = [...selectedItems];
    try {
      for (const it of targets) {
        try {
          if (action === "archive")
            await updateEmail(it.messageId, { folder: "archive" });
          else await deleteEmail(it.messageId);
          drop(it.messageId);
        } catch {
          /* skip a failed one, keep going */
        }
      }
      setSelected(new Set());
      loadCounts();
      setToast({
        msg: `${action === "archive" ? "Archived" : "Deleted"} ${targets.length} email(s).`,
        undo: async () => {
          for (const it of targets)
            await updateEmail(it.messageId, { folder: "inbox" }).catch(() => undefined);
          setToast(null);
          load();
          loadCounts();
        },
      });
      onArchived?.();
    } finally {
      setBusy(null);
    }
  };

  // ── Toolbar actions ──
  const reclassify = async () => {
    if (!accountId || reclassifying) return;
    setReclassifying(true);
    try {
      await reclassifyReplyZero(accountId);
      for (const delay of [3000, 6000, 12000]) {
        await new Promise((r) => setTimeout(r, delay));
        load();
        loadCounts();
      }
    } catch {
      /* ignore — the user can retry */
    } finally {
      setReclassifying(false);
    }
  };

  const findFollowUps = async () => {
    if (!accountId || scanningFu) return;
    setScanningFu(true);
    try {
      const r = await scanFollowUps(accountId);
      if (!r.configured) {
        setToast({
          msg: "Set a follow-up window in AI Settings first.",
        });
      } else {
        setToast({
          msg: `Scanned ${r.scanned} — flagged ${r.labeled}` +
            (r.drafted ? `, drafted ${r.drafted} nudge(s).` : "."),
        });
        load();
        loadCounts();
      }
    } catch {
      setToast({ msg: "Follow-up scan failed." });
    } finally {
      setScanningFu(false);
    }
  };

  const switchCat = useCallback((key: string) => {
    setCatKey(key);
    setSelected(new Set());
    setFilter("");
    setFocusIdx(0);
    setExpandedId(null);
    setReplyForId(null);
  }, []);

  // ── Keyboard triage (j/k, Enter, e, #, r, d, [ ], ?) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const cur = visible[focusIdx];

      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocusIdx((i) => Math.min(visible.length - 1, i + 1));
          break;
        case "k":
          e.preventDefault();
          setFocusIdx((i) => Math.max(0, i - 1));
          break;
        case "Enter":
        case "o":
          if (cur) { e.preventDefault(); toggleExpand(cur); }
          break;
        case "r":
          if (cur && cat.key !== "done") { e.preventDefault(); toggleExpand(cur, true); }
          break;
        case "e":
          if (cur) { e.preventDefault(); archive(cur); }
          break;
        case "#":
        case "Delete":
          if (cur) { e.preventDefault(); remove(cur); }
          break;
        case "d":
          if (cur && cat.source === "bucket" && cat.key !== "done") {
            e.preventDefault(); resolve(cur, true);
          }
          break;
        case "x":
          if (cur) { e.preventDefault(); toggleSel(cur.messageId); }
          break;
        case "Escape":
          if (replyForId) { e.preventDefault(); setReplyForId(null); }
          else if (expandedId) { e.preventDefault(); setExpandedId(null); }
          break;
        case "[":
        case "]": {
          e.preventDefault();
          const i = CATEGORIES.findIndex((c) => c.key === catKey);
          const next = CATEGORIES[
            (i + (e.key === "]" ? 1 : CATEGORIES.length - 1)) % CATEGORIES.length
          ];
          switchCat(next.key);
          break;
        }
        case "?":
          e.preventDefault();
          setShowKeys((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, focusIdx, expandedId, replyForId, cat, toggleExpand, archive, remove, resolve]);

  if (!accountId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select an account first.
      </div>
    );
  }

  const needs = CATEGORIES.filter((c) => c.group === "needs");
  const sorted = CATEGORIES.filter((c) => c.group === "sorted");

  return (
    <div className="h-full flex flex-col">
      {/* ── Category chips: "Needs you" | "Sorted" ── */}
      <div className="flex items-center gap-1.5 px-3 sm:px-5 py-2.5 border-b border-border flex-shrink-0 overflow-x-auto scrollbar-hide">
        {needs.map((c) => (
          <Chip key={c.key} c={c} active={c.key === catKey} n={counts[c.key]}
            onClick={() => switchCat(c.key)} />
        ))}
        <div className="w-px h-5 bg-border mx-1 flex-shrink-0" />
        {sorted.map((c) => (
          <Chip key={c.key} c={c} active={c.key === catKey} n={counts[c.key]}
            onClick={() => switchCat(c.key)} />
        ))}
      </div>

      {/* ── Toolbar: filter · sort · (follow-ups) · reclassify ── */}
      <div className="flex items-center gap-2 px-3 sm:px-5 py-2 border-b border-border flex-shrink-0 flex-wrap">
        <div className="flex items-center gap-2 bg-secondary rounded-md px-2.5 py-1.5 flex-1 min-w-[8rem] max-w-xs">
          <Search size={13} className="text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${cat.label}…`}
            className="bg-transparent outline-none text-xs w-full text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex items-center gap-0.5 bg-secondary rounded-md p-0.5">
          {SORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSort(s.key)}
              className={`px-2 py-1 rounded text-[11px] transition-colors ${
                sort === s.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {cat.key === "awaiting" && (
            <button
              onClick={findFollowUps}
              disabled={scanningFu}
              title="Find threads waiting too long and draft polite nudges"
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
            >
              <BellRing size={12} className={scanningFu ? "animate-pulse" : undefined} />
              {scanningFu ? "Scanning…" : "Find follow-ups"}
            </button>
          )}
          <button
            onClick={() => setShowKeys((v) => !v)}
            title="Keyboard shortcuts (?)"
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors ${
              showKeys ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
          >
            <Keyboard size={12} />
          </button>
          <button
            onClick={reclassify}
            disabled={reclassifying}
            title="Reclassify — rebuild every category from your rules (keeps Done)"
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={reclassifying ? "animate-spin" : undefined} />
            {reclassifying ? "Reclassifying…" : "Reclassify"}
          </button>
        </div>
      </div>

      {showKeys && <ShortcutBar />}

      {/* ── Bulk action bar ── */}
      {selectedItems.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 sm:px-5 py-2 border-b border-border bg-primary/10 flex-shrink-0">
          <span className="text-[11px] font-medium text-foreground">
            {selectedItems.length} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={() => bulk("archive")}
            disabled={busy === "__bulk__"}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground border border-border hover:bg-secondary transition-colors disabled:opacity-50"
          >
            {busy === "__bulk__" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Archive size={13} />
            )}
            Archive
          </button>
          <button
            onClick={() => bulk("trash")}
            disabled={busy === "__bulk__"}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground border border-border hover:bg-red-500/10 hover:text-red-400 transition-colors disabled:opacity-50"
          >
            <Trash2 size={13} /> Delete
          </button>
          <button
            onClick={() => setSelected(new Set())}
            title="Clear selection"
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* ── List ── */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 6 }).map((_, i) => (
              <RowSkeleton key={i} />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 text-sm px-6 text-center">
            <Mail size={22} className="opacity-40" />
            {cat.key === "to_reply"
              ? "Nothing needs a reply. Inbox zero! 🎉"
              : filter
                ? `No ${cat.label} email matches “${filter}”.`
                : `No ${cat.label} email right now.`}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visible.map((it, i) => (
              <div key={it.messageId} ref={(el) => { rowRefs.current[i] = el; }}>
                <RapidCard
                  accountId={accountId}
                  item={it}
                  cat={cat}
                  focused={i === focusIdx}
                  expanded={expandedId === it.messageId}
                  replyOpen={replyForId === it.messageId}
                  full={fullCache[it.messageId] ?? null}
                  fullLoading={fullLoading === it.messageId}
                  selected={selected.has(it.messageId)}
                  busy={busy === it.messageId}
                  onFocus={() => setFocusIdx(i)}
                  onToggleSelect={() => toggleSel(it.messageId)}
                  onToggleExpand={() => toggleExpand(it)}
                  onOpenReply={() => { setExpandedId(it.messageId); openFull(it.messageId); setReplyForId(it.messageId); }}
                  onCloseReply={() => setReplyForId(null)}
                  onArchive={() => archive(it)}
                  onDelete={() => remove(it)}
                  onResolve={(done) => resolve(it, done)}
                  onSent={() => onSent(it)}
                  onNotice={(msg) => setToast({ msg })}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Undo / status toast ── */}
      {toast && (
        <div className="flex-shrink-0 flex items-center gap-3 px-3 sm:px-5 py-2 border-t border-border bg-card">
          <Check size={13} className="text-primary flex-shrink-0" />
          <span className="text-xs text-foreground truncate">{toast.msg}</span>
          {toast.undo && (
            <button
              onClick={toast.undo}
              className="ml-auto text-xs text-primary font-medium hover:opacity-80 flex items-center gap-1 flex-shrink-0"
            >
              <RotateCcw size={12} /> Undo
            </button>
          )}
          <button
            onClick={() => setToast(null)}
            className={`text-muted-foreground hover:text-foreground flex-shrink-0 ${toast.undo ? "" : "ml-auto"}`}
            title="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Category chip ────────────────────────────────────────────────────────────

function Chip({
  c, active, n, onClick,
}: {
  c: Category; active: boolean; n?: number; onClick: () => void;
}) {
  const Icon = c.icon;
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors flex-shrink-0 ${
        active ? c.cls : "text-muted-foreground hover:text-foreground hover:bg-secondary"
      }`}
    >
      <Icon size={13} />
      {c.label}
      {typeof n === "number" && n > 0 && (
        <span className={active ? "opacity-70" : "opacity-50"}>{n}</span>
      )}
    </button>
  );
}

// ── One expandable email card + inline reply ────────────────────────────────

function RapidCard({
  accountId,
  item,
  cat,
  focused,
  expanded,
  replyOpen,
  full,
  fullLoading,
  selected,
  busy,
  onFocus,
  onToggleSelect,
  onToggleExpand,
  onOpenReply,
  onCloseReply,
  onArchive,
  onDelete,
  onResolve,
  onSent,
  onNotice,
}: {
  accountId: string;
  item: RapidItem;
  cat: Category;
  focused: boolean;
  expanded: boolean;
  replyOpen: boolean;
  full: Email | null;
  fullLoading: boolean;
  selected: boolean;
  busy: boolean;
  onFocus: () => void;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onOpenReply: () => void;
  onCloseReply: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onResolve: (done: boolean) => void;
  onSent: () => void;
  onNotice: (msg: string) => void;
}) {
  const isDone = cat.bucket === "done";
  const isBucket = cat.source === "bucket";
  const avatarBg = presetHex(deterministicPreset(item.fromEmail || item.from));
  const initial = (item.from || item.fromEmail || "?").trim().charAt(0).toUpperCase();

  return (
    <div
      className={`${selected ? "bg-primary/5" : ""} ${
        focused ? "ring-2 ring-inset ring-primary/40" : ""
      }`}
    >
      {/* Row */}
      <div className="flex items-start gap-2.5 px-3 sm:px-5 py-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="accent-primary flex-shrink-0 mt-1.5"
          onClick={(e) => e.stopPropagation()}
        />
        {/* Sender avatar */}
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-semibold mt-0.5"
          style={{ backgroundColor: avatarBg, color: textOn(avatarBg) }}
          title={item.fromEmail}
        >
          {initial}
        </div>
        <button
          onClick={() => { onFocus(); onToggleExpand(); }}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-2">
            <span
              className={`text-xs truncate ${
                item.isRead ? "text-foreground/70" : "text-foreground font-semibold"
              }`}
            >
              {item.from}
            </span>
            <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
              {!item.isRead && (
                <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              )}
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                {item.receivedAt ? timeLabel(item.receivedAt) : ""}
              </span>
              <ChevronRight
                size={13}
                className={`text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
              />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className={`text-xs truncate ${item.isRead ? "text-foreground/60" : "text-foreground"}`}
            >
              {item.subject}
            </span>
            {item.needsFollowUp && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 flex-shrink-0">
                Follow up{typeof item.awaitingDays === "number" ? ` · ${item.awaitingDays}d` : ""}
              </span>
            )}
            {item.draftId && !isDone && (
              <span
                title="A draft is already saved for this thread"
                className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center gap-0.5 flex-shrink-0"
              >
                <Check size={9} /> Draft
              </span>
            )}
          </div>
          {item.preview && (
            <div className="text-[11px] text-muted-foreground truncate leading-relaxed">
              {item.reason ? <span className="italic">{item.preview}</span> : item.preview}
            </div>
          )}
        </button>

        {/* Row actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {busy ? (
            <Loader2 className="animate-spin text-muted-foreground" size={14} />
          ) : (
            <>
              {isBucket && !isDone && (
                <ActionBtn title="Mark done (d)" onClick={() => onResolve(true)}
                  className="hover:bg-emerald-500/10 hover:text-emerald-500">
                  <Check size={13} />
                </ActionBtn>
              )}
              {isDone && (
                <ActionBtn title="Reopen" onClick={() => onResolve(false)}
                  className="hover:bg-secondary">
                  <RotateCcw size={13} />
                </ActionBtn>
              )}
              <ActionBtn title="Archive (e)" onClick={onArchive}
                className="hover:bg-secondary">
                <Archive size={13} />
              </ActionBtn>
              <ActionBtn title="Delete (#)" onClick={onDelete}
                className="hover:bg-red-500/10 hover:text-red-400">
                <Trash2 size={13} />
              </ActionBtn>
            </>
          )}
        </div>
      </div>

      {/* Expanded body + reply */}
      {expanded && (
        <div className="px-3 sm:px-5 pb-3 pl-[52px]">
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="px-3 py-2 border-b border-border bg-secondary/40 text-[11px] text-muted-foreground">
              {full?.from?.name || item.from}
              {full?.from?.email ? ` <${full.from.email}>` : ""}
              {item.receivedAt ? ` · ${fullDateLabel(item.receivedAt)}` : ""}
            </div>
            <div className="px-3 py-3 max-h-[45vh] overflow-y-auto">
              {fullLoading && !full ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                  <Loader2 className="animate-spin" size={14} /> Loading…
                </div>
              ) : full && (full.bodyHtml || full.bodyText) ? (
                <MessageContent html={full.bodyHtml} text={full.bodyText} />
              ) : (
                <div className="text-xs text-muted-foreground italic py-2">
                  No preview text.
                </div>
              )}
              {(full?.attachments?.length ?? 0) > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {full!.attachments!.map((a) => (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border border-border text-muted-foreground"
                    >
                      <Paperclip size={10} /> {a.filename}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Reply — like the main inbox composer, inline under the card */}
            {!isDone &&
              (replyOpen ? (
                <InlineReply
                  accountId={accountId}
                  item={item}
                  full={full}
                  followUp={cat.bucket === "awaiting"}
                  onSent={onSent}
                  onNotice={onNotice}
                  onClose={onCloseReply}
                />
              ) : (
                <div className="px-3 py-2 border-t border-border">
                  <button
                    onClick={onOpenReply}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground border border-border hover:text-primary hover:bg-primary/10 transition-colors"
                  >
                    <Reply size={13} /> {cat.bucket === "awaiting" ? "Nudge" : "Reply"}
                  </button>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline reply composer (main-inbox style, compact) ───────────────────────

function InlineReply({
  accountId,
  item,
  full,
  followUp,
  onSent,
  onNotice,
  onClose,
}: {
  accountId: string;
  item: RapidItem;
  full: Email | null;
  followUp: boolean;
  onSent: () => void;
  onNotice: (msg: string) => void;
  onClose: () => void;
}) {
  const [body, setBody] = useState(item.draftPreview || "");
  const [to, setTo] = useState(item.fromEmail);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [savedTo, setSavedTo] = useState(!!item.draftId);
  const [error, setError] = useState<string | null>(null);

  const subject = useMemo(() => {
    const s = full?.subject || item.subject || "";
    return s.startsWith("Re:") ? s : `Re: ${s}`;
  }, [full, item.subject]);

  // Keep the recipient in sync once the full message resolves.
  useEffect(() => {
    if (full?.from?.email) setTo(full.from.email);
  }, [full]);

  const aiDraft = async () => {
    setDrafting(true);
    setError(null);
    try {
      const res = await draftReplySmart(accountId, item.messageId, false, followUp);
      setBody(res.draft || "");
      setSavedTo(false);
    } catch {
      setError("AI couldn't draft this — write a reply below.");
    } finally {
      setDrafting(false);
    }
  };

  const save = async () => {
    if (!body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await saveDraftText(accountId, item.messageId, body);
      setSavedTo(true);
      onNotice("Saved to your Drafts.");
    } catch {
      setError("Couldn't save the draft.");
    } finally {
      setSaving(false);
    }
  };

  const send = async () => {
    if (!body.trim() || !to.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendEmail({
        accountId,
        to: to.split(",").map((s) => s.trim()).filter(Boolean),
        subject,
        bodyText: body,
        replyToMessageId: full?.providerMessageId || undefined,
      });
      onSent();
    } catch (e) {
      setError((e as Error).message || "Failed to send.");
      setSending(false);
    }
  };

  return (
    <div className="border-t border-border px-3 py-3 space-y-2 bg-secondary/20">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground w-10 flex-shrink-0">To</span>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="flex-1 bg-transparent text-xs text-foreground outline-none border-b border-border/60 pb-0.5"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground w-10 flex-shrink-0">Subj</span>
        <span className="text-xs text-foreground truncate">{subject}</span>
      </div>
      <textarea
        value={body}
        onChange={(e) => { setBody(e.target.value); setSavedTo(false); }}
        rows={6}
        autoFocus
        placeholder={followUp ? "Write a follow-up nudge…" : "Write your reply…"}
        className="w-full bg-background border border-border rounded-lg px-2.5 py-2 text-xs text-foreground outline-none focus:border-primary transition-colors resize-none leading-relaxed"
      />
      {error && <div className="text-[11px] text-destructive">{error}</div>}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={aiDraft}
          disabled={drafting}
          title="Draft a context-aware reply with memory + specialist agents"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-muted-foreground border border-border hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
        >
          {drafting ? <Loader2 className="animate-spin" size={12} /> : <Sparkles size={12} />}
          {body.trim() ? "Redraft with AI" : followUp ? "Draft nudge" : "Draft with AI"}
        </button>
        {savedTo ? (
          <span className="flex items-center gap-1 text-[11px] text-emerald-400">
            <Check size={12} /> Saved to Drafts
          </span>
        ) : (
          <button
            onClick={save}
            disabled={saving || !body.trim()}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-muted-foreground border border-border hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="animate-spin" size={12} /> : <PenLine size={12} />}
            Save to Drafts
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="px-2.5 py-1.5 rounded-lg text-[11px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={send}
          disabled={sending || !body.trim() || !to.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {sending ? <Loader2 className="animate-spin" size={12} /> : <Send size={12} />}
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────────

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "j / k", label: "Move" },
  { keys: "↵", label: "Open" },
  { keys: "r", label: "Reply" },
  { keys: "e", label: "Archive" },
  { keys: "#", label: "Delete" },
  { keys: "d", label: "Done" },
  { keys: "x", label: "Select" },
  { keys: "[ ]", label: "Category" },
];

function ShortcutBar() {
  return (
    <div className="flex items-center gap-3 px-3 sm:px-5 py-1.5 border-b border-border bg-secondary/30 flex-shrink-0 overflow-x-auto scrollbar-hide">
      {SHORTCUTS.map((s) => (
        <span key={s.keys} className="flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap">
          <kbd className="px-1 py-0.5 rounded border border-border bg-card text-foreground font-mono text-[9px]">
            {s.keys}
          </kbd>
          {s.label}
        </span>
      ))}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex items-start gap-2.5 px-3 sm:px-5 py-2.5 animate-pulse">
      <div className="w-4 h-4 rounded bg-secondary mt-1" />
      <div className="w-7 h-7 rounded-full bg-secondary flex-shrink-0" />
      <div className="flex-1 min-w-0 space-y-1.5 py-0.5">
        <div className="h-2.5 bg-secondary rounded w-1/3" />
        <div className="h-2.5 bg-secondary rounded w-2/3" />
        <div className="h-2 bg-secondary/60 rounded w-1/2" />
      </div>
    </div>
  );
}

function ActionBtn({
  children, onClick, title, className = "",
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
      className={`flex items-center justify-center p-1.5 rounded-md text-muted-foreground border border-border transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

/** Clamp a subject for a toast line. */
function trim(s: string, n = 42): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
