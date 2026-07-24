"use client";

/**
 * /notes — AI Note Taker library (slice 0: upload → transcribe → segments).
 * Spec: ai-company-brain/specs/note_taker_app.md §3.8 / §6. The live browser
 * recorder (session screen + recording dock) lands in slice 1; this shell
 * ships the retro-import path and the meeting library.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AudioLines,
  BookMarked,
  Clock,
  FileAudio,
  Loader2,
  Mic,
  Search,
  Upload,
  Users,
} from "lucide-react";
import {
  createMeeting,
  formatClock,
  listMeetings,
  listTemplates,
  uploadRecording,
} from "./lib/api";
import { useViewMode } from "@/components/ViewModeProvider";
import GlossaryModal from "./components/GlossaryModal";
import type { MeetingListItem, NoteTemplate } from "./lib/types";

const STATUS_META: Record<
  string,
  { label: string; dot: string; text: string }
> = {
  draft: { label: "Draft", dot: "bg-muted", text: "text-muted-foreground" },
  recording: { label: "Recording", dot: "bg-destructive", text: "text-destructive" },
  processing: { label: "Transcribing", dot: "bg-warning", text: "text-warning" },
  ready: { label: "Ready", dot: "bg-success", text: "text-success" },
  failed: { label: "Failed", dot: "bg-destructive", text: "text-destructive" },
};

export default function NotesPage() {
  const router = useRouter();
  const { isMobile } = useViewMode();
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showGlossary, setShowGlossary] = useState(false);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [templateKey, setTemplateKey] = useState("standard_meeting");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (q?: string) => {
    try {
      setMeetings(await listMeetings(q));
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void listTemplates()
      .then(setTemplates)
      .catch(() => {}); // picker is optional; creation defaults to standard
  }, [refresh]);

  // Poll while anything is still transcribing so statuses stay live.
  useEffect(() => {
    if (!meetings.some((m) => m.status === "processing")) return;
    const t = setInterval(() => void refresh(query || undefined), 4000);
    return () => clearInterval(t);
  }, [meetings, query, refresh]);

  async function onFilePicked(file: File) {
    setUploading(true);
    setError(null);
    try {
      const meeting = await createMeeting(
        file.name.replace(/\.[^.]+$/, ""),
        "upload",
        templateKey
      );
      await uploadRecording(meeting.id, file);
      router.push(`/notes/meeting/${meeting.id}`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setUploading(false);
    }
  }

  const onRecord = useCallback(async () => {
    setError(null);
    try {
      const meeting = await createMeeting(undefined, "in_person", templateKey);
      router.push(`/notes/session/${meeting.id}`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [router, templateKey]);

  // Mobile bottom-nav context tabs (AppShell dispatches these on /notes).
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail;
      if (tab === "notes-record") void onRecord();
      else if (tab === "notes-upload") fileInput.current?.click();
      else if (tab === "notes-glossary") setShowGlossary(true);
    };
    window.addEventListener("cc-mobile-nav", handler);
    return () => window.removeEventListener("cc-mobile-nav", handler);
  }, [onRecord]);

  return (
    <div className="flex flex-col h-full">
      <div
        className={`flex px-4 sm:px-6 py-3 sm:py-4 border-b border-border shrink-0 gap-3 ${
          isMobile ? "flex-col" : "flex-row items-center justify-between"
        }`}
      >
        <div className="min-w-0">
          <h1 className="text-base sm:text-lg font-bold text-foreground">Notes</h1>
          {!isMobile && (
            <p className="text-xs text-muted-foreground mt-0.5">
              AI note taker — record meetings, get grounded notes
            </p>
          )}
        </div>

        {/* The hidden file input is triggered by the desktop Upload button AND
            the mobile bottom-nav Upload tab — keep it outside the clusters so
            it's always in the DOM. */}
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,.webm,.m4a,.mp4"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFilePicked(f);
            e.target.value = "";
          }}
        />

        {/* Mobile: only the template picker — Record / Upload / Glossary are in
            the bottom nav (thumb-reachable), so the header stays uncluttered. */}
        {isMobile && templates.length > 0 && (
          <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
            <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Template
            </span>
            <select
              value={templateKey}
              onChange={(e) => setTemplateKey(e.target.value)}
              aria-label="Notes template"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground focus:outline-none"
            >
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Desktop: the full action cluster (no bottom nav on desktop). */}
        {!isMobile && (
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={() => setShowGlossary(true)}
            className="shrink-0 p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition"
            title="Glossary — teach transcription your jargon"
            aria-label="Glossary"
          >
            <BookMarked className="w-4 h-4" />
          </button>
          {templates.length > 0 && (
            <select
              value={templateKey}
              onChange={(e) => setTemplateKey(e.target.value)}
              title="Notes template — shapes the summary for this meeting type"
              aria-label="Notes template"
              className="rounded-lg border border-border bg-card px-2 py-2 text-sm text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring tech-transition"
            >
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={onRecord}
            className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition"
          >
            <span className="flex items-center gap-1.5">
              <Mic className="w-4 h-4" /> Record
            </span>
          </button>
          <button
            className="shrink-0 rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition disabled:opacity-60"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
          >
            <span className="flex items-center gap-1.5">
              {uploading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {uploading ? "Uploading…" : "Upload"}
            </span>
          </button>
        </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-3">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                void refresh(e.target.value || undefined);
              }}
              placeholder="Search meetings and transcripts…"
              className="w-full rounded-lg border border-border bg-card pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : meetings.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center space-y-3">
              <AudioLines className="w-8 h-8 mx-auto text-muted-foreground" />
              <p className="text-sm font-semibold text-foreground">
                No meetings yet
              </p>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                Upload a recording of a conversation and the note taker will
                transcribe it and (soon) turn it into grounded meeting notes,
                tasks, and follow-ups. Live in-browser recording is next.
              </p>
            </div>
          ) : (
            meetings.map((m) => {
              const s = STATUS_META[m.status] ?? STATUS_META.draft;
              return (
                <button
                  key={m.id}
                  onClick={() => router.push(`/notes/meeting/${m.id}`)}
                  className="text-left w-full p-3 sm:p-4 rounded-xl border border-border bg-card hover:border-primary/40 hover:bg-secondary/30 tech-transition"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <FileAudio className="w-5 h-5 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {m.title || "Untitled meeting"}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
                          {m.created_at && (
                            <span>
                              {new Date(m.created_at).toLocaleString()}
                            </span>
                          )}
                          {m.duration_s != null && (
                            <span className="flex items-center gap-0.5">
                              <Clock className="w-3 h-3" />
                              {formatClock(m.duration_s)}
                            </span>
                          )}
                          {m.segment_count > 0 && (
                            <span className="flex items-center gap-0.5">
                              <Users className="w-3 h-3" />
                              {m.segment_count} segments
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`flex items-center gap-1.5 text-xs shrink-0 ${s.text}`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${s.dot} ${
                          m.status === "processing" ? "animate-pulse" : ""
                        }`}
                      />
                      {s.label}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {showGlossary && <GlossaryModal onClose={() => setShowGlossary(false)} />}
    </div>
  );
}
