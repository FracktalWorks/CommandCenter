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

// The triage streams shown in the nav — the single organizing spine.
export const STREAMS: { key: string; label: string; icon: string }[] = [
  { key: "needs_reply", label: "Needs reply", icon: "✦" },
  { key: "waiting", label: "Waiting on them", icon: "⏳" },
  { key: "groups", label: "Groups", icon: "👥" },
  { key: "all", label: "All chats", icon: "💬" },
];
