/** Thin client over /api/notes/* (the Next proxy to the gateway /notes API). */

import type {
  ActionItem,
  AgendaItem,
  AgendaProgress,
  Attendee,
  BotDiagnostics,
  EmailAccount,
  EmailDraft,
  LiveSession,
  LiveSpeaker,
  MeetingContext,
  MeetingBot,
  MeetingDetail,
  MeetingListItem,
  NoteDoc,
  NotesSettings,
  NotesSettingsPayload,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      detail = body?.detail ?? body?.error ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(String(detail));
  }
  return (await res.json()) as T;
}

/**
 * Relay one finalized live caption to the server-side live bus.
 *
 * Makes the in-browser recorder a producer on the SAME bus as the meeting bot,
 * so the live transcript (and anything consuming it — the roster, and later the
 * copilot) works for on-page recordings too, with no extra infrastructure.
 * Deliberately best-effort: live is a draft, the batch re-pass on stop is
 * authoritative, so a dropped relay must never disturb the recording.
 */
export async function postLiveSegment(
  meetingId: string,
  seg: {
    text: string;
    start_s: number;
    end_s: number;
    speaker_label: string | null;
  }
): Promise<void> {
  try {
    await fetch(`/api/notes/meetings/${meetingId}/live/browser-segment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...seg, is_final: true }),
      keepalive: true,
    });
  } catch {
    /* best-effort: never let a live relay disturb the recording */
  }
}

/** Everything configurable about the Note Taker, plus the meeting-type
 *  catalogue so the UI can show shipped defaults next to any overrides. */
export async function getNotesSettings(): Promise<NotesSettingsPayload> {
  return json(await fetch("/api/notes/settings", { cache: "no-store" }));
}

export async function saveNotesSettings(
  settings: NotesSettings
): Promise<{ settings: NotesSettings }> {
  return json(
    await fetch("/api/notes/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    })
  );
}

/** The meeting's agenda — what the copilot measures the conversation against. */
export async function getAgenda(meetingId: string): Promise<AgendaItem[]> {
  const body = await json<{ agenda: AgendaItem[] }>(
    await fetch(`/api/notes/meetings/${meetingId}/agenda`, { cache: "no-store" })
  );
  return body.agenda ?? [];
}

/** Per-item agenda coverage. Free server-side (token overlap, no model call),
 *  and independent of the copilot — "you haven't reached pricing yet" is worth
 *  knowing whether or not an agent is listening. */
export async function getAgendaProgress(
  meetingId: string
): Promise<AgendaProgress> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/agenda/progress`, {
      cache: "no-store",
    })
  );
}

/** Talk to the copilot to build the agenda; it replies and returns the full
 *  updated agenda (never a diff), which is saved server-side. */
export async function chatAgenda(
  meetingId: string,
  message: string
): Promise<{ reply: string; agenda: AgendaItem[] }> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/agenda/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    })
  );
}

export async function saveAgenda(
  meetingId: string,
  agenda: AgendaItem[]
): Promise<{ agenda: AgendaItem[] }> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/agenda`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agenda }),
    })
  );
}

/** Standing instructions prepended to EVERY copilot run — set once. */
export async function getCopilotInstructions(): Promise<string> {
  const body = await json<{ instructions: string }>(
    await fetch("/api/notes/copilot/instructions", { cache: "no-store" })
  );
  return body.instructions ?? "";
}

export async function saveCopilotInstructions(
  instructions: string
): Promise<{ instructions: string }> {
  return json(
    await fetch("/api/notes/copilot/instructions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions }),
    })
  );
}

/** What the copilot knows about this meeting (brief + history + systems). */
export async function getMeetingContext(
  meetingId: string
): Promise<MeetingContext> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/context`, { cache: "no-store" })
  );
}

/** Set the meeting briefing — the context only the human has. */
export async function setMeetingBrief(
  meetingId: string,
  brief: string
): Promise<{ brief: string }> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/brief`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief }),
    })
  );
}

/** Opt this session into asking the business agents (CRM, tasks) for background. */
export async function setDeepContext(
  meetingId: string,
  enabled: boolean
): Promise<{ deep_context: boolean }> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/context/deep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    })
  );
}

/** Meetings being captured right now (bot or in-browser) — the presence dock. */
export async function listLiveSessions(): Promise<LiveSession[]> {
  return json(await fetch("/api/notes/live/sessions", { cache: "no-store" }));
}

/** This meeting's live session, or null — how the console reattaches. */
export async function getLiveSession(
  meetingId: string
): Promise<LiveSession | null> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/live/session`, {
      cache: "no-store",
    })
  );
}

/** Who's on the call so far, per the live voiceprint gallery. */
export async function getLiveRoster(meetingId: string): Promise<LiveSpeaker[]> {
  const body = await json<{ speakers: LiveSpeaker[] }>(
    await fetch(`/api/notes/meetings/${meetingId}/live/roster`, {
      cache: "no-store",
    })
  );
  return body.speakers ?? [];
}

/** Opt the copilot in/out for a live session — allowed mid-session, both ways. */
export async function setCopilot(
  meetingId: string,
  enabled: boolean,
  mode?: LiveSession["mode"]
): Promise<LiveSession> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/live/copilot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, mode: mode ?? null }),
    })
  );
}

export async function listMeetings(query?: string): Promise<MeetingListItem[]> {
  const qs = query ? `?query=${encodeURIComponent(query)}` : "";
  return json(await fetch(`/api/notes/meetings${qs}`, { cache: "no-store" }));
}

export async function createMeeting(
  title?: string,
  platform: string = "upload",
  templateKey?: string,
  scheduledAt?: string
): Promise<MeetingListItem> {
  return json(
    await fetch("/api/notes/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title || null,
        platform,
        template_key: templateKey || null,
        scheduled_at: scheduledAt || null,
      }),
    })
  );
}

export async function uploadRecording(
  meetingId: string,
  file: File,
  channel: string = "upload"
): Promise<{ recording_id: string; run_id: string; status: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("channel", channel);
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/upload`, {
      method: "POST",
      body: form,
    })
  );
}

export async function getMeeting(id: string): Promise<MeetingDetail> {
  return json(await fetch(`/api/notes/meetings/${id}`, { cache: "no-store" }));
}

// ── Live recording (chunked capture) ────────────────────────────────────────

export async function startRecording(
  meetingId: string,
  channel: string,
  mime: string
): Promise<{ recording_id: string }> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/recordings/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, mime }),
    })
  );
}

export async function uploadChunk(
  meetingId: string,
  recordingId: string,
  seq: number,
  blob: Blob
): Promise<void> {
  const res = await fetch(
    `/api/notes/meetings/${meetingId}/recordings/${recordingId}/chunk?seq=${seq}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
    }
  );
  if (!res.ok) throw new Error(`chunk ${seq} failed: ${res.status}`);
}

export async function completeRecording(
  meetingId: string,
  recordingId: string,
  durationS: number
): Promise<{ run_id: string; status: string }> {
  return json(
    await fetch(
      `/api/notes/meetings/${meetingId}/recordings/${recordingId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration_s: durationS }),
      }
    )
  );
}

export async function deleteMeeting(id: string): Promise<void> {
  const res = await fetch(`/api/notes/meetings/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
}

export function audioUrl(id: string): string {
  return `/api/notes/meetings/${id}/audio`;
}

export async function getNote(meetingId: string): Promise<NoteDoc> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/note`, { cache: "no-store" })
  );
}

export async function saveNote(
  meetingId: string,
  notesMd: string
): Promise<NoteDoc> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/note`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes_md: notesMd }),
    })
  );
}

export async function listActions(meetingId: string): Promise<ActionItem[]> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/actions`, { cache: "no-store" })
  );
}

export async function approveAction(
  actionId: string
): Promise<{ action_id: string; status: string; resulting_task_id: string | null }> {
  return json(
    await fetch(`/api/notes/actions/${actionId}/approve`, { method: "POST" })
  );
}

export async function rejectAction(
  actionId: string
): Promise<{ action_id: string; status: string }> {
  return json(
    await fetch(`/api/notes/actions/${actionId}/reject`, { method: "POST" })
  );
}

export async function approveAllActions(
  meetingId: string,
  minConfidence = 0.8
): Promise<{ created: string[] }> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/actions/approve-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ min_confidence: minConfidence }),
    })
  );
}

export async function summarize(
  meetingId: string
): Promise<{ run_id: string; status: string }> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/summarize`, { method: "POST" })
  );
}

export async function retranscribe(
  meetingId: string
): Promise<{ recording_id: string; run_id: string; status: string }> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/retranscribe`, {
      method: "POST",
    })
  );
}

export async function listTemplates(): Promise<
  { key: string; label: string }[]
> {
  return json(await fetch(`/api/notes/templates`, { cache: "no-store" }));
}

export async function setMeetingTemplate(
  meetingId: string,
  templateKey: string
): Promise<void> {
  const res = await fetch(`/api/notes/meetings/${meetingId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_key: templateKey }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

/** Update a meeting's prep fields. Omitted keys are left alone server-side. */
export async function patchMeeting(
  meetingId: string,
  patch: {
    title?: string;
    template_key?: string;
    scheduled_at?: string;
    copilot_enabled?: boolean;
  }
): Promise<MeetingListItem> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  );
}

export async function saveScratchNotes(
  meetingId: string,
  scratchNotes: string
): Promise<void> {
  const res = await fetch(`/api/notes/meetings/${meetingId}/scratch`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scratch_notes: scratchNotes }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

/** SSE URL for the pipeline progress stream (open with `new EventSource`). */
export function eventsUrl(meetingId: string): string {
  return `/api/notes/meetings/${meetingId}/events`;
}

// ── Glossary (org vocabulary that biases transcription) ─────────────────────

export interface GlossaryTerm {
  id: string;
  term: string;
}

export async function listGlossary(): Promise<GlossaryTerm[]> {
  return json(await fetch(`/api/notes/glossary`, { cache: "no-store" }));
}

export async function addGlossaryTerm(term: string): Promise<GlossaryTerm> {
  return json(
    await fetch(`/api/notes/glossary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ term }),
    })
  );
}

export async function deleteGlossaryTerm(id: string): Promise<void> {
  const res = await fetch(`/api/notes/glossary/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
}

export interface AskAnswer {
  answer: string;
  citations: { segment_id: string; idx: number }[];
  truncated: boolean;
}

export async function askMeeting(
  meetingId: string,
  question: string
): Promise<AskAnswer> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    })
  );
}

// ── Attendees + follow-up email ─────────────────────────────────────────────

export async function saveAttendees(
  meetingId: string,
  attendees: Attendee[]
): Promise<Attendee[]> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/attendees`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attendees }),
    })
  );
}

export async function saveSpeakerNames(
  meetingId: string,
  names: Record<string, string>
): Promise<Record<string, string>> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/speakers`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names }),
    })
  );
}

/** Auto-detect speaker names from self-introductions in the transcript.
 *  Non-destructive: names already set are kept; only anonymous speakers filled.
 *  `detected` is just the labels this run newly named (for a toast). */
export async function identifySpeakers(
  meetingId: string
): Promise<{ names: Record<string, string>; detected: Record<string, string> }> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/identify-speakers`, {
      method: "POST",
    })
  );
}

export async function draftFollowupEmail(
  meetingId: string
): Promise<EmailDraft> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/share/email/draft`, {
      method: "POST",
    })
  );
}

export async function listEmailAccounts(): Promise<EmailAccount[]> {
  return json(await fetch(`/api/email/accounts`, { cache: "no-store" }));
}

export async function sendEmail(payload: {
  account_id: string;
  to: string[];
  subject: string;
  body_text: string;
}): Promise<unknown> {
  const res = await fetch(`/api/email/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const b = await res.json();
      detail = b?.detail ?? b?.error ?? detail;
    } catch {
      /* non-JSON */
    }
    throw new Error(String(detail));
  }
  return res.json().catch(() => ({}));
}

// ── Meeting bot (send a notetaker to join a live call) ──────────────────────

/** Whether the meeting-bot feature is set up (a provider key is configured). */
export async function getBotConfig(): Promise<{
  configured: boolean;
  provider: string;
}> {
  return json(await fetch(`/api/notes/bots/status`, { cache: "no-store" }));
}

/** Dispatch a notetaker bot to join one meeting link. Call once per URL to fan
 *  out to several meetings at once. */
export async function botJoin(
  meetingUrl: string,
  title?: string,
  /** Send the bot to a meeting you already prepared, instead of a fresh one —
   *  otherwise the agenda and briefing you just wrote are stranded. */
  meetingId?: string
): Promise<MeetingBot> {
  return json(
    await fetch(`/api/notes/meetings/bot-join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        meeting_url: meetingUrl,
        title: title || null,
        meeting_id: meetingId || null,
      }),
    })
  );
}

/** Active notetaker bots (poll-on-read: this also advances their status). */
export async function listActiveBots(): Promise<MeetingBot[]> {
  return json(await fetch(`/api/notes/bots/active`, { cache: "no-store" }));
}

/** Remove the notetaker from a meeting's call (audio so far is still processed). */
export async function stopBot(meetingId: string): Promise<void> {
  const res = await fetch(`/api/notes/meetings/${meetingId}/bot/stop`, {
    method: "POST",
  });
  if (!res.ok && res.status !== 202) throw new Error(`${res.status}`);
}

/** The latest notetaker bot for a meeting (null when none was ever sent). */
export async function getMeetingBot(meetingId: string): Promise<MeetingBot | null> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/bot`, { cache: "no-store" })
  );
}

/** Why a notetaker couldn't join — the page the bot actually saw. */
export async function getBotDiagnostics(
  meetingId: string
): Promise<BotDiagnostics> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/bot/diagnostics`, {
      cache: "no-store",
    })
  );
}

/** The green room exactly as the bot saw it (PNG); 404s when none captured. */
export function botScreenshotUrl(meetingId: string): string {
  return `/api/notes/meetings/${meetingId}/bot/screenshot`;
}

/** Dispatch one action item to its kind's system now (task / email / doc). */
export async function dispatchAction(actionId: string): Promise<{
  action_id: string;
  status: string;
  kind: "task" | "email" | "document";
  resulting_task_id: string | null;
  dispatch_ref: string | null;
  dispatch_error: string | null;
}> {
  return json(
    await fetch(`/api/notes/actions/${actionId}/dispatch`, { method: "POST" })
  );
}

export function formatClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
