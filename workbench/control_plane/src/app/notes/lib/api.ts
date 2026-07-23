/** Thin client over /api/notes/* (the Next proxy to the gateway /notes API). */

import type {
  ActionItem,
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
  platform: string = "upload"
): Promise<MeetingListItem> {
  return json(
    await fetch("/api/notes/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title || null, platform }),
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

export async function summarize(
  meetingId: string
): Promise<{ run_id: string; status: string }> {
  return json(
    await fetch(`/api/notes/meetings/${meetingId}/summarize`, { method: "POST" })
  );
}

/** SSE URL for the pipeline progress stream (open with `new EventSource`). */
export function eventsUrl(meetingId: string): string {
  return `/api/notes/meetings/${meetingId}/events`;
}

export function formatClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
