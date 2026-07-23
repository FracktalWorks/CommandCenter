"use client";

/**
 * /notes/session/[id] — the live recording screen (spec §5.1: "studio, not
 * form"). Mic capture → chunked upload; on stop the pipeline transcribes and
 * writes notes, and we hand off to the meeting detail view.
 */

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Mic, Pause, Play, Square } from "lucide-react";
import { MeetingRecorder, type RecorderState } from "../../lib/recorder";
import { formatClock, saveScratchNotes } from "../../lib/api";

const BARS = 48;

export default function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const recorderRef = useRef<MeetingRecorder | null>(null);
  const levelsRef = useRef<number[]>(new Array(BARS).fill(0));
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [phase, setPhase] = useState<"ready" | RecorderState>("ready");
  const [elapsed, setElapsed] = useState(0);
  const [backlog, setBacklog] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [scratch, setScratch] = useState("");
  const scratchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const levels = levelsRef.current;
    for (let i = 0; i < BARS; i++) {
      const lvl = levels[i] ?? 0;
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

  // Redraw loop while active.
  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [phase, draw]);

  useEffect(() => {
    return () => recorderRef.current?.cancel();
  }, []);

  async function begin() {
    setError(null);
    const rec = new MeetingRecorder(id, {
      onState: (s) => setPhase(s),
      onElapsed: (sec) => setElapsed(sec),
      onBacklog: (n) => setBacklog(n),
      onLevel: (lvl) => {
        const arr = levelsRef.current;
        arr.push(lvl);
        if (arr.length > BARS) arr.shift();
      },
      onError: (m) => setError(m),
    });
    recorderRef.current = rec;
    try {
      await rec.start();
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      setError(
        msg.includes("Permission") || msg.toLowerCase().includes("denied")
          ? "Microphone access was denied. Allow the mic in your browser and try again."
          : `Could not start recording: ${msg}`
      );
      setPhase("ready");
    }
  }

  async function finish() {
    try {
      // Flush any pending jot before we hand off to the notes view.
      if (scratchTimer.current) clearTimeout(scratchTimer.current);
      if (scratch.trim()) await saveScratchNotes(id, scratch).catch(() => {});
      await recorderRef.current?.stop();
      router.push(`/notes/meeting/${id}`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  function discard() {
    recorderRef.current?.cancel();
    router.push("/notes");
  }

  function onScratchChange(v: string) {
    setScratch(v);
    if (scratchTimer.current) clearTimeout(scratchTimer.current);
    // Debounced autosave — the jotting shouldn't fire a request per keystroke.
    scratchTimer.current = setTimeout(() => {
      void saveScratchNotes(id, v).catch(() => {});
    }, 800);
  }

  const isLive = phase === "recording" || phase === "paused";

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-border shrink-0">
        <button
          onClick={() => (isLive ? discard() : router.push("/notes"))}
          className="p-2 rounded-lg border border-border text-muted-foreground hover:bg-secondary tech-transition"
          aria-label="Back"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-base sm:text-lg font-bold text-foreground">
            {phase === "finalizing" ? "Finishing up…" : "New recording"}
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            This conversation is being recorded and transcribed.
          </p>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-8">
        {error && (
          <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive max-w-md text-center">
            {error}
          </div>
        )}

        {phase === "ready" && (
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
            <div className="flex items-center gap-4">
              <button
                onClick={() =>
                  phase === "recording"
                    ? recorderRef.current?.pause()
                    : recorderRef.current?.resume()
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

        {phase === "finalizing" && (
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
