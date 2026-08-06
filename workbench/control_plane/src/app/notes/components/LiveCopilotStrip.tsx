"use client";

/**
 * LiveCopilotStrip — the copilot, on the screen you're actually looking at.
 *
 * When you record a meeting in-app you sit on the recording screen, but the
 * copilot's output lives in the console at `/notes/live/[id]`. That split is
 * deliberate — the console is the considered view, and recording survives
 * navigation via the RecordingDock — but it left the recording screen saying
 * nothing at all about the copilot. It couldn't even tell you whether one was
 * running, and its copy still promised the copilot "will appear" from before it
 * was built.
 *
 * So: state and control here, depth in the console. The latest suggestion shows
 * inline because during your own meeting you will not go looking for it, and a
 * suggestion you never see is the same as no copilot.
 */

import Icon from "@/components/Icon";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getLiveSession, setCopilot } from "../lib/api";
import type { CopilotEvent, LiveSession } from "../lib/types";

export default function LiveCopilotStrip({ meetingId }: { meetingId: string }) {
  const [session, setSession] = useState<LiveSession | null>(null);
  const [latest, setLatest] = useState<CopilotEvent | null>(null);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);

  // Presence changes on human timescales — polling beats a second stream.
  useEffect(() => {
    let alive = true;
    const load = () =>
      getLiveSession(meetingId)
        .then((s) => alive && setSession(s))
        .catch(() => {});
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [meetingId]);

  // Only subscribed while it's actually on, so an off copilot costs nothing.
  useEffect(() => {
    if (!session?.copilot_enabled) return;
    const es = new EventSource(`/api/notes/meetings/${meetingId}/copilot/stream`);
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as CopilotEvent;
        if (e?.text && e.kind !== "status") {
          setLatest(e);
          setCount((n) => n + 1);
        }
      } catch {
        /* keepalive */
      }
    };
    es.onerror = () => {};
    return () => es.close();
  }, [meetingId, session?.copilot_enabled]);

  if (!session || session.status !== "live") return null;
  const on = session.copilot_enabled;

  async function toggle() {
    setBusy(true);
    try {
      setSession(await setCopilot(meetingId, !on));
    } catch {
      /* the unchanged toggle is the error signal */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`rounded-xl border p-3 ${
        on ? "border-primary/35 bg-primary/[0.06]" : "border-border bg-card"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <Icon name="Sparkles"
          className={`h-4 w-4 shrink-0 ${on ? "text-primary" : "text-muted-foreground"}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Meeting copilot</p>
          <p className="text-[11px] text-muted-foreground">
            {on
              ? count > 0
                ? `Listening · ${count} suggestion${count === 1 ? "" : "s"} so far`
                : "Listening — it stays quiet unless it has something specific."
              : "Off for this meeting."}
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={busy}
          className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-secondary disabled:opacity-50"
        >
          {busy ? "…" : on ? "Turn off" : "Turn on"}
        </button>
      </div>

      {on && latest && (
        <div className="chat-fade-in mt-2.5 rounded-lg border border-primary/30 bg-card p-2.5">
          <p className="text-sm leading-relaxed">{latest.text}</p>
          {latest.refs?.trigger && (
            <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
              ↳ {latest.refs.trigger}
            </p>
          )}
        </div>
      )}

      {on && (
        <Link
          href={`/notes/live/${meetingId}`}
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          <Icon name="Radio" className="h-3.5 w-3.5" />
          {count > 1 ? "See all suggestions and agenda coverage" : "Open the live console"}
        </Link>
      )}
    </div>
  );
}
