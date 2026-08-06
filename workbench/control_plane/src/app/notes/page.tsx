"use client";

/**
 * /notes — the meeting library.
 *
 * Banded by what you'd do about a meeting rather than strictly by date: what's
 * happening now, what's next, what's waiting on you, then the archive. The
 * "needs you" band is the one that earns its keep — unapproved action items
 * used to sit three clicks deep inside a tab, which is where good intentions go
 * to die.
 *
 * Rows report outcomes ("4 actions · 2 waiting for approval") rather than
 * mechanics ("318 segments"). Nobody scans for segment counts.
 *
 * The header carries one primary action. It had grown to six peers — glossary,
 * settings, a template dropdown, Record, Join call, Upload — three of which
 * were the same intent, and a template picker that asked you to classify a
 * meeting before you'd said what it was. Template now lives in prep.
 */

import Icon from "@/components/Icon";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createMeeting, formatClock, listMeetings, uploadRecording } from "./lib/api";
import { bandOf, groupIntoBands, isPrepared, outcomeLine } from "./lib/bands";
import { useViewMode } from "@/components/ViewModeProvider";
import NotesSettingsModal from "./components/NotesSettingsModal";
import GlossaryModal from "./components/GlossaryModal";
import JoinCallModal from "./components/JoinCallModal";
import ActiveBots from "./components/ActiveBots";
import type { MeetingListItem } from "./lib/types";

const STATUS_META: Record<string, { label: string; dot: string; text: string }> = {
  draft: { label: "Draft", dot: "bg-muted", text: "text-muted-foreground" },
  recording: { label: "Recording", dot: "bg-destructive", text: "text-destructive" },
  processing: { label: "Transcribing", dot: "bg-warning", text: "text-warning" },
  ready: { label: "Ready", dot: "bg-success", text: "text-success" },
  failed: { label: "Failed", dot: "bg-destructive", text: "text-destructive" },
};

/** Band accent — colour carries meaning here, consistently with the rest of
 *  the app: red is live, orange asks for a decision, blue is prepared work. */
const BAND_ACCENT: Record<string, string> = {
  live: "text-destructive",
  upcoming: "text-primary",
  needs_you: "text-accent",
  done: "text-muted-foreground",
};

const AVATAR_TONES = [
  "bg-primary/15 text-primary",
  "bg-accent/15 text-accent",
  "bg-success/15 text-success",
  "bg-warning/15 text-warning",
  "bg-destructive/15 text-destructive",
];

function initials(title: string | null): string {
  const t = (title ?? "").trim();
  if (!t) return "··";
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return t.slice(0, 2).toUpperCase();
}

function tone(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

/** Human "when" for a row — a planned time reads differently from a past one. */
function whenLabel(m: MeetingListItem): string {
  const iso = m.scheduled_at ?? m.start_at ?? m.created_at;
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today, ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function NotesPage() {
  const router = useRouter();
  const { isMobile } = useViewMode();
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showGlossary, setShowGlossary] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [botReload, setBotReload] = useState(0);
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
  }, [refresh]);

  // Poll while anything is transcribing or live so the bands stay honest.
  useEffect(() => {
    if (!meetings.some((m) => m.status === "processing" || m.is_live)) return;
    const t = setInterval(() => void refresh(query || undefined), 4000);
    return () => clearInterval(t);
  }, [meetings, query, refresh]);

  async function onFilePicked(file: File) {
    setUploading(true);
    setError(null);
    try {
      const meeting = await createMeeting(file.name.replace(/\.[^.]+$/, ""), "upload");
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
      const meeting = await createMeeting(undefined, "in_person");
      router.push(`/notes/session/${meeting.id}`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [router]);

  // Create a meeting and open it for preparation — the path where you write the
  // agenda and brief the copilot BEFORE anyone is talking.
  const onPrepare = useCallback(async () => {
    setError(null);
    try {
      const meeting = await createMeeting(undefined, "other");
      router.push(`/notes/meeting/${meeting.id}`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [router]);

  // Mobile bottom-nav context tabs (AppShell dispatches these on /notes).
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail;
      if (tab === "notes-record") void onRecord();
      else if (tab === "notes-join") setShowJoin(true);
      else if (tab === "notes-upload") fileInput.current?.click();
      else if (tab === "notes-glossary") setShowGlossary(true);
    };
    window.addEventListener("cc-mobile-nav", handler);
    return () => window.removeEventListener("cc-mobile-nav", handler);
  }, [onRecord]);

  // Dismiss the New-meeting menu on any outside click.
  useEffect(() => {
    if (!showNewMenu) return;
    const close = () => setShowNewMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [showNewMenu]);

  const bands = groupIntoBands(meetings);

  return (
    <div className="flex h-full flex-col">
      <div
        className={`flex shrink-0 gap-3 border-b border-border px-4 py-3 sm:px-6 sm:py-4 ${
          isMobile ? "flex-col" : "flex-row items-center justify-between"
        }`}
      >
        <div className="min-w-0">
          <h1 className="text-base font-bold text-foreground sm:text-lg">Meetings</h1>
          {!isMobile && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Record, prepare, and follow through
            </p>
          )}
        </div>

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

        {/* Mobile: the bottom nav owns Record / Join / Upload / Glossary
            (thumb-reachable), but it has no room for the two considered
            actions — preparing a meeting, and settings. Those get a compact
            header row rather than being unreachable on a phone. */}
        {isMobile && (
          <div className="flex items-center gap-2">
            <button
              onClick={onPrepare}
              className="tech-transition flex-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            >
              <span className="flex items-center justify-center gap-1.5">
                <Icon name="CalendarPlus" className="h-4 w-4" /> New meeting
              </span>
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="tech-transition shrink-0 rounded-lg border border-border p-2 text-muted-foreground"
              aria-label="Note Taker settings"
            >
              <Icon name="Settings2" className="h-4 w-4" />
            </button>
          </div>
        )}

        {!isMobile && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={() => setShowGlossary(true)}
              className="tech-transition shrink-0 rounded-lg border border-border p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="Glossary — teach transcription your jargon"
              aria-label="Glossary"
            >
              <Icon name="BookMarked" className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="tech-transition shrink-0 rounded-lg border border-border p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="Note Taker settings — copilot behaviour, meeting types, defaults"
              aria-label="Note Taker settings"
            >
              <Icon name="Settings2" className="h-4 w-4" />
            </button>

            {/* One primary action. Everything that starts a meeting lives
                behind it, instead of three sibling buttons. */}
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <div className="flex">
                <button
                  onClick={onPrepare}
                  className="tech-transition rounded-l-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                  title="Set up a meeting — agenda, briefing, who's coming — before it starts"
                >
                  <span className="flex items-center gap-1.5">
                    <Icon name="CalendarPlus" className="h-4 w-4" /> New meeting
                  </span>
                </button>
                <button
                  onClick={() => setShowNewMenu((v) => !v)}
                  aria-label="More ways to start"
                  aria-expanded={showNewMenu}
                  className="tech-transition rounded-r-lg border-l border-primary-foreground/20 bg-primary px-2 py-2 text-primary-foreground hover:opacity-90"
                >
                  ▾
                </button>
              </div>
              {showNewMenu && (
                <div className="absolute right-0 z-50 mt-1 w-60 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl">
                  <button
                    onClick={() => {
                      setShowNewMenu(false);
                      void onRecord();
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-secondary"
                  >
                    <Icon name="Mic" className="h-4 w-4 text-muted-foreground" />
                    <span>
                      Record here
                      <span className="block text-[11px] text-muted-foreground">
                        Start capturing straight away
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setShowNewMenu(false);
                      setShowJoin(true);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-secondary"
                  >
                    <Icon name="Video" className="h-4 w-4 text-muted-foreground" />
                    <span>
                      Send a notetaker
                      <span className="block text-[11px] text-muted-foreground">
                        Joins a Meet link for you
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setShowNewMenu(false);
                      fileInput.current?.click();
                    }}
                    disabled={uploading}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-secondary disabled:opacity-60"
                  >
                    {uploading ? (
                      <Icon name="Loader2" className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Icon name="Upload" className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span>
                      {uploading ? "Uploading…" : "Upload a recording"}
                      <span className="block text-[11px] text-muted-foreground">
                        Transcribe something you already have
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-4 py-4 sm:px-6">
          <div className="relative">
            <Icon name="Search" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                void refresh(e.target.value || undefined);
              }}
              placeholder="Search meetings and transcripts…"
              className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <ActiveBots
            reloadSignal={botReload}
            onChange={() => void refresh(query || undefined)}
          />

          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Icon name="Loader2" className="h-5 w-5 animate-spin" />
            </div>
          ) : meetings.length === 0 ? (
            <div className="space-y-3 rounded-xl border border-border bg-card p-8 text-center">
              <Icon name="AudioLines" className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-semibold text-foreground">No meetings yet</p>
              <p className="mx-auto max-w-sm text-xs text-muted-foreground">
                Start with <span className="text-foreground">New meeting</span> to
                write an agenda and brief the copilot before a call — or record,
                send a notetaker, or upload something you already have.
              </p>
            </div>
          ) : (
            bands.map((band) => (
              <section key={band.key}>
                <p
                  className={`mb-2 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide ${
                    BAND_ACCENT[band.key]
                  }`}
                >
                  {band.key === "live" && (
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-70" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
                    </span>
                  )}
                  {band.label}
                  <span className="font-mono text-[10px] opacity-70">
                    {band.items.length}
                  </span>
                </p>
                <div className="space-y-2">
                  {band.items.map((m) => {
                    const s = STATUS_META[m.status] ?? STATUS_META.draft;
                    const outcome = outcomeLine(m);
                    const b = bandOf(m);
                    return (
                      <button
                        key={m.id}
                        onClick={() =>
                          router.push(
                            b === "live"
                              ? `/notes/live/${m.id}`
                              : `/notes/meeting/${m.id}`
                          )
                        }
                        className={`tech-transition w-full rounded-xl border bg-card p-3 text-left hover:bg-secondary/30 sm:p-4 ${
                          b === "live"
                            ? "border-destructive/40 bg-destructive/[0.04]"
                            : b === "needs_you"
                              ? "border-border border-l-[3px] border-l-accent"
                              : "border-border hover:border-primary/40"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[11px] font-bold ${tone(
                              m.id
                            )}`}
                          >
                            {initials(m.title)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-foreground">
                              {m.title || "Untitled meeting"}
                            </p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                              <span>{whenLabel(m)}</span>
                              {m.duration_s != null && (
                                <span className="flex items-center gap-1">
                                  <Icon name="Clock" className="h-3 w-3" />
                                  {formatClock(m.duration_s)}
                                </span>
                              )}
                              {m.segment_count > 0 && (
                                <span className="flex items-center gap-1">
                                  <Icon name="Users" className="h-3 w-3" />
                                  {m.segment_count} segments
                                </span>
                              )}
                              {outcome && (
                                <span
                                  className={
                                    (m.pending_actions ?? 0) > 0
                                      ? "text-accent"
                                      : b === "upcoming" && !isPrepared(m)
                                        ? "text-warning"
                                        : ""
                                  }
                                >
                                  {outcome}
                                </span>
                              )}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {b === "upcoming" ? (
                              <span
                                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                                  isPrepared(m)
                                    ? "border-primary/30 bg-primary/10 text-primary"
                                    : "border-warning/30 bg-warning/10 text-warning"
                                }`}
                              >
                                {isPrepared(m) ? "Prepared" : "Prepare"}
                              </span>
                            ) : (
                              <span
                                className={`flex items-center gap-1.5 text-xs ${s.text}`}
                              >
                                <span
                                  className={`h-1.5 w-1.5 rounded-full ${s.dot} ${
                                    m.status === "processing" ? "animate-pulse" : ""
                                  }`}
                                />
                                {s.label}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      {showSettings && <NotesSettingsModal onClose={() => setShowSettings(false)} />}
      {showGlossary && <GlossaryModal onClose={() => setShowGlossary(false)} />}
      {showJoin && (
        <JoinCallModal
          onClose={() => setShowJoin(false)}
          onJoined={() => {
            setBotReload((n) => n + 1);
            void refresh(query || undefined);
          }}
        />
      )}
    </div>
  );
}
