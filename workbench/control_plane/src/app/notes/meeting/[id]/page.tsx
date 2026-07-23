"use client";

/**
 * /notes/meeting/[id] — meeting detail: transcript ↔ notes, action items,
 * live SSE pipeline progress (spec: note_taker_app.md §5.3/§5.4). Slice 1 adds
 * generated notes + draft action items on top of slice 0's transcript view.
 */

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  CheckSquare,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import MarkdownMessage from "@/components/MarkdownMessage";
import {
  approveAction,
  approveAllActions,
  audioUrl,
  deleteMeeting,
  eventsUrl,
  formatClock,
  getMeeting,
  getNote,
  listActions,
  rejectAction,
  summarize,
} from "../../lib/api";
import type { ActionItem, MeetingDetail, MeetingEvent } from "../../lib/types";

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
  const [notesMd, setNotesMd] = useState<string | null>(null);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [progress, setProgress] = useState<MeetingEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [actioning, setActioning] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [m, note, acts] = await Promise.all([
        getMeeting(id),
        getNote(id).catch(() => null),
        listActions(id).catch(() => []),
      ]);
      setMeeting(m);
      setNotesMd(note?.notes_md ?? m.summary_md ?? null);
      setActions(acts);
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live pipeline progress over SSE. On every state change (and on terminal),
  // refetch the detail so transcript/notes/actions stay in step.
  useEffect(() => {
    const es = new EventSource(eventsUrl(id));
    es.onmessage = (ev) => {
      try {
        const snap = JSON.parse(ev.data) as MeetingEvent;
        setProgress(snap);
        void refresh();
      } catch {
        /* heartbeat / comment frame */
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [id, refresh]);

  async function onSummarize() {
    setSummarizing(true);
    try {
      await summarize(id);
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSummarizing(false);
    }
  }

  function seekTo(s: number) {
    if (audioRef.current) {
      audioRef.current.currentTime = s;
      void audioRef.current.play();
    }
  }

  function flashToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  async function onApprove(actionId: string) {
    setActioning(actionId);
    try {
      await approveAction(actionId);
      await refresh();
      flashToast("Task created — view in Tasks");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setActioning(null);
    }
  }

  async function onReject(actionId: string) {
    setActioning(actionId);
    try {
      await rejectAction(actionId);
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setActioning(null);
    }
  }

  async function onApproveAll() {
    setActioning("all");
    try {
      const { created } = await approveAllActions(id, 0.8);
      await refresh();
      flashToast(
        created.length
          ? `${created.length} task${created.length > 1 ? "s" : ""} created — view in Tasks`
          : "No draft items at 80%+ confidence"
      );
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setActioning(null);
    }
  }

  const summaryRun = meeting?.runs.find((r) => r.kind === "summary");
  const transcribeRun = meeting?.runs.find((r) => r.kind === "transcribe");
  const busy =
    meeting?.status === "processing" ||
    progress?.runs.some((r) => r.status === "queued" || r.status === "running");

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
              {busy
                ? "Processing…"
                : meeting?.transcript_source
                  ? `Transcribed by ${meeting.transcript_source}`
                  : "Meeting detail"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {meeting && meeting.segments.length > 0 && (
            <button
              onClick={onSummarize}
              disabled={summarizing || busy}
              className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition disabled:opacity-60"
            >
              <span className="flex items-center gap-1.5">
                {summarizing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : notesMd ? (
                  <RefreshCw className="w-4 h-4" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                {notesMd ? "Regenerate" : "Generate notes"}
              </span>
            </button>
          )}
          {meeting && (
            <button
              onClick={async () => {
                if (!confirm("Delete this meeting, its audio and transcript?"))
                  return;
                await deleteMeeting(id);
                router.push("/notes");
              }}
              className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive hover:bg-destructive/20 tech-transition"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 space-y-4">
          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {toast && (
            <div className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success flex items-center gap-2">
              <Check className="w-4 h-4" />
              {toast}
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

          {busy && (
            <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin text-warning" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  {progress?.runs.find((r) => r.status === "running")?.kind ===
                  "summary"
                    ? "Writing notes…"
                    : "Transcribing…"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {(() => {
                    const run = progress?.runs.find(
                      (r) => r.status === "running"
                    );
                    if (run?.chunk_total && run.chunk_total > 1)
                      return `${run.stage ?? "working"} — chunk ${run.chunk_done}/${run.chunk_total}`;
                    return run?.stage ?? "queued";
                  })()}{" "}
                  — updates live.
                </p>
              </div>
            </div>
          )}

          {meeting?.status === "failed" && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4">
              <p className="text-sm font-semibold text-destructive">
                Pipeline failed
              </p>
              <p className="text-xs text-muted-foreground mt-1 font-mono break-all">
                {summaryRun?.error ??
                  transcribeRun?.error ??
                  "No error detail recorded."}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Transcript */}
            <div>
              <h2 className="text-sm font-semibold text-foreground mb-2">
                Transcript
              </h2>
              {meeting && meeting.segments.length > 0 ? (
                <div className="rounded-xl border border-border bg-card divide-y divide-border max-h-[70vh] overflow-y-auto">
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
              ) : (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  {busy ? "Transcript is being generated…" : "No transcript."}
                </p>
              )}
            </div>

            {/* Notes + action items */}
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground mb-2">
                  Notes
                </h2>
                {notesMd ? (
                  <div className="rounded-xl border border-border bg-card p-4 max-h-[70vh] overflow-y-auto text-sm">
                    <MarkdownMessage content={notesMd} />
                  </div>
                ) : (
                  <div className="rounded-xl border border-border bg-card p-6 text-center">
                    <Sparkles className="w-6 h-6 mx-auto text-muted-foreground mb-2" />
                    <p className="text-xs text-muted-foreground">
                      {busy
                        ? "Notes will appear once the transcript is ready."
                        : meeting?.segments.length
                          ? "Click “Generate notes” to summarize this meeting."
                          : "Notes appear after transcription."}
                    </p>
                  </div>
                )}
              </div>

              {actions.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                      <CheckSquare className="w-4 h-4" />
                      Action items
                    </h2>
                    {actions.some(
                      (a) => a.status === "draft" && a.confidence >= 0.8
                    ) && (
                      <button
                        onClick={onApproveAll}
                        disabled={actioning !== null}
                        className="text-[11px] rounded-md border border-border px-2 py-1 text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition disabled:opacity-60"
                      >
                        Approve all ≥80%
                      </button>
                    )}
                  </div>
                  <div className="space-y-2">
                    {actions.map((a) => {
                      const busy = actioning === a.id || actioning === "all";
                      return (
                        <div
                          key={a.id}
                          className={`rounded-lg border p-3 tech-transition ${
                            a.status === "created"
                              ? "border-success/30 bg-success/5"
                              : a.status === "rejected"
                                ? "border-border bg-card opacity-50"
                                : "border-border bg-card"
                          }`}
                        >
                          <p
                            className={`text-sm ${a.status === "rejected" ? "line-through text-muted-foreground" : "text-foreground"}`}
                          >
                            {a.description}
                          </p>
                          <div className="flex items-center gap-2 mt-1.5">
                            <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full bg-primary"
                                style={{
                                  width: `${Math.round(a.confidence * 100)}%`,
                                }}
                              />
                            </div>
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {Math.round(a.confidence * 100)}%
                            </span>
                            {a.due_hint && (
                              <span className="text-[10px] text-warning shrink-0">
                                {a.due_hint}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-2">
                            {a.status === "draft" && (
                              <>
                                <button
                                  onClick={() => onApprove(a.id)}
                                  disabled={busy}
                                  className="flex-1 flex items-center justify-center gap-1 rounded-md bg-primary/10 text-primary px-2 py-1 text-xs hover:bg-primary/20 tech-transition disabled:opacity-60"
                                >
                                  {busy ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Check className="w-3.5 h-3.5" />
                                  )}
                                  Approve → Task
                                </button>
                                <button
                                  onClick={() => onReject(a.id)}
                                  disabled={busy}
                                  className="flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-destructive hover:border-destructive/30 tech-transition disabled:opacity-60"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                            {a.status === "created" && (
                              <Link
                                href={
                                  a.resulting_task_id
                                    ? `/tasks?item=${a.resulting_task_id}`
                                    : "/tasks"
                                }
                                className="flex items-center gap-1 text-xs text-success hover:underline"
                              >
                                <Check className="w-3.5 h-3.5" /> In Tasks
                                <ExternalLink className="w-3 h-3" />
                              </Link>
                            )}
                            {a.status === "rejected" && (
                              <span className="text-xs text-muted-foreground">
                                Rejected
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
