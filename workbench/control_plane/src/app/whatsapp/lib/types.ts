// Wire shapes returned by the gateway /whatsapp/* routes (see
// apps/services/gateway/gateway/routes/whatsapp/core.py). Kept in sync by hand —
// a small, stable surface for the read-only W0 app.

export type WaAccount = {
  id: string;
  phone_number: string;
  phone_number_id: string;
  waba_id: string | null;
  display_name: string;
  avatar_color: string;
  sync_status: string;
  sync_error: string | null;
  history_import_phase: number;
  quality_rating: string | null;
  last_synced_at: string | null;
  is_default: boolean;
};

export type WaChat = {
  id: string;
  account_id: string;
  wa_chat_id: string;
  kind: string;
  name: string;
  category: string | null;
  status: string | null; // NEEDS_REPLY | AWAITING | FYI | DONE
  last_message_at: string | null;
  last_snippet: string;
  window_open: boolean;
  window_expires_at: string | null;
};

export type WaMessage = {
  id: string;
  chat_id: string;
  wa_message_id: string;
  direction: string; // 'in' | 'out'
  kind: string;
  sender_name: string;
  body_text: string;
  transcript_text: string | null; // voice-note transcription (W4.3)
  quoted_wa_message_id: string | null;
  categories: string[];
  intent: string | null;
  send_regime: string | null;
  sent_at: string | null;
};

export type WaStreams = {
  needs_reply: number;
  waiting: number;
  groups: number;
  all: number;
};

export type WaTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  variables: string[];
  meta_status: string;
  cost_hint: string | null;
};

export type WaCategory = {
  id: string;
  name: string;
  icon: string | null;
  wa_label_id: string | null;
  notify_policy: string; // instant | digest | mention_only | never
  auto_reply_policy: string; // never | holding | answer_from_system
  draft_policy: string; // always | on_intent | never
  escalate_after_mins: number | null;
  sort_order: number;
};

export const NOTIFY_POLICIES = ["instant", "digest", "mention_only", "never"];
export const AUTO_REPLY_POLICIES = ["never", "holding", "answer_from_system"];
export const DRAFT_POLICIES = ["always", "on_intent", "never"];

export type WaRulePreviewItem = {
  chat_id: string;
  name: string;
  intent: string | null;
  category: string | null;
  action: string; // answer_from_system | holding_reply | draft | none
  reason: string;
  requires_approval: boolean;
  via_template: boolean;
};

export type WaRulePreview = {
  items: WaRulePreviewItem[];
  summary: Record<string, number>;
};

export type WaEntityRef = { system: string; kind: string; id: string };

export type WaOpenLoop = {
  id: string;
  title: string;
  disposition: string;
  kind: string;
};

// A promise they owe us in this chat — nudgeable by id (W4.2).
export type WaWaitingOn = {
  id: string;
  text: string;
  due_hint: string | null;
};

export type WaChatContext = {
  chat_id: string;
  contact: {
    phone_number: string;
    display_name: string;
    category: string | null;
    entity: WaEntityRef | null;
  } | null;
  open_loops: WaOpenLoop[];
  waiting_on: WaWaitingOn[];
  stats: { message_count: number; first_seen: string | null; last_seen: string | null };
  crm: Record<string, unknown> | null;
};

// The triage streams shown in the nav — the single organizing spine.
export const STREAMS: { key: string; label: string; icon: string }[] = [
  { key: "needs_reply", label: "Needs reply", icon: "✦" },
  { key: "waiting", label: "Waiting on them", icon: "⏳" },
  { key: "groups", label: "Groups", icon: "👥" },
  { key: "all", label: "All chats", icon: "💬" },
];
