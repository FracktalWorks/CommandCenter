/** Wire types for the /notes gateway API (snake_case, matching the backend). */

export type MeetingStatus =
  | "draft"
  | "recording"
  | "processing"
  | "ready"
  | "failed";

export interface MeetingListItem {
  id: string;
  title: string | null;
  platform: string;
  status: MeetingStatus;
  language: string | null;
  duration_s: number | null;
  segment_count: number;
  has_notes: boolean;
  owner_email: string | null;
  start_at: string | null;
  created_at: string | null;
}

export interface Segment {
  id: string;
  idx: number;
  start_s: number;
  end_s: number;
  text: string;
  speaker_label: string | null;
  channel: string | null;
  confidence: number | null;
}

export interface Recording {
  id: string;
  channel: string;
  mime: string;
  duration_s: number | null;
  byte_size: number;
  created_at: string | null;
}

export interface SummaryRun {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  stage: string | null;
  chunk_done: number;
  chunk_total: number;
  model: string | null;
  error: string | null;
  created_at: string | null;
  finished_at: string | null;
}

export interface Attendee {
  name: string;
  email: string;
}

export interface MeetingDetail extends MeetingListItem {
  transcript_source: string | null;
  summary_md: string | null;
  scratch_notes: string | null;
  attendees: Attendee[];
  /** Human names for diarized speaker labels, e.g. { "S1": "Alex Rivera" }. */
  speaker_names: Record<string, string>;
  recordings: Recording[];
  segments: Segment[];
  runs: SummaryRun[];
}

export interface EmailDraft {
  to: string[];
  subject: string;
  body_text: string;
}

export interface EmailAccount {
  id: string;
  email_address: string;
  label: string;
  is_default: boolean;
}

export interface ActionItem {
  id: string;
  description: string;
  confidence: number;
  status: "draft" | "approved" | "created" | "rejected";
  due_hint: string | null;
  segment_ids: string[];
  resulting_task_id: string | null;
}

export interface NoteDoc {
  meeting_id: string;
  notes_md: string | null;
  notes_json: Record<string, unknown> | null;
  updated_by: string | null;
  updated_at: string | null;
}

/** Snapshot pushed over the per-meeting SSE progress stream. */
export interface MeetingEvent {
  status: MeetingStatus;
  title: string | null;
  has_summary: boolean;
  runs: {
    kind: string;
    status: string;
    stage: string | null;
    chunk_done: number;
    chunk_total: number;
    error: string | null;
  }[];
}
