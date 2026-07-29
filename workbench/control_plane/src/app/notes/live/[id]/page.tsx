"use client";

/**
 * Copilot console — watch a meeting that is happening RIGHT NOW.
 *
 * Two columns, because a live call has exactly two jobs. The transcript is what
 * your eye rests on, so it gets the width. The copilot gets a rail, because its
 * output arrives in bursts and needs somewhere to arrive *to*.
 *
 * Setup deliberately isn't here. Agenda, briefing and context are written in
 * prep (`/notes/meeting/[id]` before it starts) — during a call you can't type
 * them anyway, and six equal-weight cards of setup above the transcript is what
 * made this screen unreadable.
 *
 * The agenda panel is the piece worth having: `coverage()` already knew which
 * items had been discussed, but only fed a prompt. Shown as a live checklist it
 * answers the question every meeting owner silently tracks — are we going to
 * get through this?
 *
 * Works for BOTH capture sources because both feed one bus: a headless bot in a
 * Meet call, or your own mic. Reattaches by id, so a refresh never drops it.
 */

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Check,
  Circle,
  ListChecks,
  Loader2,
  Mic,
  Settings2,
  Sparkles,
  Users,
} from "lucide-react";
import { speakerEdge, speakerText } from "../../lib/speakers";
import {
  getAgendaProgress,
  getLiveRoster,
  getLiveSession,
  setCopilot,
} from "../../lib/api";
import type {
  AgendaProgress,
  CopilotEvent,
  LiveSegment,
  LiveSession,
  LiveSpeaker,
} from "../../lib/types";

/** Keep the rendered transcript bounded — this can run for hours. */
const MAX_LINES = 300;

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function LiveConsolePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [roster, setRoster] = useState<LiveSpeaker[]>([]);
  const [lines, setLines] = useState<LiveSegment[]>([]);
  const [suggestions, setSuggestions] = useState<CopilotEvent[]>([]);
  const [progress, setProgress] = useState<AgendaProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    const [s, r, p] = await Promise.all([
      getLiveSession(id).catch(() => null),
      getLiveRoster(id).catch(() => [] as LiveSpeaker[]),
      getAgendaProgress(id).catch(() => null),
    ]);
    setSession(s);
    setRoster(r);
    if (p) setProgress(p);
    setLoading(false);
  }, [id]);

  // Poll session + roster + coverage: all change on human timescales, so
  // polling is cheaper and simpler than more streams.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // The transcript IS worth a stream — words arrive continuously.
  useEffect(() => {
    const es = new EventSource(`/api/notes/meetings/${id}/live`);
    es.onmessage = (ev) => {
      try {
        const seg = JSON.parse(ev.data) as LiveSegment;
        if (!seg?.text) return;
        setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), seg]);
      } catch {
        /* keepalive / non-JSON frame */
      }
    };
    es.onerror = () => {};
    return () => es.close();
  }, [id]);

  // The copilot's output is its own channel, so its chatter never mixes into
  // the transcript. Only subscribed while it's actually on.
  useEffect(() => {
    if (!session?.copilot_enabled) return;
    const es = new EventSource(`/api/notes/meetings/${id}/copilot/stream`);
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as CopilotEvent;
        if (e?.text) setSuggestions((prev) => [...prev.slice(-49), e]);
      } catch {
        /* keepalive */
      }
    };
    es.onerror = () => {};
    return () => es.close();
  }, [id, session?.copilot_enabled]);

  // Follow the transcript only where it has its own scroll container. On a
  // phone the whole page scrolls, so auto-scrolling would yank the user past
  // the copilot every time anyone spoke.
  useEffect(() => {
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines]);

  async function onToggleCopilot() {
    if (!session) return;
    setBusy(true);
    try {
      setSession(await setCopilot(id, !session.copilot_enabled));
    } catch {
      /* surfaced by the unchanged toggle state */
    } finally {
      setBusy(false);
    }
  }

  const live = session?.status === "live";
  const tips = suggestions.filter((e) => e.kind !== "status");
  const lastStatus = [...suggestions].reverse().find((e) => e.kind === "status");
  const nameFor = (seg: LiveSegment) =>
    seg.speaker_name ?? seg.speaker_id ?? seg.speaker_label ?? "Speaker";

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-sm text-muted-foreground">
          No live session for this meeting.
        </p>
        <Link
          href={`/notes/meeting/${id}`}
          className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Open the meeting
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header — what's live, from where, and the one control that matters */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
        <Link
          href="/notes"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Back to notes"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold sm:text-lg">
            {session.title ?? "Untitled meeting"}
          </h1>
          <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {session.source === "bot" ? (
              <Bot className="h-3.5 w-3.5" />
            ) : (
              <Mic className="h-3.5 w-3.5" />
            )}
            {session.source === "bot" ? "Notetaker in call" : "Recording here"}
            {roster.length > 0 && <span>· {roster.length} speakers</span>}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-3">
          {live ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-destructive">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
              </span>
              LIVE
              {progress && progress.elapsed_s > 0 && (
                <span className="ml-1 font-mono tabular-nums">
                  {clock(progress.elapsed_s)}
                </span>
              )}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Ended</span>
          )}
          <Link
            href={`/notes/meeting/${id}`}
            className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
            title="Agenda, briefing and context for this meeting"
            aria-label="Meeting setup"
          >
            <Settings2 className="h-4 w-4" />
          </Link>
          <button
            onClick={onToggleCopilot}
            disabled={busy || !live}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
              session.copilot_enabled
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-secondary"
            }`}
          >
            <Sparkles className="h-4 w-4" />
            {busy ? "…" : session.copilot_enabled ? "Copilot on" : "Copilot off"}
          </button>
        </div>
      </div>

      {/* Two columns on a desktop: transcript reads, rail informs.
          On a phone they stack, and the ORDER flips — the copilot and agenda
          are the glanceable things, and burying them under a transcript that
          grows all meeting would put them permanently off-screen. The page
          scrolls as one there too; two nested scroll areas on a phone is a
          way to trap a thumb. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[1.6fr_1fr] lg:overflow-hidden">
        {/* ── Transcript ───────────────────────────────────────────────── */}
        <div className="order-2 min-h-0 border-border px-4 py-4 sm:px-6 lg:order-1 lg:overflow-y-auto lg:border-r">
          <p className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Live transcript
            <span className="font-mono text-[10px] normal-case tracking-normal opacity-70">
              draft — refined when the call ends
            </span>
          </p>
          {lines.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {live
                ? "Waiting for speech…"
                : "This session has ended. The full transcript is on the meeting page."}
            </p>
          ) : (
            <div className="space-y-3">
              {lines.map((seg, i) => {
                const key = seg.speaker_id ?? seg.speaker_label;
                const prev = lines[i - 1];
                const sameSpeaker =
                  prev &&
                  (prev.speaker_id ?? prev.speaker_label) ===
                    (seg.speaker_id ?? seg.speaker_label);
                return (
                  <div key={i} className="grid grid-cols-[3.25rem_1fr] gap-3">
                    <span className="pt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                      {seg.start_s ? clock(seg.start_s) : ""}
                    </span>
                    <div className={`border-l-2 pl-3 ${speakerEdge(key)}`}>
                      {!sameSpeaker && (
                        <span
                          className={`mb-0.5 block text-[11px] font-bold ${speakerText(key)}`}
                        >
                          {nameFor(seg)}
                        </span>
                      )}
                      <p className="text-sm leading-relaxed text-foreground/90">
                        {seg.text}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* ── Rail: copilot, agenda coverage, room ─────────────────────── */}
        <div className="order-1 min-h-0 space-y-5 border-b border-border px-4 py-4 sm:px-6 lg:order-2 lg:border-b-0 lg:overflow-y-auto">
          {/* Copilot output arrives here. */}
          <section>
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
              <Sparkles className="h-3.5 w-3.5" /> Copilot
              {tips.length > 0 && (
                <span className="font-mono text-[10px] normal-case tracking-normal opacity-70">
                  {tips.length}
                </span>
              )}
            </p>
            {!session.copilot_enabled ? (
              <p className="rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">
                Off for this meeting. Turn it on above and it will listen and
                chime in when a moment warrants it.
              </p>
            ) : tips.length === 0 ? (
              <p className="rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
                {lastStatus?.text ??
                  "Listening — it stays quiet unless it has something specific."}
              </p>
            ) : (
              <div className="space-y-2">
                {tips
                  .slice(-6)
                  .reverse()
                  .map((e, i) => (
                    <div
                      key={i}
                      className="chat-fade-in rounded-xl border border-primary/35 bg-primary/[0.07] p-3"
                    >
                      <p className="text-sm leading-relaxed">{e.text}</p>
                      {/* Grounding: what triggered it, so a suggestion is
                          inspectable rather than an oracle. */}
                      {e.refs?.trigger && (
                        <p className="mt-2 border-t border-dashed border-primary/20 pt-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                          ↳ {e.refs.trigger}
                          {e.refs.speakers?.length
                            ? ` · ${e.refs.speakers.join(", ")}`
                            : ""}
                        </p>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </section>

          {/* Agenda coverage — the question every meeting owner is tracking. */}
          {progress && progress.total > 0 && (
            <section>
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <ListChecks className="h-3.5 w-3.5" /> Agenda
                <span className="font-mono text-[10px] normal-case tracking-normal opacity-70">
                  {progress.covered_count} of {progress.total}
                  {progress.elapsed_s > 60 &&
                    ` · ${Math.round(progress.elapsed_s / 60)} min in`}
                </span>
              </p>
              <div className="mb-2 flex gap-1">
                {progress.items.map((it, i) => (
                  <span
                    key={i}
                    className={`h-1 flex-1 rounded-full ${
                      it.covered ? "bg-success" : "bg-secondary"
                    }`}
                  />
                ))}
              </div>
              <ul className="space-y-1">
                {progress.items.map((it, i) => (
                  <li
                    key={i}
                    className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-sm ${
                      it.covered
                        ? "border-success/30 bg-success/[0.06]"
                        : "border-warning/25"
                    }`}
                  >
                    {it.covered ? (
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                    ) : (
                      <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning/70" />
                    )}
                    <span
                      className={
                        it.covered ? "text-muted-foreground" : "text-foreground"
                      }
                    >
                      {it.title}
                    </span>
                  </li>
                ))}
              </ul>
              {progress.covered_count < progress.total && (
                <p className="mt-1.5 text-[11px] text-warning">
                  {progress.total - progress.covered_count} item
                  {progress.total - progress.covered_count === 1 ? "" : "s"} not
                  touched yet.
                </p>
              )}
            </section>
          )}

          {/* Who's on the call, per the live voiceprint gallery. */}
          <section>
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> In the room
            </p>
            {roster.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Listening for speakers…
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {roster.map((s) => {
                  return (
                    <span
                      key={s.speaker_id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-sm"
                      title={`${s.utterances} utterance${
                        s.utterances === 1 ? "" : "s"
                      }`}
                    >
                      <span className={`text-[8px] ${speakerText(s.speaker_id)}`}>●</span>
                      {s.name ?? s.speaker_id}
                      {s.role ? (
                        <span className="text-xs text-muted-foreground">
                          {s.role}
                        </span>
                      ) : null}
                    </span>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
