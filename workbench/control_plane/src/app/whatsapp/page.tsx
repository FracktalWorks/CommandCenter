"use client";

// WhatsApp Message Manager — W0 read-only surface.
//
// The calm v3 IA (ai-company-brain/specs/mockups/whatsapp_message_manager.html):
// one organizing spine (triage streams in the nav), quiet near-textual rows, a
// two-pane list→thread view. No stat wall, no chip cloud, no resident row
// buttons — capability arrives in later phases as streams / settings / drawers,
// never as more always-on chrome on the queue.

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageCircle, Search } from "lucide-react";
import { fetchAccounts, fetchChats, fetchMessages, fetchStreams } from "./lib/api";
import { STREAMS, type WaAccount, type WaChat, type WaMessage, type WaStreams } from "./lib/types";

function relTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

function initials(name: string, fallback: string): string {
  const src = (name || fallback || "?").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export default function WhatsAppPage() {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<WaAccount[]>([]);
  const [streams, setStreams] = useState<WaStreams>({
    needs_reply: 0,
    waiting: 0,
    groups: 0,
    all: 0,
  });
  const [activeStream, setActiveStream] = useState("needs_reply");
  const [chats, setChats] = useState<WaChat[]>([]);
  const [selectedChat, setSelectedChat] = useState<WaChat | null>(null);
  const [messages, setMessages] = useState<WaMessage[]>([]);

  // Initial load: accounts + stream counts.
  useEffect(() => {
    (async () => {
      const accs = await fetchAccounts();
      setAccounts(accs);
      if (accs.length) setStreams(await fetchStreams());
      setLoading(false);
    })();
  }, []);

  // Reload the chat list whenever the active stream changes.
  const loadChats = useCallback(async () => {
    if (!accounts.length) return;
    setChats(await fetchChats(activeStream));
  }, [accounts.length, activeStream]);

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  const openChat = useCallback(async (chat: WaChat) => {
    setSelectedChat(chat);
    setMessages(await fetchMessages(chat.id));
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!accounts.length) return <ConnectEmptyState />;

  const streamCount = (key: string) =>
    (streams as unknown as Record<string, number>)[key] ?? 0;

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      {/* ── Spine: triage streams ─────────────────────────────────── */}
      <nav className="w-52 shrink-0 border-r border-border p-3 flex flex-col">
        <div className="px-2 py-1 text-[10px] font-bold tracking-wider text-muted-foreground/70">
          TRIAGE
        </div>
        {STREAMS.map((s) => {
          const active = s.key === activeStream;
          const count = streamCount(s.key);
          return (
            <button
              key={s.key}
              onClick={() => {
                setActiveStream(s.key);
                setSelectedChat(null);
              }}
              className={`flex items-center gap-2 rounded-lg border-l-2 px-2.5 py-2 text-left text-[13px] ${
                active
                  ? "border-primary bg-muted font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/50"
              }`}
            >
              <span className="w-4 text-center">{s.icon}</span>
              <span className="flex-1 truncate">{s.label}</span>
              <span
                className={`text-[11px] tabular-nums ${
                  active ? "text-primary font-bold" : "text-muted-foreground/60"
                }`}
              >
                {count || "·"}
              </span>
            </button>
          );
        })}
        <div className="mt-auto flex items-center gap-2 border-t border-border pt-3">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-bold text-white"
            style={{ background: accounts[0].avatar_color || "#25D366" }}
          >
            {initials(accounts[0].display_name, "WA")}
          </span>
          <div className="min-w-0 text-[10px]">
            <div className="truncate font-semibold">{accounts[0].display_name}</div>
            <div className="text-emerald-500">● live</div>
          </div>
        </div>
      </nav>

      {/* ── Conversation list (quiet rows) ────────────────────────── */}
      <div className="flex w-[340px] shrink-0 flex-col border-r border-border">
        <div className="flex h-12 items-center gap-2 border-b border-border px-4">
          <b className="text-sm">
            {STREAMS.find((s) => s.key === activeStream)?.label}
          </b>
          <span className="text-[11px] text-muted-foreground">
            {chats.length}
          </span>
          <div className="ml-auto flex items-center gap-1 text-muted-foreground/60">
            <Search className="h-3.5 w-3.5" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {chats.length === 0 ? (
            <div className="p-6 text-center text-[12px] text-muted-foreground">
              Nothing here yet. New messages arrive automatically once your
              number receives them.
            </div>
          ) : (
            chats.map((c) => (
              <ChatRow
                key={c.id}
                chat={c}
                selected={selectedChat?.id === c.id}
                onClick={() => openChat(c)}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Conversation thread ───────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedChat ? (
          <Conversation chat={selectedChat} messages={messages} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
            Select a conversation
          </div>
        )}
      </div>
    </div>
  );
}

function ChatRow({
  chat,
  selected,
  onClick,
}: {
  chat: WaChat;
  selected: boolean;
  onClick: () => void;
}) {
  const needsReply = chat.status === "NEEDS_REPLY";
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left ${
        selected ? "bg-muted" : "hover:bg-muted/40"
      }`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-foreground/80">
        {initials(chat.name, chat.wa_chat_id)}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-[13px] ${
            needsReply ? "font-semibold" : ""
          }`}
        >
          {chat.name || chat.wa_chat_id}
        </div>
        <div className="truncate text-[11.5px] text-muted-foreground">
          {chat.last_snippet || "…"}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="text-[10px] tabular-nums text-muted-foreground/60">
          {relTime(chat.last_message_at)}
        </span>
        {needsReply && (
          <span className="h-2 w-2 rounded-full bg-red-500" aria-label="needs reply" />
        )}
      </div>
    </button>
  );
}

function Conversation({
  chat,
  messages,
}: {
  chat: WaChat;
  messages: WaMessage[];
}) {
  return (
    <>
      <div className="flex h-12 items-center gap-3 border-b border-border px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-foreground/80">
          {initials(chat.name, chat.wa_chat_id)}
        </span>
        <b className="text-[13px]">{chat.name || chat.wa_chat_id}</b>
        <span className="ml-auto">
          {chat.window_open ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-500">
              session open
            </span>
          ) : (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
              window closed · template only
            </span>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="pt-8 text-center text-[12px] text-muted-foreground">
            No messages loaded.
          </div>
        ) : (
          messages.map((m) => <Bubble key={m.id} msg={m} />)
        )}
      </div>
      {/* Composer is intentionally read-only in W0 — sending arrives in W1. */}
      <div className="border-t border-border p-3">
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
          Reading only for now — replies and AI drafts arrive in the next phase.
        </div>
      </div>
    </>
  );
}

function Bubble({ msg }: { msg: WaMessage }) {
  const out = msg.direction === "out";
  return (
    <div
      className={`max-w-[78%] rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
        out
          ? "ml-auto rounded-br-sm bg-emerald-500/15 border border-emerald-500/25"
          : "rounded-bl-sm border border-border bg-muted"
      }`}
    >
      {msg.kind !== "text" && (
        <span className="mr-1 text-muted-foreground">[{msg.kind}]</span>
      )}
      {msg.body_text || <span className="text-muted-foreground">(no text)</span>}
      <span className="mt-1 block text-right text-[8.5px] text-muted-foreground/60">
        {relTime(msg.sent_at)}
      </span>
    </div>
  );
}

function ConnectEmptyState() {
  return (
    <div className="flex h-full items-center justify-center bg-background p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-500">
          <MessageCircle className="h-7 w-7" />
        </div>
        <h1 className="text-lg font-semibold">Connect WhatsApp Business</h1>
        <p className="mx-auto mt-2 max-w-sm text-[13px] text-muted-foreground">
          Link your WhatsApp Business number through Meta&apos;s official Cloud
          API with coexistence — your phone app keeps working, and the last six
          months of chats sync into your triage queue here.
        </p>
        <button
          disabled
          className="mt-5 cursor-not-allowed rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground opacity-60"
          title="Embedded Signup requires Meta app configuration"
        >
          Start Embedded Signup
        </button>
        <p className="mt-3 text-[11px] text-muted-foreground/70">
          Requires a configured Meta app · business numbers only.
        </p>
      </div>
    </div>
  );
}
