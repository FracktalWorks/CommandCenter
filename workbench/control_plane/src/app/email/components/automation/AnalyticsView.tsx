"use client";

import { useEffect, useState } from "react";
import {
  Mail, MailOpen, Send, Archive, Star, Paperclip, Loader2, BarChart3,
  Sparkles, Zap,
} from "lucide-react";
import { getAnalyticsOverview } from "../../lib/api";
import { AnalyticsOverview } from "../../lib/types";
import { folderLabel } from "../../lib/utils";

interface AnalyticsViewProps {
  accountId: string | null;
}

const RANGES = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

export function AnalyticsView({ accountId }: AnalyticsViewProps) {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getAnalyticsOverview(accountId ?? undefined, days)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message || "Failed to load analytics"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [accountId, days]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground gap-2 text-sm">
        <Loader2 className="animate-spin" size={16} /> Loading analytics…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive text-sm">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const t = data.totals;
  const maxVol = Math.max(1, ...data.volume.map((v) => v.received + v.sent));
  const maxSender = Math.max(1, ...data.top_senders.map((s) => s.count));

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-5 py-4 space-y-5">
      {/* Range selector */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Inbox activity for the last {days} days
        </p>
        <div className="flex items-center gap-1 bg-secondary rounded-lg p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                days === r.days
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard icon={Mail} label="Total" value={t.total} />
        <StatCard icon={MailOpen} label="Unread" value={t.unread} accent />
        <StatCard
          icon={BarChart3}
          label="Read rate"
          value={`${Math.round(t.read_rate * 100)}%`}
        />
        <StatCard icon={Send} label="Sent" value={t.sent} />
        <StatCard icon={Archive} label="Archived" value={t.archived} />
        <StatCard icon={Star} label="Starred" value={t.starred} />
      </div>

      {/* Volume chart */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
          <BarChart3 size={13} className="text-primary" /> Volume over time
        </h3>
        {data.volume.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">
            No messages in this range.
          </p>
        ) : (
          <div className="flex items-end gap-1 h-36">
            {data.volume.map((v) => {
              const h = ((v.received + v.sent) / maxVol) * 100;
              const recH = v.received + v.sent > 0
                ? (v.received / (v.received + v.sent)) * 100
                : 0;
              return (
                <div
                  key={v.day}
                  className="flex-1 flex flex-col justify-end group relative"
                  title={`${v.day}: ${v.received} received, ${v.sent} sent`}
                >
                  <div
                    className="w-full rounded-t bg-primary/30 overflow-hidden flex flex-col justify-end"
                    style={{ height: `${Math.max(2, h)}%` }}
                  >
                    <div
                      className="w-full bg-primary"
                      style={{ height: `${recH}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-4 mt-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-primary" /> Received
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-primary/30" /> Sent
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top senders */}
        <div className="bg-card border border-border rounded-xl p-4">
          <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
            <Mail size={13} className="text-primary" /> Top senders
          </h3>
          <div className="space-y-2">
            {data.top_senders.length === 0 && (
              <p className="text-xs text-muted-foreground">No data.</p>
            )}
            {data.top_senders.map((s) => (
              <div key={s.email} className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-foreground truncate">
                    {s.name || s.email}
                  </div>
                  <div className="h-1.5 bg-secondary rounded-full mt-1 overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full"
                      style={{ width: `${(s.count / maxSender) * 100}%` }}
                    />
                  </div>
                </div>
                <span className="text-[11px] text-muted-foreground tabular-nums w-10 text-right">
                  {s.count}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* By folder */}
        <div className="bg-card border border-border rounded-xl p-4">
          <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
            <Archive size={13} className="text-primary" /> By folder
          </h3>
          <div className="space-y-1.5">
            {data.by_folder.map((f) => (
              <div
                key={f.folder}
                className="flex items-center justify-between text-xs"
              >
                <span className="text-foreground capitalize">
                  {folderLabel(f.folder)}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {f.count}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 pt-3 border-t border-border flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Paperclip size={11} /> {t.with_attachments} with attachments
          </div>
        </div>
      </div>

      {/* Assistant automation — emails processed + actions taken (inbox-zero) */}
      {(data.rule_stats || data.action_stats) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-card border border-border rounded-xl p-4">
            <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
              <Sparkles size={13} className="text-primary" /> Assistant processed
            </h3>
            <div className="text-2xl font-semibold text-foreground tabular-nums">
              {data.rule_stats?.processed ?? 0}
            </div>
            <p className="text-[11px] text-muted-foreground mb-3">
              emails handled by your rules
            </p>
            <div className="space-y-1.5">
              {(data.rule_stats?.by_rule ?? []).map((r) => (
                <div
                  key={r.rule_name}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="text-foreground truncate">{r.rule_name}</span>
                  <span className="text-muted-foreground tabular-nums ml-2">
                    {r.count}
                  </span>
                </div>
              ))}
              {(data.rule_stats?.by_rule ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No rules have run yet.
                </p>
              )}
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-4">
            <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
              <Zap size={13} className="text-primary" /> Actions taken
            </h3>
            <div className="space-y-1.5">
              {(data.action_stats ?? []).map((a) => (
                <div
                  key={a.action}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="text-foreground capitalize">
                    {a.action.toLowerCase().replace(/_/g, " ")}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {a.count}
                  </span>
                </div>
              ))}
              {(data.action_stats ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No actions taken yet.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
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
