"use client";

/**
 * WhatsApp voice calls — the dialer.
 *
 * Places 1:1 and group calls from a QR-paired PERSONAL number, the way
 * WhatsApp Desktop does. Calling rides the whatsmeow bridge + meowcaller, so it
 * exists only on bridge accounts: Meta's Cloud API calling product is 1:1-only,
 * has to be enabled per-number by Meta, and has no media leg here yet.
 *
 * This is the media seam for the note taker — every call's audio is recorded to
 * a WAV on the bridge, which is what the transcription pipeline will consume.
 * See ai-company-brain/specs/whatsapp_calls_note_taker.md.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  Mic,
  Phone,
  PhoneIncoming,
  PhoneOff,
  Users,
} from "lucide-react";
import {
  callAction,
  fetchAccounts,
  fetchCalls,
  placeCall,
} from "../lib/api";
import type { WaAccount, WaCall } from "../lib/types";

/** Phases where the call is still going — drives polling and the hangup button. */
const LIVE_PHASES = new Set([
  "idle",
  "calling",
  "ringing",
  "connecting",
  "active",
  "waiting_room",
]);

const PHASE_LABEL: Record<string, string> = {
  idle: "Starting",
  calling: "Calling",
  ringing: "Ringing",
  connecting: "Connecting",
  active: "In call",
  waiting_room: "Waiting room",
  ended: "Ended",
};

const isLive = (c: WaCall) => LIVE_PHASES.has(c.phase);

function phaseTone(phase: string): string {
  if (phase === "active") return "bg-success/15 text-success";
  if (phase === "ended") return "bg-secondary text-muted-foreground";
  return "bg-warning/15 text-warning";
}

/** Elapsed mm:ss. `now` is passed in (not read from the clock here) so the
 *  value is a pure function of state — no server/client hydration mismatch. */
function clockFrom(iso: string | undefined, now: number): string {
  if (!iso || !now) return "";
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return "";
  const secs = Math.max(0, Math.floor((now - started) / 1000));
  const m = String(Math.floor(secs / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export default function WhatsAppCallsPage() {
  const [accounts, setAccounts] = useState<WaAccount[] | null>(null);
  const [accountId, setAccountId] = useState("");
  const [calls, setCalls] = useState<WaCall[]>([]);
  const [bridgeUp, setBridgeUp] = useState(true);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<"direct" | "group">("direct");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Starts at 0 so the first server render has no clock to mismatch on; the
  // poll below fills it in once mounted.
  const [now, setNow] = useState(0);

  // Calling only exists on the bridge transport; a Cloud API number in this
  // picker would just fail at the gateway, so it never gets offered.
  const callable = useMemo(
    () => (accounts ?? []).filter((a) => a.provider === "whatsmeow"),
    [accounts]
  );

  useEffect(() => {
    void fetchAccounts().then((rows) => {
      setAccounts(rows);
      const bridge = rows.filter((a) => a.provider === "whatsmeow");
      const paired = bridge.find((a) => a.sync_status === "live") ?? bridge[0];
      if (paired) setAccountId(paired.id);
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!accountId) return;
    const res = await fetchCalls(accountId);
    setCalls(res.calls);
    setBridgeUp(res.bridge_reachable);
  }, [accountId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while anything is live, and re-render every second so the in-call
  // timer counts even when the phase itself hasn't changed.
  const anyLive = calls.some(isLive);
  useEffect(() => {
    if (!accountId) return;
    const every = anyLive ? 1500 : 8000;
    const id = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, every);
    return () => clearInterval(id);
  }, [accountId, anyLive, refresh]);

  async function dial() {
    const raw = target.trim();
    if (!raw || !accountId) return;
    setBusy(true);
    setError(null);

    const parts = raw
      .split(/[,\n]/)
      .map((p) => p.trim())
      .filter(Boolean);

    const res = await placeCall(
      mode === "group"
        ? raw.includes("@g.us")
          ? { accountId, groupId: raw }
          : { accountId, targets: parts }
        : { accountId, to: parts[0] ?? raw }
    );

    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "The call couldn't be placed.");
      return;
    }
    setTarget("");
    void refresh();
  }

  async function act(action: "hangup" | "answer" | "reject", call: WaCall) {
    setError(null);
    const res = await callAction(action, accountId, call.call_id);
    if (!res.ok) setError(res.error ?? `Couldn't ${action} that call.`);
    void refresh();
  }

  const live = calls.filter(isLive);
  const recent = calls.filter((c) => !isLive(c));

  // ── empty states ───────────────────────────────────────────────────────────

  if (accounts === null) {
    return (
      <div className="grid place-items-center p-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (callable.length === 0) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <h1 className="mb-2 text-lg font-bold">WhatsApp calls</h1>
        <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">
            No personal number is paired.
          </p>
          <p className="leading-relaxed">
            Calling runs over the QR-paired personal (bridge) transport — a Cloud
            API business number can&apos;t place calls from here. Pair a number
            under <span className="font-mono text-xs">Numbers → Personal WhatsApp</span>{" "}
            and come back.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-lg font-bold text-foreground">
          <Phone className="h-4 w-4 text-primary" />
          WhatsApp calls
        </h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Place 1:1 and group calls from your paired personal number. Audio is
          recorded on the bridge — the raw material for meeting notes.
        </p>
      </header>

      {/* The ToS posture is the first thing on the page, not a footnote: an
          automated client placing calls is the fastest way to lose a number. */}
      <div className="mb-4 flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2.5 text-[11px] leading-relaxed text-warning">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Calling from an unofficial client is outside WhatsApp&apos;s Terms of
          Service and the number can be banned. Use a number you&apos;re willing
          to lose — never the company&apos;s main line. Everyone on the call
          should know it&apos;s being recorded.
        </span>
      </div>

      {!bridgeUp && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          The WhatsApp bridge isn&apos;t reachable, so calls can&apos;t be placed.
          Check that the <span className="font-mono">whatsapp_bridge</span>{" "}
          service is running.
        </div>
      )}

      {/* dialer */}
      <div className="rounded-2xl border border-border bg-card p-4">
        {callable.length > 1 && (
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="mb-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-xs"
          >
            {callable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name || a.phone_number || "Personal WhatsApp"}
              </option>
            ))}
          </select>
        )}

        <div className="mb-3 inline-flex rounded-lg bg-secondary p-0.5 text-xs">
          {(["direct", "group"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 tech-transition ${
                mode === m
                  ? "bg-card font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {m === "direct" ? (
                <Phone className="h-3 w-3" />
              ) : (
                <Users className="h-3 w-3" />
              )}
              {m === "direct" ? "1:1" : "Group"}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void dial();
            }}
            placeholder={
              mode === "direct"
                ? "+91 98765 43210"
                : "Group id (…@g.us), or two or more numbers, comma-separated"
            }
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            onClick={() => void dial()}
            disabled={busy || !target.trim() || !bridgeUp}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 tech-transition disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Phone className="h-3.5 w-3.5" />
            )}
            {busy ? "Calling…" : "Call"}
          </button>
        </div>

        {mode === "group" && (
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            A group call needs a WhatsApp group id, or at least two numbers for
            an ad-hoc call. Group calling is experimental — expect rough edges.
          </p>
        )}

        {error && (
          <p className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
            {error}
          </p>
        )}
      </div>

      {/* live calls */}
      {live.length > 0 && (
        <section className="mt-5">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            On a call
          </h2>
          <div className="space-y-2">
            {live.map((c) => (
              <div
                key={c.call_id}
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-3"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
                  {c.direction === "incoming" ? (
                    <PhoneIncoming className="h-4 w-4" />
                  ) : c.kind === "group" ? (
                    <Users className="h-4 w-4" />
                  ) : (
                    <Phone className="h-4 w-4" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {c.peer || c.targets?.join(", ") || "Unknown"}
                  </p>
                  <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className={`rounded px-1.5 py-0.5 ${phaseTone(c.phase)}`}>
                      {PHASE_LABEL[c.phase] ?? c.phase}
                    </span>
                    {c.phase === "active" && (
                      <span className="font-mono">
                        {clockFrom(c.started_at, now)}
                      </span>
                    )}
                    {c.recording && (
                      <span className="inline-flex items-center gap-1">
                        <Mic className="h-3 w-3" /> recording
                      </span>
                    )}
                  </p>
                </div>
                {c.direction === "incoming" && c.phase === "ringing" ? (
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => void act("answer", c)}
                      className="rounded-lg bg-success px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 tech-transition"
                    >
                      Answer
                    </button>
                    <button
                      onClick={() => void act("reject", c)}
                      className="rounded-lg bg-secondary px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground tech-transition"
                    >
                      Decline
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => void act("hangup", c)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 tech-transition"
                  >
                    <PhoneOff className="h-3.5 w-3.5" />
                    Hang up
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* recent */}
      {recent.length > 0 && (
        <section className="mt-5">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent
          </h2>
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {recent.map((c) => (
              <div key={c.call_id} className="flex items-center gap-3 p-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
                  <PhoneOff className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-foreground">
                    {c.peer || c.targets?.join(", ") || "Unknown"}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {c.direction === "incoming" ? "Incoming" : "Outgoing"}
                    {c.kind === "group" ? " group call" : ""}
                    {c.end_reason ? ` · ${c.end_reason}` : ""}
                  </p>
                </div>
                {c.recording && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
                    title={c.recording}
                  >
                    <Mic className="h-3 w-3" /> saved
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {live.length === 0 && recent.length === 0 && bridgeUp && (
        <p className="mt-6 text-center text-xs text-muted-foreground">
          No calls yet. Dial a number above to place the first one.
        </p>
      )}
    </div>
  );
}
