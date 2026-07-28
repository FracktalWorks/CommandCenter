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
  template_key: string | null;
  start_at: string | null;
  created_at: string | null;
}

/** A meeting-notes template (shapes the generated summary). */
export interface NoteTemplate {
  key: string;
  label: string;
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

/** A decision from the structured notes, with the transcript segments (by idx)
 *  it was grounded in — powers tap-to-verify provenance. */
export interface SummaryDecision {
  text: string;
  refs?: number[];
}

/** Structured notes JSON (subset the UI reads for provenance). */
export interface SummaryJson {
  decisions?: SummaryDecision[];
}

export interface MeetingDetail extends MeetingListItem {
  transcript_source: string | null;
  summary_md: string | null;
  /** Structured notes; decisions carry `refs` (source segment indices). */
  summary_json: SummaryJson | null;
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

/** A notetaker bot dispatched to join a live call (spec §3.13). */
export type MeetingBotStatus =
  | "requested"
  | "joining"
  | "waiting_room"
  | "in_call"
  | "processing"
  | "done"
  | "failed"
  | "left"
  | "not_admitted";

export interface MeetingBot {
  id: string;
  meeting_id: string;
  status: MeetingBotStatus;
  provider: string;
  meeting_url: string;
  bot_name: string | null;
  error: string | null;
  meeting_title: string | null;
  created_at: string | null;
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

/** A meeting being captured right now — powers the "live now" presence dock. */
export interface LiveSession {
  id: string;
  meeting_id: string;
  source: "bot" | "browser";
  owner_email: string | null;
  status: "live" | "ended";
  /** Opt-in, off by default; stored in Phase A, acted on by the orchestrator. */
  copilot_enabled: boolean;
  mode: "listening" | "interactive" | "speaking";
  /** May this session ask the business agents (CRM, tasks) for background? */
  deep_context: boolean;
  started_at: string | null;
  ended_at: string | null;
  title: string | null;
}

/** One live-transcript segment off the bus (bot or in-browser recorder). */
export interface LiveSegment {
  text: string;
  start_s: number;
  end_s: number;
  /** Stable across chunks — assigned by the live voiceprint gallery. */
  speaker_id: string | null;
  speaker_label: string | null;
  /** Bound live from a self-introduction ("I'm Priya"), when detected. */
  speaker_name: string | null;
  role: string | null;
  is_final: boolean;
  ts: number | null;
}

/** Who's on the call so far, per the live speaker registry. */
export interface LiveSpeaker {
  speaker_id: string;
  name: string | null;
  role: string | null;
  utterances: number;
}

/** Something the copilot surfaced during a live session. */
export interface CopilotEvent {
  kind: "suggestion" | "question" | "answer" | "fact" | "status";
  text: string;
  /** What it was grounded in — the window, speakers and trigger. */
  refs: {
    window?: string;
    speakers?: string[];
    topic?: string;
    trigger?: string;
  };
  token_cost: number;
  ts: number | null;
}

/** What the copilot knows about a meeting before anyone speaks. */
export interface MeetingContext {
  /** Layer 1 — what you told it. The highest-value source. */
  brief: string;
  attendees: string[];
  /** Layer 2 — past meetings with the same people. */
  past: string[];
  open_actions: string[];
  /** Layer 3 — what the business agents reported (CRM, tasks). */
  systems: Record<string, string>;
  is_empty: boolean;
}

/** One thing to cover in a meeting. Structured so it can be measured live. */
export interface AgendaItem {
  title: string;
  notes: string;
}

/** Note Taker settings — one row per user, read/written whole. */
export interface NotesSettings {
  copilot_instructions: string;
  copilot_default_on: boolean;
  copilot_sensitivity: "low" | "normal" | "high";
  /** Per-meeting-type overrides. Absent key = use the shipped default. */
  template_instructions: Record<string, string>;
  default_template: string | null;
  bot_name: string | null;
}

/** A meeting type, with the copilot guidance shipped for it. */
export interface TemplateInfo {
  key: string;
  label: string;
  copilot_default: string;
  agenda_hint: string;
}

export interface NotesSettingsPayload {
  settings: NotesSettings;
  templates: TemplateInfo[];
  sensitivities: string[];
}
