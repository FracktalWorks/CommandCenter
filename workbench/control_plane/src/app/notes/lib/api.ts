/** Thin client over /api/notes/* (the Next proxy to the gateway /notes API). */

import type {
  ActionItem,
  Attendee,
  EmailAccount,
  EmailDraft,
  MeetingDetail,
  MeetingListItem,
  NoteDoc,
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

export async function listMeetings(query?: string): Promise<MeetingListItem[]> {
  const qs = query ? `?query=${encodeURIComponent(query)}` : "";
  return json(await fetch(`/api/notes/meetings${qs}`, { cache: "no-store" }));
}

export async function createMeeting(
  title?: string,
  platform: string = "upload",
  templateKey?: string
): Promise<MeetingListItem> {
  return json(
    await fetch("/api/notes/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title || null,
        platform,
        template_key: templateKey || null,
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

export function formatClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
