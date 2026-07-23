"use client";

/**
 * /notes/meeting/[id] — meeting detail (slice 0: transcript segments + audio).
 * The two-pane transcript↔notes canvas with grounding highlights arrives with
 * notes generation (spec §5.3); this view proves the pipeline end-to-end.
 */

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Play, Trash2 } from "lucide-react";
import { audioUrl, deleteMeeting, formatClock, getMeeting } from "../../lib/api";
import type { MeetingDetail } from "../../lib/types";

const SPEAKER_COLORS = [
  "text-primary",
  "text-accent",
  "text-success",
  "text-warning",
  "text-destructive",
];

function speakerColor(label: string | null): string {
  if (!label) return "text-muted-foreground";
  const n = parseInt(label.replace(/\D/g, ""), 10);
  return SPEAKER_COLORS[(isNaN(n) ? 0 : n - 1) % SPEAKER_COLORS.length];
}

export default function MeetingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const refresh = useCallback(async () => {
    try {
      setMeeting(await getMeeting(id));
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while the pipeline is running.
  useEffect(() => {
    if (meeting?.status !== "processing") return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [meeting?.status, refresh]);

  const transcribeRun = meeting?.runs.find((r) => r.kind === "transcribe");

  function seekTo(s: number) {
    if (audioRef.current) {
      audioRef.current.currentTime = s;
      void audioRef.current.play();
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => router.push("/notes")}
            className="p-2 rounded-lg border border-border text-muted-foreground hover:bg-secondary tech-transition"
            aria-label="Back to notes"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-bold text-foreground truncate">
              {meeting?.title || "Untitled meeting"}
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {meeting?.status === "processing"
                ? "Transcribing…"
                : meeting?.transcript_source
                  ? `Transcribed by ${meeting.transcript_source}`
                  : "Meeting detail"}
            </p>
          </div>
        </div>
        {meeting && (
          <button
            onClick={async () => {
              if (!confirm("Delete this meeting, its audio and transcript?")) return;
              await deleteMeeting(id);
              router.push("/notes");
            }}
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive hover:bg-destructive/20 tech-transition"
          >
            <span className="flex items-center gap-1.5">
              <Trash2 className="w-4 h-4" /> Delete
            </span>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-4">
          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {meeting?.recordings.length ? (
            <audio
              ref={audioRef}
              controls
              preload="metadata"
              src={audioUrl(id)}
              className="w-full"
            />
          ) : null}

          {meeting?.status === "processing" && (
            <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin text-warning" />
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Transcribing recording…
                </p>
                <p className="text-xs text-muted-foreground">
                  {transcribeRun?.stage
                    ? `Stage: ${transcribeRun.stage}`
                    : "Queued"}{" "}
                  — this view refreshes automatically.
                </p>
              </div>
            </div>
          )}

          {meeting?.status === "failed" && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4">
              <p className="text-sm font-semibold text-destructive">
                Transcription failed
              </p>
              <p className="text-xs text-muted-foreground mt-1 font-mono break-all">
                {transcribeRun?.error ?? "No error detail recorded."}
              </p>
            </div>
          )}

          {meeting && meeting.segments.length > 0 && (
            <div className="rounded-xl border border-border bg-card divide-y divide-border">
              {meeting.segments.map((seg) => (
                <div key={seg.id} className="flex gap-3 px-4 py-2.5">
                  <button
                    onClick={() => seekTo(seg.start_s)}
                    className="shrink-0 flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-primary tech-transition mt-0.5"
                    title="Play from here"
                  >
                    <Play className="w-3 h-3" />
                    {formatClock(seg.start_s)}
                  </button>
                  <div className="min-w-0">
                    {(seg.speaker_label || seg.channel) && (
                      <span
                        className={`text-[10px] font-semibold uppercase tracking-wide ${speakerColor(seg.speaker_label)}`}
                      >
                        {seg.speaker_label ??
                          (seg.channel === "mic" ? "You" : seg.channel)}
                      </span>
                    )}
                    <p className="text-sm text-foreground">{seg.text}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {meeting &&
            meeting.status === "ready" &&
            meeting.segments.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                Transcription finished but produced no segments (silent audio?).
              </p>
            )}
        </div>
      </div>
    </div>
  );
}
