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
  Clock,
  ExternalLink,
  Loader2,
  Mail,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import MarkdownMessage from "@/components/MarkdownMessage";
import AskPanel from "../../components/AskPanel";
import FollowupEmailModal from "../../components/FollowupEmailModal";
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
  listTemplates,
  rejectAction,
  saveAttendees,
  saveScratchNotes,
  saveSpeakerNames,
  setMeetingTemplate,
  summarize,
} from "../../lib/api";
import type {
  ActionItem,
  Attendee,
  MeetingDetail,
  MeetingEvent,
} from "../../lib/types";

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

const SPEAKER_AV = [
  "bg-primary/15 text-primary",
  "bg-accent/15 text-accent",
  "bg-success/15 text-success",
  "bg-warning/15 text-warning",
  "bg-destructive/15 text-destructive",
];

function speakerAv(label: string | null): string {
  if (!label) return "bg-muted text-muted-foreground";
  const n = parseInt(label.replace(/\D/g, ""), 10);
  return SPEAKER_AV[(isNaN(n) ? 0 : n - 1) % SPEAKER_AV.length];
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
  const [showEmail, setShowEmail] = useState(false);
  const [addName, setAddName] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [scratch, setScratch] = useState("");
  const [tab, setTab] = useState<"summary" | "transcript" | "actions" | "ask">(
    "summary"
  );
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [savingSpeaker, setSavingSpeaker] = useState(false);
  const [templates, setTemplates] = useState<{ key: string; label: string }[]>([]);
  const scratchLoaded = useRef(false);
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
      // Seed the scratch editor once, then leave the user's live edits alone.
      if (!scratchLoaded.current) {
        setScratch(m.scratch_notes ?? "");
        scratchLoaded.current = true;
      }
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    listTemplates()
      .then(setTemplates)
      .catch(() => {});
  }, []);

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

  // Switch the notes template and regenerate through the new lens.
  async function onPickTemplate(key: string) {
    if (!meeting || key === (meeting.template_key ?? "standard_meeting")) return;
    setMeeting({ ...meeting, template_key: key });
    setSummarizing(true);
    try {
      await setMeetingTemplate(id, key);
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

  function jumpToSegment(segmentId: string) {
    // A citation can be clicked from any tab — switch to the transcript first,
    // then scroll once the panel has mounted.
    setTab("transcript");
    setTimeout(() => {
      const seg = meeting?.segments.find((x) => x.id === segmentId);
      const el = document.getElementById(`seg-${segmentId}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (el) {
        el.classList.add("ring-1", "ring-primary");
        setTimeout(() => el.classList.remove("ring-1", "ring-primary"), 1600);
      }
      if (seg) seekTo(seg.start_s);
    }, 60);
  }

  function flashToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  async function persistAttendees(next: Attendee[]) {
    if (!meeting) return;
    setMeeting({ ...meeting, attendees: next });
    try {
      await saveAttendees(id, next);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      await refresh();
    }
  }

  function addAttendee() {
    const name = addName.trim();
    const email = addEmail.trim();
    if (!name && !email) return;
    void persistAttendees([...(meeting?.attendees ?? []), { name, email }]);
    setAddName("");
    setAddEmail("");
  }

  const speakerNames = meeting?.speaker_names ?? {};
  function displayName(label: string | null): string {
    if (!label) return "";
    return speakerNames[label] || label;
  }
  function initials(s: string): string {
    const p = s.trim().split(/\s+/).filter(Boolean);
    if (p.length >= 2) return (p[0][0] + p[1][0]).toUpperCase();
    return (s.trim().slice(0, 2) || "?").toUpperCase();
  }
  function openRename(label: string) {
    setEditingSpeaker(label);
    setNameDraft(speakerNames[label] ?? "");
  }
  async function saveSpeaker() {
    if (!editingSpeaker || !meeting) return;
    const label = editingSpeaker;
    const name = nameDraft.trim();
    setSavingSpeaker(true);
    try {
      const next: Record<string, string> = { ...speakerNames };
      if (name) next[label] = name;
      else delete next[label];
      const saved = await saveSpeakerNames(id, next);
      setMeeting({ ...meeting, speaker_names: saved });
      setEditingSpeaker(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSavingSpeaker(false);
    }
  }

  // Distinct diarized speakers present in the transcript.
  const speakerLabels = Array.from(
    new Set(
      (meeting?.segments ?? [])
        .map((s) => s.speaker_label)
        .filter((x): x is string => !!x)
    )
  );
  const chipCls =
    "inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground";

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
          {notesMd && (
            <button
              onClick={() => setShowEmail(true)}
              className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition"
            >
              <span className="flex items-center gap-1.5">
                <Mail className="w-4 h-4" /> Follow-up
              </span>
            </button>
          )}
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

          {/* At-a-glance meta strip */}
          {meeting && (meeting.duration_s != null || meeting.transcript_source) && (
            <div className="flex flex-wrap items-center gap-2">
              {meeting.created_at && (
                <span className={chipCls}>
                  {new Date(meeting.created_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              )}
              {meeting.duration_s != null && (
                <span className={chipCls}>
                  <Clock className="w-3 h-3" />
                  {formatClock(meeting.duration_s)}
                </span>
              )}
              {speakerLabels.length > 0 && (
                <span className={chipCls}>
                  <Users className="w-3 h-3" />
                  {speakerLabels.length} speaker
                  {speakerLabels.length > 1 ? "s" : ""}
                </span>
              )}
              {meeting.language && (
                <span className={`${chipCls} capitalize`}>{meeting.language}</span>
              )}
              {meeting.transcript_source && (
                <span className={`${chipCls} font-mono !text-[10px] text-muted-foreground`}>
                  {meeting.transcript_source}
                </span>
              )}
            </div>
          )}

          {meeting && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Attendees
              </span>
              {meeting.attendees.map((a, i) => (
                <span
                  key={`${a.email}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-1 text-xs text-foreground"
                  title={a.email}
                >
                  {a.name || a.email}
                  <button
                    onClick={() =>
                      persistAttendees(
                        meeting.attendees.filter((_, j) => j !== i)
                      )
                    }
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remove attendee"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <span className="inline-flex items-center gap-1">
                <input
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="Name"
                  className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <input
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addAttendee()}
                  placeholder="email@…"
                  className="w-32 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  onClick={addAttendee}
                  className="p-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition"
                  aria-label="Add attendee"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </span>
            </div>
          )}

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

          {/* Tabbed workspace — the summary is the hero */}
          <div className="flex items-center gap-1 border-b border-border overflow-x-auto">
            {(
              [
                ["summary", "Summary"],
                ["transcript", "Transcript"],
                ["actions", "Actions"],
                ["ask", "Ask"],
              ] as const
            ).map(([tid, label]) => (
              <button
                key={tid}
                onClick={() => setTab(tid)}
                className={`relative px-3 py-2 text-sm whitespace-nowrap tech-transition ${
                  tab === tid
                    ? "text-primary font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  {label}
                  {tid === "actions" && actions.length > 0 && (
                    <span className="text-[10px] rounded-full bg-secondary px-1.5 py-0.5 text-muted-foreground">
                      {actions.length}
                    </span>
                  )}
                </span>
                {tab === tid && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
                )}
              </button>
            ))}
          </div>

          <div className="pt-4">
            {/* Transcript */}
            {tab === "transcript" && (
            <div>
              {speakerLabels.length > 0 &&
                !speakerLabels.every((l) => speakerNames[l]) && (
                  <p className="text-[11px] text-muted-foreground mb-2">
                    {speakerLabels.length} speaker
                    {speakerLabels.length > 1 ? "s" : ""} — click a name to label
                    them.
                  </p>
                )}
              {meeting && meeting.segments.length > 0 ? (
                <div className="rounded-xl border border-border bg-card divide-y divide-border max-h-[70vh] overflow-y-auto">
                  {meeting.segments.map((seg) => (
                    <div
                      key={seg.id}
                      id={`seg-${seg.id}`}
                      className="flex gap-3 px-4 py-2.5 rounded-lg tech-transition"
                    >
                      <button
                        onClick={() => seekTo(seg.start_s)}
                        className="shrink-0 flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-primary tech-transition mt-0.5"
                        title="Play from here"
                      >
                        <Play className="w-3 h-3" />
                        {formatClock(seg.start_s)}
                      </button>
                      <div className="min-w-0">
                        {seg.speaker_label ? (
                          <button
                            onClick={() => openRename(seg.speaker_label!)}
                            className="group inline-flex items-center gap-1.5 mb-0.5"
                            title="Click to name this speaker"
                          >
                            <span
                              className={`w-4 h-4 rounded-full grid place-items-center text-[8px] font-bold ${speakerAv(seg.speaker_label)}`}
                            >
                              {initials(displayName(seg.speaker_label))}
                            </span>
                            <span
                              className={`text-[10px] font-semibold uppercase tracking-wide ${speakerColor(seg.speaker_label)}`}
                            >
                              {displayName(seg.speaker_label)}
                            </span>
                            <Pencil className="w-2.5 h-2.5 text-muted-foreground opacity-0 group-hover:opacity-100 tech-transition" />
                          </button>
                        ) : seg.channel ? (
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {seg.channel === "mic" ? "You" : seg.channel}
                          </span>
                        ) : null}
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
            )}

            {/* Summary — the generated notes (hero) + your steering notes */}
            {tab === "summary" && (
            <div className="max-w-3xl space-y-4">
              {meeting && meeting.segments.length > 0 && templates.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground">
                    Notes template
                  </span>
                  <select
                    value={meeting.template_key ?? "standard_meeting"}
                    onChange={(e) => void onPickTemplate(e.target.value)}
                    disabled={summarizing || busy}
                    className="rounded-lg border border-border bg-card px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
                  >
                    {templates.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  {notesMd && (
                    <span className="text-[10px] text-muted-foreground">
                      changing regenerates the notes
                    </span>
                  )}
                </div>
              )}
              <div>
                <h2 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
                  Your notes
                  <span className="text-[10px] text-muted-foreground font-normal">
                    (merged into the summary as emphasis)
                  </span>
                </h2>
                <textarea
                  value={scratch}
                  onChange={(e) => setScratch(e.target.value)}
                  onBlur={() => void saveScratchNotes(id, scratch).catch(() => {})}
                  placeholder="Jot the points that matter — decisions, who owns what, things to follow up. The AI will expand these from the transcript when you generate notes."
                  rows={3}
                  className="w-full rounded-xl border border-border bg-card p-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                />
              </div>
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
            </div>
            )}

            {/* Actions */}
            {tab === "actions" &&
              (actions.length > 0 ? (
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
              ) : (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  {busy
                    ? "Action items appear once notes are generated."
                    : "No action items yet."}
                </p>
              ))}

            {/* Ask the meeting */}
            {tab === "ask" &&
              (meeting && meeting.segments.length > 0 ? (
                <AskPanel meetingId={id} onCite={jumpToSegment} />
              ) : (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  Ask becomes available once there&apos;s a transcript.
                </p>
              ))}
          </div>
        </div>
      </div>

      {showEmail && (
        <FollowupEmailModal
          meetingId={id}
          onClose={() => setShowEmail(false)}
          onSent={(msg) => {
            setShowEmail(false);
            flashToast(msg);
          }}
        />
      )}

      {editingSpeaker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
          onClick={() => setEditingSpeaker(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-border bg-card shadow-xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-6 h-6 rounded-full grid place-items-center text-[10px] font-bold ${speakerAv(editingSpeaker)}`}
              >
                {initials(displayName(editingSpeaker))}
              </span>
              <h2 className="text-sm font-semibold text-foreground">
                Name this speaker
              </h2>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Renames{" "}
              <span className="font-mono text-foreground">{editingSpeaker}</span>{" "}
              across the transcript, notes, action owners &amp; the follow-up
              email. Regenerate notes to apply names there.
            </p>
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveSpeaker()}
              placeholder="e.g. Alex Rivera"
              className="w-full mt-3 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {meeting && meeting.attendees.some((a) => a.name.trim()) && (
              <div className="mt-2">
                <p className="text-[10px] text-muted-foreground mb-1">
                  From attendees
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {meeting.attendees
                    .filter((a) => a.name.trim())
                    .map((a, i) => (
                      <button
                        key={`${a.name}-${i}`}
                        onClick={() => setNameDraft(a.name)}
                        className="rounded-full bg-secondary px-2.5 py-1 text-xs text-foreground hover:bg-primary/10 hover:text-primary tech-transition"
                      >
                        {a.name}
                      </button>
                    ))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 mt-4">
              <button
                onClick={() => void saveSpeaker()}
                disabled={savingSpeaker}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 tech-transition"
              >
                {savingSpeaker ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                Save
              </button>
              {speakerNames[editingSpeaker] && (
                <button
                  onClick={() => {
                    setNameDraft("");
                    void saveSpeaker();
                  }}
                  disabled={savingSpeaker}
                  className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:text-destructive hover:border-destructive/30 tech-transition disabled:opacity-50"
                >
                  Clear name
                </button>
              )}
              <button
                onClick={() => setEditingSpeaker(null)}
                className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground tech-transition ml-auto"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
