"use client";

/**
 * The mailbox DASHBOARD (formerly "Digest") — the command-center view of every
 * open loop: what you owe (needs reply), what's owed to you (waiting on them),
 * what you promised (commitments), and the day's traffic. Every row navigates
 * to its thread; the closing actions (Done / Snooze) live on the row so triage
 * happens HERE instead of in a static summary.
 *
 * Same computation as the scheduled email digest (one aggregate, two
 * projections) — the email is the snapshot, this is the live ledger.
 */

import { useEffect, useState, useCallback } from "react";
import {
  Loader2, Send, Mail, MailOpen, Reply, Paperclip, Check, Newspaper,
  Settings2, Hourglass, ExternalLink, Clock, CheckCheck, XCircle,
  AlertTriangle, ChevronRight, PenLine, BellRing, Sparkles,
} from "lucide-react";
import { getDigest, resolveThread, sendDigest, snoozeEmail } from "../../lib/api";
import { DigestData, DigestThread } from "../../lib/types";
import { DigestSettingsDialog } from "./DigestSettingsDialog";

interface DashboardViewProps {
  accountId: string | null;
  /** Open a message in the mailbox reading pane (closes the dashboard). */
  onOpenEmail?: (messageId: string) => void;
  /** Filter the mailbox by a category label (category chip click-through). */
  onFilterLabel?: (label: string) => void;
  /** Filter the mailbox by a sender address (noisy-sender click-through). */
  onFilterSender?: (email: string) => void;
  /** Open a thread and start an AI-drafted reply (the ✍️ row action). */
  onDraftReply?: (messageId: string) => void;
  /** Open a waiting-on-them thread and start an AI-drafted follow-up nudge. */
  onNudge?: (messageId: string) => void;
}

export function DashboardView({
  accountId, onOpenEmail, onFilterLabel, onFilterSender, onDraftReply, onNudge,
}: DashboardViewProps) {
  const [period, setPeriod] = useState<"day" | "week">("day");
  const [data, setData] = useState<DigestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const load = useCallback((quiet = false) => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    setError(null);
    getDigest(accountId, period)
      .then(setData)
      .catch((e) => setError(e.message || "Failed to build dashboard"))
      .finally(() => setLoading(false));
  }, [accountId, period]);

  useEffect(() => load(), [load]);

  const send = async () => {
    if (!accountId) return;
    setSending(true);
    setSentTo(null);
    try {
      const res = await sendDigest(accountId, period);
      setSentTo(res.to);
    } catch (e) {
      setError((e as Error).message || "Failed to send digest");
    } finally {
      setSending(false);
    }
  };

  /** Optimistically drop a thread from a list, run the action, then re-sync. */
  const dropThread = (
    key: "backlog" | "awaiting", threadId: string, action: Promise<unknown>,
  ) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            [key]: (prev[key] ?? []).filter((t) => t.thread_id !== threadId),
            totals: {
              ...prev.totals,
              ...(key === "backlog"
                ? { needs_reply: Math.max(0, prev.totals.needs_reply - 1) }
                : { awaiting: Math.max(0, prev.totals.awaiting - 1) }),
            },
          }
        : prev,
    );
    action.then(() => load(true)).catch(() => load(true));
  };

  const markDone = (t: DigestThread) => {
    if (!accountId) return;
    dropThread("backlog", t.thread_id, resolveThread(accountId, t.thread_id));
  };

  const dismiss = (t: DigestThread) => {
    if (!accountId) return;
    dropThread("backlog", t.thread_id,
      resolveThread(accountId, t.thread_id, { dismiss: true }));
  };

  const snoozeDay = (t: DigestThread) => {
    if (!t.message_id) return;
    const until = new Date();
    until.setDate(until.getDate() + 1);
    until.setHours(8, 0, 0, 0);
    dropThread("backlog", t.thread_id,
      snoozeEmail(t.message_id, until.toISOString()));
  };

  if (!accountId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select an account first.
      </div>
    );
  }

  const t = data?.totals;

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 sm:px-5 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-1 bg-secondary rounded-lg p-0.5">
          {(["day", "week"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                period === p
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {p === "day" ? "Last day" : "Last week"}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowConfig(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors ml-auto"
        >
          <Settings2 size={13} /> Configure
        </button>
        <button
          onClick={send}
          disabled={sending || loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {sending ? <Loader2 className="animate-spin" size={13} /> : <Send size={13} />}
          Send to my inbox
        </button>
      </div>

      {showConfig && accountId && (
        <DigestSettingsDialog
          accountId={accountId}
          onClose={() => setShowConfig(false)}
        />
      )}

      {sentTo && (
        <div className="px-3 sm:px-5 py-2 text-xs text-emerald-400 bg-emerald-500/10 border-b border-border flex items-center gap-1.5">
          <Check size={12} /> Digest sent to {sentTo}
        </div>
      )}
      {error && (
        <div className="px-3 sm:px-5 py-2 text-xs text-destructive bg-destructive/10 border-b border-border">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-5">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground gap-2 text-sm">
            <Loader2 className="animate-spin" size={16} /> Building dashboard…
          </div>
        ) : !data ? null : (
          <>
            {/* Opt-in morning brief: one LLM sentence orienting the day. Only
                present when the setting is on (empty string otherwise). */}
            {data.brief && (
              <div className="flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
                <Sparkles size={15} className="text-primary flex-shrink-0 mt-0.5" />
                <p className="text-sm text-foreground leading-snug">{data.brief}</p>
              </div>
            )}

            {/* Stat row */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Stat icon={Mail} label="In inbox" value={t!.inbox} />
              <Stat icon={MailOpen} label="Unread" value={t!.unread} />
              <Stat icon={Reply} label="Needs reply" value={t!.needs_reply} accent />
              <Stat icon={Hourglass} label="Waiting on them" value={t!.awaiting ?? 0} />
              <Stat icon={Paperclip} label="Attachments" value={t!.attachments} />
            </div>

            {/* The two sides of the ledger: what YOU owe, and what's owed to
                you. Every row opens its thread; closing actions live here. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-card border border-border rounded-xl p-4">
                <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
                  <Reply size={13} className="text-primary" /> Needs your reply
                  <span
                    className="text-[10px] font-normal text-muted-foreground"
                    title="Ranked by urgency — importance and unread lift a thread above older ones"
                  >
                    · by priority
                  </span>
                  <CountBadge n={t!.needs_reply} />
                </h3>
                {!data.backlog?.length ? (
                  <p className="text-xs text-muted-foreground">
                    Nothing waiting on you. Inbox zero. 🎉
                  </p>
                ) : (
                  <div className="max-h-72 overflow-y-auto pr-1 space-y-0.5">
                    {data.backlog.map((b) => (
                      <ThreadRow
                        key={b.thread_id}
                        row={b}
                        onOpen={onOpenEmail}
                        actions={
                          <>
                            {b.message_id && onDraftReply && (
                              <RowBtn
                                title="Draft a reply with AI — opens the thread with a draft ready"
                                onClick={() => onDraftReply(b.message_id!)}
                              >
                                <PenLine size={12} />
                              </RowBtn>
                            )}
                            <RowBtn
                              title="Mark done — this loop is closed"
                              onClick={() => markDone(b)}
                            >
                              <CheckCheck size={12} />
                            </RowBtn>
                            {b.message_id && (
                              <RowBtn
                                title="Snooze until tomorrow 8:00"
                                onClick={() => snoozeDay(b)}
                              >
                                <Clock size={12} />
                              </RowBtn>
                            )}
                            <RowBtn
                              title="Dismiss — never mind this thread (files it as FYI without claiming it's done)"
                              onClick={() => dismiss(b)}
                            >
                              <XCircle size={12} />
                            </RowBtn>
                          </>
                        }
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-card border border-border rounded-xl p-4">
                <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
                  <Hourglass size={13} className="text-primary" /> Waiting on them
                  <CountBadge n={t!.awaiting ?? 0} />
                </h3>
                {!data.awaiting?.length ? (
                  <p className="text-xs text-muted-foreground">
                    Nobody owes you a reply right now.
                  </p>
                ) : (
                  <div className="max-h-72 overflow-y-auto pr-1 space-y-0.5">
                    {data.awaiting.map((b) => (
                      <ThreadRow
                        key={b.thread_id}
                        row={b}
                        onOpen={onOpenEmail}
                        actions={
                          b.message_id && onNudge ? (
                            <RowBtn
                              title="Nudge — open the thread with an AI follow-up draft ready"
                              onClick={() => onNudge(b.message_id!)}
                            >
                              <BellRing size={12} />
                            </RowBtn>
                          ) : undefined
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Commitments — promises captured from sent replies. */}
            {data.commitments && data.commitments.length > 0 && (
              <div className="bg-card border border-border rounded-xl p-4">
                <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
                  <Check size={13} className="text-primary" /> Commitments
                  <CountBadge n={data.commitments.length} />
                </h3>
                <div className="space-y-1.5">
                  {data.commitments.map((c, i) => (
                    <div key={i} className="flex items-center justify-between text-xs gap-2">
                      <span className="text-foreground truncate">{c.title}</span>
                      <span
                        className={`tabular-nums flex-shrink-0 ${
                          c.overdue && c.due
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }`}
                      >
                        {!c.due
                          ? "no due date"
                          : `${c.overdue ? "overdue" : "due"} ${c.due}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* By category */}
              <div className="bg-card border border-border rounded-xl p-4">
                <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
                  <Newspaper size={13} className="text-primary" /> By category
                </h3>
                <div className="space-y-1.5">
                  {data.by_category.length === 0 && (
                    <p className="text-xs text-muted-foreground">No mail in this period.</p>
                  )}
                  {data.by_category.map((c) => (
                    <button
                      key={c.category}
                      onClick={() => onFilterLabel?.(c.category)}
                      disabled={!onFilterLabel}
                      title={
                        onFilterLabel
                          ? `Show ${c.category} mail in the inbox`
                          : undefined
                      }
                      className={`group flex items-center justify-between text-xs w-full rounded px-1.5 py-0.5 -mx-1.5 ${
                        onFilterLabel
                          ? "hover:bg-secondary cursor-pointer"
                          : "cursor-default"
                      }`}
                    >
                      <span className="text-foreground flex items-center gap-1">
                        {c.category}
                        {onFilterLabel && (
                          <ChevronRight
                            size={11}
                            className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                          />
                        )}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {c.count}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Noisy senders */}
              <div className="bg-card border border-border rounded-xl p-4">
                <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
                  <Mail size={13} className="text-primary" /> Noisy senders you never answer
                </h3>
                <div className="space-y-1.5">
                  {data.top_senders.length === 0 && (
                    <p className="text-xs text-muted-foreground">No senders.</p>
                  )}
                  {data.top_senders.map((s) => (
                    <button
                      key={s.email}
                      onClick={() => onFilterSender?.(s.email)}
                      disabled={!onFilterSender}
                      title={
                        onFilterSender
                          ? `Show mail from ${s.name || s.email}`
                          : undefined
                      }
                      className={`group flex items-center justify-between text-xs gap-2 w-full rounded px-1.5 py-0.5 -mx-1.5 ${
                        onFilterSender
                          ? "hover:bg-secondary cursor-pointer"
                          : "cursor-default"
                      }`}
                    >
                      <span className="text-foreground truncate flex items-center gap-1 min-w-0">
                        <span className="truncate">{s.name || s.email}</span>
                        {onFilterSender && (
                          <ChevronRight
                            size={11}
                            className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                          />
                        )}
                      </span>
                      <span className="text-muted-foreground tabular-nums flex-shrink-0">
                        {s.count}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function _agePhrase(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

/** One open-loop row: click anywhere → open the thread; actions on the right. */
function ThreadRow({
  row,
  onOpen,
  actions,
}: {
  row: DigestThread;
  onOpen?: (messageId: string) => void;
  actions?: React.ReactNode;
}) {
  const openable = Boolean(onOpen && row.message_id);
  return (
    <div
      className={`group flex items-center gap-2 text-xs rounded-md px-1.5 py-1 -mx-1.5 ${
        openable ? "cursor-pointer hover:bg-secondary" : ""
      }`}
      onClick={() => openable && onOpen!(row.message_id!)}
      role={openable ? "button" : undefined}
      title={openable ? "Open this conversation" : undefined}
    >
      {row.important && (
        <AlertTriangle
          size={11}
          className="text-amber-500 flex-shrink-0"
          aria-label="High importance"
        />
      )}
      {row.unread && !row.important && (
        <span
          className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0"
          aria-label="Unread"
        />
      )}
      <span
        className={`truncate flex-1 min-w-0 ${
          row.unread ? "text-foreground font-medium" : "text-foreground"
        }`}
      >
        {row.subject}
        {row.who && (
          <span className="text-muted-foreground font-normal"> — {row.who}</span>
        )}
      </span>
      <span
        className={`tabular-nums flex-shrink-0 ${
          row.age_days > 14 ? "text-amber-500" : "text-muted-foreground"
        }`}
      >
        {_agePhrase(row.age_days)}
      </span>
      <span
        className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        {actions}
        {openable && (
          <RowBtn title="Open" onClick={() => onOpen!(row.message_id!)}>
            <ExternalLink size={12} />
          </RowBtn>
        )}
      </span>
    </div>
  );
}

function RowBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-border transition-colors"
    >
      {children}
    </button>
  );
}

function CountBadge({ n }: { n: number }) {
  return (
    <span className="ml-auto text-[10px] font-normal text-muted-foreground bg-secondary rounded-full px-1.5 py-0.5 tabular-nums">
      {n}
    </span>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        <Icon size={12} />
        <span className="text-[10px] uppercase tracking-wide">{label}</span>
      </div>
      <div
        className={`text-xl font-semibold tabular-nums ${
          accent ? "text-primary" : "text-foreground"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
