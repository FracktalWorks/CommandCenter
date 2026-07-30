"use client";

/**
 * ActiveBots — the live "notetakers in meetings right now" surface (spec §3.13).
 * Polls the active-bot list (which also advances each bot's status server-side)
 * and shows honest states: joining → waiting to be admitted → recording →
 * processing. Multiple bots show at once — that's the multi-meeting fan-out.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Radio, Square, Video } from "lucide-react";
import { listActiveBots, stopBot } from "../lib/api";
import type { MeetingBot, MeetingBotStatus } from "../lib/types";

const BOT_META: Record<
  MeetingBotStatus,
  { label: string; dot: string; text: string; pulse?: boolean }
> = {
  requested: { label: "Requesting…", dot: "bg-muted", text: "text-muted-foreground" },
  joining: { label: "Joining…", dot: "bg-warning", text: "text-warning", pulse: true },
  waiting_room: {
    label: "Waiting to be admitted",
    dot: "bg-warning",
    text: "text-warning",
    pulse: true,
  },
  in_call: { label: "Recording", dot: "bg-destructive", text: "text-destructive", pulse: true },
  processing: { label: "Processing…", dot: "bg-warning", text: "text-warning", pulse: true },
  done: { label: "Done", dot: "bg-success", text: "text-success" },
  failed: { label: "Failed", dot: "bg-destructive", text: "text-destructive" },
  left: { label: "Left", dot: "bg-muted", text: "text-muted-foreground" },
  not_admitted: { label: "Not admitted", dot: "bg-destructive", text: "text-destructive" },
};

interface ActiveBotsProps {
  /** Bump to force an immediate reload (e.g. right after dispatching a bot). */
  reloadSignal: number;
  /** Fired when the active set changes, so the parent can refresh its list. */
  onChange: () => void;
}

export default function ActiveBots({ reloadSignal, onChange }: ActiveBotsProps) {
  const router = useRouter();
  const [bots, setBots] = useState<MeetingBot[]>([]);
  const [stopping, setStopping] = useState<string | null>(null);
  const prevCount = useRef(0);

  const load = useCallback(async () => {
    try {
      const next = await listActiveBots();
      setBots(next);
      // When the active set shrinks a bot finished → tell the parent to refresh
      // the meeting list so the completed meeting shows up.
      if (next.length !== prevCount.current) {
        prevCount.current = next.length;
        onChange();
      }
    } catch {
      /* transient — keep the last snapshot */
    }
  }, [onChange]);

  useEffect(() => {
    // Syncs an external system (the active-bot list) into React; load() is
    // async so its setState lands after the fetch, not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, reloadSignal]);

  // Poll while any bot is live; back off entirely when none are.
  useEffect(() => {
    if (bots.length === 0) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [bots.length, load]);

  async function onStop(meetingId: string) {
    setStopping(meetingId);
    try {
      await stopBot(meetingId);
      await load();
    } catch {
      /* ignore — next poll reconciles */
    } finally {
      setStopping(null);
    }
  }

  if (bots.length === 0) return null;

  // A bot that never got into the call fails for reasons only a human can fix
  // — admit it, sign it in, use a different link. Showing the status alone
  // ("Failed") tells you none of that, so the worker's own explanation is
  // rendered verbatim — with a fallback when no explanation survived, so a
  // dead bot can never masquerade as a healthy one.
  const isDead = (b: MeetingBot) =>
    b.status === "failed" || b.status === "not_admitted";
  const explainText = (b: MeetingBot) =>
    b.error ||
    "The notetaker didn't make it into this call and left no explanation. " +
      "Open the meeting for diagnostics, or send it again.";

  const running = bots.filter((b) => !isDead(b)).length;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 px-1">
        <Video className="h-3.5 w-3.5 text-primary" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
          Notetakers ({running} in meetings)
        </span>
      </div>
      {bots.map((b) => {
        const meta = BOT_META[b.status] ?? BOT_META.processing;
        const bad = isDead(b);
        return (
          <div
            key={b.id}
            className={`rounded-xl border p-3 ${
              bad
                ? "border-destructive/30 bg-destructive/[0.04]"
                : "border-primary/25 bg-primary/[0.04]"
            }`}
          >
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push(`/notes/meeting/${b.meeting_id}`)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              title="Open this meeting"
            >
              <Video
                className={`h-5 w-5 shrink-0 ${
                  bad ? "text-destructive" : "text-primary"
                }`}
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">
                  {b.meeting_title || "Live meeting"}
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {b.meeting_url}
                </p>
              </div>
            </button>
            <span className={`flex shrink-0 items-center gap-1.5 text-xs ${meta.text}`}>
              <span
                className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${
                  meta.pulse ? "animate-pulse" : ""
                }`}
              />
              {meta.label}
            </span>
            {!bad && b.status === "in_call" && (
              <button
                onClick={() => router.push(`/notes/live/${b.meeting_id}`)}
                className="shrink-0 rounded-lg border border-primary/30 p-1.5 text-primary hover:bg-primary/10 tech-transition"
                title="Open the live console (transcript + copilot)"
                aria-label="Open live console"
              >
                <Radio className="h-4 w-4" />
              </button>
            )}
            {!bad && (
              <button
                onClick={() => void onStop(b.meeting_id)}
                disabled={stopping === b.meeting_id}
                className="shrink-0 rounded-lg bg-destructive/15 p-1.5 text-destructive hover:bg-destructive/25 tech-transition disabled:opacity-50"
                title="Remove the notetaker from this call"
                aria-label="Stop notetaker"
              >
                {stopping === b.meeting_id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-4 w-4 fill-current" />
                )}
              </button>
            )}
          </div>
          {bad && (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{explainText(b)}</span>
            </p>
          )}
          </div>
        );
      })}
    </div>
  );
}
