"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Loader2, Send, Mail, MailOpen, Reply, Paperclip, Check, Newspaper,
  Settings2,
} from "lucide-react";
import {
  getDigest, sendDigest, getAssistantSettings, saveAssistantSettings,
} from "../../lib/api";
import {
  DigestData, AssistantSettings, DigestFrequency, WEEKDAYS,
} from "../../lib/types";
import { Modal, Toggle } from "./ui";

interface DigestViewProps {
  accountId: string | null;
}

const INPUT_CLS =
  "w-full bg-background border border-border rounded-md px-2.5 py-2 text-xs " +
  "text-foreground outline-none focus:border-primary transition-colors";

export function DigestView({ accountId }: DigestViewProps) {
  const [period, setPeriod] = useState<"day" | "week">("day");
  const [data, setData] = useState<DigestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getDigest(accountId, period)
      .then(setData)
      .catch((e) => setError(e.message || "Failed to build digest"))
      .finally(() => setLoading(false));
  }, [accountId, period]);

  useEffect(load, [load]);

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
        <DigestConfigDialog
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
            <Loader2 className="animate-spin" size={16} /> Building digest…
          </div>
        ) : !data ? null : (
          <>
            {/* Stat row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat icon={Mail} label="In inbox" value={t!.inbox} />
              <Stat icon={MailOpen} label="Unread" value={t!.unread} accent />
              <Stat icon={Reply} label="Needs reply" value={t!.needs_reply} />
              <Stat icon={Paperclip} label="Attachments" value={t!.attachments} />
            </div>

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
                    <div
                      key={c.category}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-foreground">{c.category}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {c.count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Top senders */}
              <div className="bg-card border border-border rounded-xl p-4">
                <h3 className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
                  <Mail size={13} className="text-primary" /> Top senders
                </h3>
                <div className="space-y-1.5">
                  {data.top_senders.length === 0 && (
                    <p className="text-xs text-muted-foreground">No senders.</p>
                  )}
                  {data.top_senders.map((s) => (
                    <div
                      key={s.email}
                      className="flex items-center justify-between text-xs gap-2"
                    >
                      <span className="text-foreground truncate">{s.name}</span>
                      <span className="text-muted-foreground tabular-nums flex-shrink-0">
                        {s.count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Want this emailed automatically?{" "}
              <button
                onClick={() => setShowConfig(true)}
                className="text-primary hover:opacity-80"
              >
                Configure a recurring digest →
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** Inline digest schedule config (inbox-zero's "Configure" dialog). */
function DigestConfigDialog({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose: () => void;
}) {
  const [s, setS] = useState<AssistantSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getAssistantSettings(accountId).then(setS).catch(() => {});
  }, [accountId]);

  const set = (patch: Partial<AssistantSettings>) =>
    setS((prev) => (prev ? { ...prev, ...patch } : prev));

  const save = async () => {
    if (!s) return;
    setSaving(true);
    setErr(null);
    try {
      await saveAssistantSettings(s);
      onClose();
    } catch (e) {
      setErr((e as Error).message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Digest schedule"
      description="Get a recurring summary of your inbox emailed to you."
      onClose={onClose}
      maxWidth="max-w-md"
      footer={
        <button
          onClick={save}
          disabled={saving || !s}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 className="animate-spin" size={13} /> : <Check size={13} />}
          Save
        </button>
      }
    >
      {!s ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="animate-spin" size={14} /> Loading…
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="text-[11px] text-muted-foreground">Frequency</label>
            <select
              value={s.digest_frequency}
              onChange={(e) =>
                set({ digest_frequency: e.target.value as DigestFrequency })
              }
              className={INPUT_CLS}
            >
              <option value="OFF">Off</option>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
            </select>
          </div>
          {s.digest_frequency === "WEEKLY" && (
            <div>
              <label className="text-[11px] text-muted-foreground">Day of week</label>
              <select
                value={s.digest_day_of_week}
                onChange={(e) =>
                  set({ digest_day_of_week: parseInt(e.target.value, 10) })
                }
                className={INPUT_CLS}
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
          {s.digest_frequency !== "OFF" && (
            <div>
              <label className="text-[11px] text-muted-foreground">Time of day (UTC)</label>
              <input
                type="time"
                value={s.digest_time_of_day}
                onChange={(e) => set({ digest_time_of_day: e.target.value })}
                className={INPUT_CLS}
              />
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-foreground">Email the digest to me</span>
            <Toggle
              enabled={s.digest_send_to_email}
              onChange={(v) => set({ digest_send_to_email: v })}
            />
          </div>
          {err && (
            <div className="text-[11px] text-destructive bg-destructive/10 rounded-md px-2 py-1.5">
              {err}
            </div>
          )}
        </div>
      )}
    </Modal>
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
