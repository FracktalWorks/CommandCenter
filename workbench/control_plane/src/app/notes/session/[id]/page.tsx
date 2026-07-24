"use client";

/**
 * /notes/session/[id] — the live recording screen (spec §5.1: "studio, not
 * form"). This is now a VIEW onto the global recording store (recordingStore.ts)
 * rather than the owner of the recorder: the capture lives in AppShell so it
 * survives navigation and collapses into the RecordingDock when you leave.
 * Mic capture → chunked upload; on stop the pipeline transcribes and writes
 * notes, and we hand off to the meeting detail view.
 */

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Mic, Pause, Play, Square } from "lucide-react";
import {
  LEVEL_BARS,
  isActive,
  levelBuffer,
  useRecordingStore,
} from "../../lib/recordingStore";
import { formatClock, getMeeting, saveScratchNotes } from "../../lib/api";

const BARS = LEVEL_BARS;

export default function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Recording state lives in the global store (survives navigation).
  const meetingId = useRecordingStore((s) => s.meetingId);
  const phase = useRecordingStore((s) => s.phase);
  const elapsed = useRecordingStore((s) => s.elapsed);
  const backlog = useRecordingStore((s) => s.backlog);
  const error = useRecordingStore((s) => s.error);
  const captions = useRecordingStore((s) => s.captions);
  const interim = useRecordingStore((s) => s.interim);
  const liveOff = useRecordingStore((s) => s.liveOff);
  const startRec = useRecordingStore((s) => s.start);
  const pauseRec = useRecordingStore((s) => s.pause);
  const resumeRec = useRecordingStore((s) => s.resume);
  const stopRec = useRecordingStore((s) => s.stop);
  const cancelRec = useRecordingStore((s) => s.cancel);
  const setTitle = useRecordingStore((s) => s.setTitle);

  const isThis = meetingId === id;
  const active = isActive(phase);
  // A recording is running for a DIFFERENT meeting — don't clobber it.
  const otherActive = active && meetingId !== null && meetingId !== id;

  const [scratch, setScratch] = useState("");
  const scratchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capEndRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const primary =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--primary")
        .trim() || "198 89% 50%";
    ctx.fillStyle = `hsl(${primary})`;
    const gap = 3;
    const bw = (w - gap * (BARS - 1)) / BARS;
    for (let i = 0; i < BARS; i++) {
      const lvl = levelBuffer[i] ?? 0;
      const bh = Math.max(2, lvl * h);
      const x = i * (bw + gap);
      const y = (h - bh) / 2;
      ctx.globalAlpha = 0.4 + lvl * 0.6;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, bw / 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, []);

  // Redraw loop while this meeting is actively capturing.
  useEffect(() => {
    if (!isThis || (phase !== "recording" && phase !== "paused")) return;
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [isThis, phase, draw]);

  // Keep the live caption feed pinned to the newest line.
  useEffect(() => {
    capEndRef.current?.scrollIntoView({ block: "end" });
  }, [captions, interim]);

  async function begin() {
    await startRec(id);
    // Best-effort: pull the meeting's title so the dock can label it.
    void getMeeting(id)
      .then((m) => m.title && setTitle(m.title))
      .catch(() => {});
  }

  async function finish() {
    try {
      if (scratchTimer.current) clearTimeout(scratchTimer.current);
      if (scratch.trim()) await saveScratchNotes(id, scratch).catch(() => {});
      await stopRec();
      router.push(`/notes/meeting/${id}`);
    } catch (e) {
      // Error surfaces via the store; still hand off to the detail view.
      router.push(`/notes/meeting/${id}`);
      void e;
    }
  }

  function discard() {
    cancelRec();
    router.push("/notes");
  }

  function onScratchChange(v: string) {
    setScratch(v);
    if (scratchTimer.current) clearTimeout(scratchTimer.current);
    scratchTimer.current = setTimeout(() => {
      void saveScratchNotes(id, v).catch(() => {});
    }, 800);
  }

  const isLive = isThis && (phase === "recording" || phase === "paused");
  const finalizing = isThis && phase === "finalizing";

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-border shrink-0">
        <button
          onClick={() => router.push("/notes")}
          className="p-2 rounded-lg border border-border text-muted-foreground hover:bg-secondary tech-transition"
          aria-label="Back"
          title={isLive ? "Recording keeps running — it'll follow you" : "Back"}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-base sm:text-lg font-bold text-foreground">
            {finalizing ? "Finishing up…" : "New recording"}
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isLive
              ? "Recording — leave this page and it keeps going in the dock."
              : "This conversation is being recorded and transcribed."}
          </p>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-8">
        {error && (
          <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive max-w-md text-center">
            {error}
          </div>
        )}

        {otherActive && (
          <div className="flex flex-col items-center gap-4 text-center max-w-md">
            <div className="w-16 h-16 rounded-full bg-warning/10 flex items-center justify-center">
              <Mic className="w-7 h-7 text-warning" />
            </div>
            <p className="text-sm text-foreground font-semibold">
              Another recording is in progress
            </p>
            <p className="text-xs text-muted-foreground">
              Finish or stop it before starting a new one.
            </p>
            <button
              onClick={() => router.push(`/notes/session/${meetingId}`)}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition"
            >
              Go to the active recording
            </button>
          </div>
        )}

        {!otherActive && !active && (
          <div className="flex flex-col items-center gap-6 text-center max-w-md">
            <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
              <Mic className="w-9 h-9 text-primary" />
            </div>
            <div>
              <p className="text-sm text-foreground font-semibold">
                Ready to record
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                We&apos;ll capture your microphone. For the clearest transcript,
                use a headset in noisy rooms. Nothing is saved until you stop.
              </p>
            </div>
            <button
              onClick={begin}
              className="rounded-full bg-primary w-16 h-16 flex items-center justify-center text-primary-foreground hover:opacity-90 tech-transition tech-glow"
              aria-label="Start recording"
            >
              <span className="w-5 h-5 rounded-full bg-primary-foreground" />
            </button>
          </div>
        )}

        {isLive && (
          <>
            <div className="w-full max-w-2xl h-40">
              <canvas ref={canvasRef} className="w-full h-full" />
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  phase === "recording"
                    ? "bg-destructive animate-pulse"
                    : "bg-warning"
                }`}
              />
              <span className="text-4xl sm:text-5xl font-mono font-bold text-foreground tabular-nums">
                {formatClock(elapsed)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground h-4">
              {phase === "paused"
                ? "Paused"
                : backlog > 0
                  ? `Uploading… ${backlog} chunk${backlog > 1 ? "s" : ""} pending`
                  : "Recording"}
            </p>

            {!liveOff && (captions.length > 0 || interim) && (
              <div className="w-full max-w-2xl">
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  <span className="text-[10px] uppercase tracking-wide text-primary font-semibold">
                    Live captions
                  </span>
                </div>
                <div className="rounded-xl border border-border bg-card p-3 max-h-44 overflow-y-auto space-y-1.5">
                  {captions.slice(-8).map((c, i) => (
                    <p
                      key={i}
                      className="text-sm text-foreground leading-snug"
                    >
                      {c.speaker != null && (
                        <span className="text-primary font-semibold mr-1.5">
                          S{c.speaker + 1}
                        </span>
                      )}
                      {c.text}
                    </p>
                  ))}
                  {interim && (
                    <p className="text-sm text-muted-foreground leading-snug">
                      {interim.speaker != null && (
                        <span className="text-primary/60 font-semibold mr-1.5">
                          S{interim.speaker + 1}
                        </span>
                      )}
                      {interim.text}
                      <span className="inline-block w-1 h-4 bg-primary/70 ml-0.5 align-text-bottom animate-pulse" />
                    </p>
                  )}
                  <div ref={capEndRef} />
                </div>
              </div>
            )}

            <div className="flex items-center gap-4">
              <button
                onClick={() =>
                  phase === "recording" ? pauseRec() : resumeRec()
                }
                className="p-4 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 tech-transition"
                aria-label={phase === "recording" ? "Pause" : "Resume"}
              >
                {phase === "recording" ? (
                  <Pause className="w-6 h-6" />
                ) : (
                  <Play className="w-6 h-6" />
                )}
              </button>
              <button
                onClick={finish}
                className="p-5 rounded-full bg-destructive/15 text-destructive hover:bg-destructive/25 tech-transition"
                aria-label="Stop and transcribe"
              >
                <Square className="w-7 h-7 fill-current" />
              </button>
              <button
                onClick={discard}
                className="p-4 rounded-full border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 tech-transition"
                aria-label="Discard recording"
                title="Discard — throw this recording away"
              >
                <span className="text-xs font-medium px-1">Discard</span>
              </button>
            </div>
            <textarea
              value={scratch}
              onChange={(e) => onScratchChange(e.target.value)}
              placeholder="Jot notes as you go — decisions, owners, follow-ups. The AI merges these into the summary."
              rows={2}
              className="w-full max-w-2xl rounded-xl border border-border bg-card p-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
            />
          </>
        )}

        {finalizing && (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="text-sm">
              Uploading the last audio and starting transcription…
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
