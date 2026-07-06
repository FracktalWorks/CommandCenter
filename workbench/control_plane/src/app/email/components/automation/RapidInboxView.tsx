"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Loader2, Reply, Clock, PenLine, Mail, Check, CheckCircle2, RotateCcw,
  RefreshCw, Info, Newspaper, Megaphone, Calendar, Receipt, Bell, Snowflake,
  Archive, Trash2, ChevronRight, Send, Search, X, Sparkles, Paperclip,
} from "lucide-react";
import {
  getReplyZero, draftReplySmart, resolveThread, reclassifyReplyZero,
  listEmails, getEmail, updateEmail, deleteEmail, sendEmail, saveDraftText,
} from "../../lib/api";
import { ReplyZeroThread, Email } from "../../lib/types";
import { timeLabel, fullDateLabel } from "../../lib/utils";
import { MessageContent } from "../MessageContent";

interface RapidInboxViewProps {
  accountId: string | null;
  /** Called after an archive/delete so the parent can refresh the inbox. */
  onArchived?: () => void;
}

/**
 * A Rapid Inbox category. Conversation buckets (To Reply / Awaiting / Done) come
 * from the Reply Zero thread-status projection and carry the reason + existing
 * draft; the remaining categories are provider labels applied by the rules, read
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
  bucket?: Bucket;
  /** Active-chip + tag palette (works on light & dark). */
  cls: string;
}

const CATEGORIES: Category[] = [
  { key: "to_reply", label: "To Reply", icon: Reply, source: "bucket",
    bucket: "needs_reply",
    cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  { key: "awaiting", label: "Awaiting Reply", icon: Clock, source: "bucket",
    bucket: "awaiting",
    cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  { key: "fyi", label: "FYI", icon: Info, source: "label",
    cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  { key: "newsletter", label: "Newsletter", icon: Newspaper, source: "label",
    cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  { key: "marketing", label: "Marketing", icon: Megaphone, source: "label",
    cls: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  { key: "calendar", label: "Calendar", icon: Calendar, source: "label",
    cls: "bg-teal-500/15 text-teal-600 dark:text-teal-400" },
  { key: "receipt", label: "Receipt", icon: Receipt, source: "label",
    cls: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400" },
  { key: "notification", label: "Notification", icon: Bell, source: "label",
    cls: "bg-slate-500/15 text-slate-600 dark:text-slate-300" },
  { key: "cold", label: "Cold Email", icon: Snowflake, source: "label",
    cls: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400" },
  { key: "done", label: "Done", icon: CheckCircle2, source: "bucket",
    bucket: "done",
    cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
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
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // Full messages fetched on expand (cached so re-opening a card is instant).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fullCache, setFullCache] = useState<Record<string, Email>>({});
  const [fullLoading, setFullLoading] = useState<string | null>(null);

  // Bulk selection (inbox-cleaner parity).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  // ── Load the active category ──
  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setExpandedId(null);
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

  // Auto-dismiss the transient result banner.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // ── Expand a card: fetch the full message once ──
  const toggleExpand = (it: RapidItem) => {
    if (expandedId === it.messageId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(it.messageId);
    if (!fullCache[it.messageId]) {
      setFullLoading(it.messageId);
      getEmail(it.messageId)
        .then((e) => setFullCache((prev) => ({ ...prev, [it.messageId]: e })))
        .catch(() => undefined)
        .finally(() => setFullLoading(null));
    }
  };

  // ── Row-level state changes (drop from the list + refresh counts/parent) ──
  const drop = (messageId: string) => {
    setItems((prev) => prev.filter((x) => x.messageId !== messageId));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(messageId);
      return next;
    });
    if (expandedId === messageId) setExpandedId(null);
  };

  const archive = async (it: RapidItem) => {
    setBusy(it.messageId);
    try {
      await updateEmail(it.messageId, { folder: "archive" });
      drop(it.messageId);
      setCounts((c) => ({ ...c, [catKey]: Math.max(0, (c[catKey] ?? 1) - 1) }));
      setNotice(`Archived “${it.subject}”.`);
      onArchived?.();
    } catch {
      setNotice("Couldn't archive that email.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (it: RapidItem) => {
    if (!window.confirm(`Move “${it.subject}” to Trash?`)) return;
    setBusy(it.messageId);
    try {
      await deleteEmail(it.messageId);
      drop(it.messageId);
      setCounts((c) => ({ ...c, [catKey]: Math.max(0, (c[catKey] ?? 1) - 1) }));
      setNotice(`Deleted “${it.subject}”.`);
      onArchived?.();
    } catch {
      setNotice("Couldn't delete that email.");
    } finally {
      setBusy(null);
    }
  };

  // Mark done / reopen — only meaningful for the conversation buckets.
  const resolve = async (it: RapidItem, done: boolean) => {
    if (!accountId || !it.threadId) return;
    setBusy(it.messageId);
    drop(it.messageId);
    try {
      await resolveThread(accountId, it.threadId, done);
      loadCounts();
    } catch {
      load();
    } finally {
      setBusy(null);
    }
  };

  // ── Bulk actions (inbox-cleaner parity) ──
  const selectedItems = useMemo(
    () => items.filter((x) => selected.has(x.messageId)),
    [items, selected],
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
    if (
      action === "trash" &&
      !window.confirm(`Move ${selectedItems.length} email(s) to Trash?`)
    ) {
      return;
    }
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
      setNotice(
        `${action === "archive" ? "Archived" : "Deleted"} ${targets.length} email(s).`,
      );
      onArchived?.();
    } finally {
      setBusy(null);
    }
  };

  // ── Rendering ──
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

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.subject.toLowerCase().includes(q) ||
        it.from.toLowerCase().includes(q) ||
        it.fromEmail.toLowerCase().includes(q),
    );
  }, [items, filter]);

  if (!accountId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select an account first.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* ── Category chips ── */}
      <div className="flex items-center gap-1.5 px-3 sm:px-5 py-2.5 border-b border-border flex-shrink-0 overflow-x-auto scrollbar-hide">
        {CATEGORIES.map((c) => {
          const Icon = c.icon;
          const active = c.key === catKey;
          const n = counts[c.key];
          return (
            <button
              key={c.key}
              onClick={() => {
                setCatKey(c.key);
                setSelected(new Set());
                setFilter("");
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors flex-shrink-0 ${
                active
                  ? c.cls
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              }`}
            >
              <Icon size={13} />
              {c.label}
              {typeof n === "number" && (
                <span className={active ? "opacity-70" : "opacity-50"}>{n}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Toolbar: filter + reclassify ── */}
      <div className="flex items-center gap-2 px-3 sm:px-5 py-2 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 bg-secondary rounded-md px-2.5 py-1.5 flex-1 max-w-xs">
          <Search size={13} className="text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${cat.label}…`}
            className="bg-transparent outline-none text-xs w-full text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <button
          onClick={reclassify}
          disabled={reclassifying}
          title="Reclassify — rebuild every category from your rules (keeps Done)"
          className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={reclassifying ? "animate-spin" : undefined} />
          {reclassifying ? "Reclassifying…" : "Reclassify"}
        </button>
      </div>

      {notice && (
        <div className="px-3 sm:px-5 py-2 text-xs text-primary bg-primary/10 border-b border-border flex items-center gap-1.5 flex-shrink-0">
          <Check size={12} className="flex-shrink-0" />
          {notice}
        </div>
      )}

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
          <div className="flex items-center justify-center h-full text-muted-foreground gap-2 text-sm">
            <Loader2 className="animate-spin" size={16} /> Loading…
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 text-sm">
            <Mail size={22} className="opacity-40" />
            {cat.key === "to_reply"
              ? "Nothing needs a reply. Inbox zero! 🎉"
              : `No ${cat.label} email${filter ? " matches your filter" : ""}.`}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visible.map((it) => (
              <RapidCard
                key={it.messageId}
                accountId={accountId}
                item={it}
                cat={cat}
                expanded={expandedId === it.messageId}
                full={fullCache[it.messageId] ?? null}
                fullLoading={fullLoading === it.messageId}
                selected={selected.has(it.messageId)}
                busy={busy === it.messageId}
                onToggleSelect={() => toggleSel(it.messageId)}
                onToggleExpand={() => toggleExpand(it)}
                onArchive={() => archive(it)}
                onDelete={() => remove(it)}
                onResolve={(done) => resolve(it, done)}
                onSent={() => {
                  drop(it.messageId);
                  setCounts((c) => ({
                    ...c,
                    [catKey]: Math.max(0, (c[catKey] ?? 1) - 1),
                  }));
                  setNotice(`Reply sent to ${it.from}.`);
                }}
                onNotice={setNotice}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── One expandable email card + inline reply ────────────────────────────────

function RapidCard({
  accountId,
  item,
  cat,
  expanded,
  full,
  fullLoading,
  selected,
  busy,
  onToggleSelect,
  onToggleExpand,
  onArchive,
  onDelete,
  onResolve,
  onSent,
  onNotice,
}: {
  accountId: string;
  item: RapidItem;
  cat: Category;
  expanded: boolean;
  full: Email | null;
  fullLoading: boolean;
  selected: boolean;
  busy: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onResolve: (done: boolean) => void;
  onSent: () => void;
  onNotice: (msg: string) => void;
}) {
  const isDone = cat.bucket === "done";
  const isBucket = cat.source === "bucket";
  const [replyOpen, setReplyOpen] = useState(false);

  // Auto-open the reply composer when a card with an existing draft expands, so
  // the AI/saved draft is right there to review.
  useEffect(() => {
    if (expanded && item.draftId) setReplyOpen(true);
  }, [expanded, item.draftId]);

  return (
    <div className={selected ? "bg-primary/5" : undefined}>
      {/* Row */}
      <div className="flex items-start gap-3 px-3 sm:px-5 py-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="accent-primary flex-shrink-0 mt-1"
          onClick={(e) => e.stopPropagation()}
        />
        <button
          onClick={onToggleExpand}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-1.5">
            <ChevronRight
              size={13}
              className={`text-muted-foreground flex-shrink-0 transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
            />
            {!item.isRead && (
              <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
            )}
            <span className="text-xs font-medium text-foreground truncate">
              {item.subject}
            </span>
            {item.needsFollowUp && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 flex-shrink-0">
                Follow up
                {typeof item.awaitingDays === "number" ? ` · ${item.awaitingDays}d` : ""}
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
          <div className="text-[11px] text-muted-foreground truncate pl-[18px]">
            {item.from}
            {item.receivedAt ? ` · ${timeLabel(item.receivedAt)}` : ""}
          </div>
          {item.reason && (
            <div className="text-[10px] text-muted-foreground/80 italic truncate pl-[18px]">
              {item.reason}
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
                <ActionBtn
                  title="Mark done — handled, no further action needed"
                  onClick={() => onResolve(true)}
                  className="hover:bg-emerald-500/10 hover:text-emerald-500"
                >
                  <Check size={13} />
                </ActionBtn>
              )}
              {isDone && (
                <ActionBtn
                  title="Reopen — move back to To Reply / Awaiting"
                  onClick={() => onResolve(false)}
                  className="hover:bg-secondary"
                >
                  <RotateCcw size={13} />
                </ActionBtn>
              )}
              <ActionBtn
                title="Archive"
                onClick={onArchive}
                className="hover:bg-secondary"
              >
                <Archive size={13} />
              </ActionBtn>
              <ActionBtn
                title="Delete (move to Trash)"
                onClick={onDelete}
                className="hover:bg-red-500/10 hover:text-red-400"
              >
                <Trash2 size={13} />
              </ActionBtn>
            </>
          )}
        </div>
      </div>

      {/* Expanded body + reply */}
      {expanded && (
        <div className="px-3 sm:px-5 pb-3 pl-[46px]">
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
                  onClose={() => setReplyOpen(false)}
                />
              ) : (
                <div className="px-3 py-2 border-t border-border">
                  <button
                    onClick={() => setReplyOpen(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground border border-border hover:text-primary hover:bg-primary/10 transition-colors"
                  >
                    <Reply size={13} /> Reply
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

  // Keep the recipient in sync once the full message resolves (its from-address
  // is authoritative).
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
        onChange={(e) => {
          setBody(e.target.value);
          setSavedTo(false);
        }}
        rows={6}
        placeholder="Write your reply…"
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
          {drafting ? (
            <Loader2 className="animate-spin" size={12} />
          ) : (
            <Sparkles size={12} />
          )}
          {body.trim() ? "Redraft with AI" : "Draft with AI"}
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
      className={`flex items-center justify-center p-1.5 rounded-md text-muted-foreground border border-border transition-colors ${className}`}
    >
      {children}
    </button>
  );
}
