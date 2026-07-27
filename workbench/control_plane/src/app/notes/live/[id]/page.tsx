"use client";

/**
 * Copilot console — watch a meeting that is happening RIGHT NOW.
 *
 * Phase A of the Live Meeting Copilot (spec §7, §13): read-only presence +
 * a live transcript attributed by the speaker roster, plus the opt-in toggle
 * scaffold. No LLM runs yet — the copilot's suggestion stream arrives in Phase B;
 * this is the surface it will stream into, and the place you control it from.
 *
 * It works for BOTH capture sources because both feed one bus: a headless bot in
 * a Meet call, or your own mic on the recording screen. Reattaches to a running
 * session by id, so a refresh or navigating away never drops it.
 */

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Loader2,
  Mic,
  Sparkles,
  Users,
} from "lucide-react";
import {
  getLiveRoster,
  getLiveSession,
  setCopilot,
} from "../../lib/api";
import type { LiveSegment, LiveSession, LiveSpeaker } from "../../lib/types";

/** Keep the rendered transcript bounded — this can run for hours. */
const MAX_LINES = 300;

export default function LiveConsolePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [roster, setRoster] = useState<LiveSpeaker[]>([]);
  const [lines, setLines] = useState<LiveSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    const [s, r] = await Promise.all([
      getLiveSession(id).catch(() => null),
      getLiveRoster(id).catch(() => [] as LiveSpeaker[]),
    ]);
    setSession(s);
    setRoster(r);
    setLoading(false);
  }, [id]);

  // Poll session + roster: both change on human timescales (a speaker joining,
  // a name being detected), so polling is cheaper and simpler than a 2nd stream.
  useEffect(() => {
    // Syncs an external system (the live-session registry) into React; refresh()
    // is async so its setState lands after the fetch, not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // The transcript itself IS worth a stream — words arrive continuously.
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
    // Errors are expected (the stream ends when the meeting does); EventSource
    // reconnects on its own, and live is best-effort by design.
    es.onerror = () => {};
    return () => es.close();
  }, [id]);

  useEffect(() => {
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
    <div className="mx-auto max-w-4xl px-4 py-6">
      {/* Header — what's live, from where, since when */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link
          href="/notes"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Back to notes"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold">
          {session.title ?? "Untitled meeting"}
        </h1>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {session.source === "bot" ? (
            <Bot className="h-3.5 w-3.5" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
          {session.source === "bot" ? "Notetaker in call" : "Recording here"}
        </span>
        {live ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
            Live
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Ended</span>
        )}
      </div>

      {/* Copilot opt-in. Off by default; honest that it doesn't act yet. */}
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
        <Sparkles className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Meeting copilot</p>
          <p className="text-xs text-muted-foreground">
            {session.copilot_enabled
              ? "On — it will listen and suggest talking points once the orchestrator ships."
              : "Off. Opt in to let an agent listen and suggest talking points."}
          </p>
        </div>
        <button
          onClick={onToggleCopilot}
          disabled={busy || !live}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          {busy ? "…" : session.copilot_enabled ? "Turn off" : "Turn on"}
        </button>
      </div>

      {/* Roster — who's on the call, per the live voiceprint gallery */}
      <div className="mb-5 rounded-xl border border-border bg-card p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Users className="h-3.5 w-3.5" /> In the room
        </p>
        {roster.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Listening for speakers…
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {roster.map((s) => (
              <span
                key={s.speaker_id}
                className="rounded-full border border-border px-2.5 py-1 text-sm"
                title={`${s.utterances} utterance${s.utterances === 1 ? "" : "s"}`}
              >
                {s.name ?? s.speaker_id}
                {s.role ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {s.role}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* The live transcript, attributed by the roster */}
      <div className="rounded-xl border border-border bg-card p-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Live transcript
        </p>
        {lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {live
              ? "Waiting for speech…"
              : "This session has ended. The full transcript is on the meeting page."}
          </p>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {lines.map((seg, i) => (
              <p key={i} className="text-sm leading-relaxed">
                <span className="mr-2 font-medium text-primary">
                  {nameFor(seg)}
                </span>
                <span className="text-foreground/90">{seg.text}</span>
              </p>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <p className="mt-3 text-center text-xs text-muted-foreground">
        Live is a fast draft — the authoritative transcript is written when the
        meeting ends.
      </p>
    </div>
  );
}
