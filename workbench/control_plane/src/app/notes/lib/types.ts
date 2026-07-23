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

export interface MeetingDetail extends MeetingListItem {
  transcript_source: string | null;
  summary_md: string | null;
  recordings: Recording[];
  segments: Segment[];
  runs: SummaryRun[];
}
