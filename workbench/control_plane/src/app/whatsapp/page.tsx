"use client";

// WhatsApp Message Manager — W0 read-only surface.
//
// The calm v3 IA (ai-company-brain/specs/mockups/whatsapp_message_manager.html):
// one organizing spine (triage streams in the nav), quiet near-textual rows, a
// two-pane list→thread view. No stat wall, no chip cloud, no resident row
// buttons — capability arrives in later phases as streams / settings / drawers,
// never as more always-on chrome on the queue.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  MessageCircle,
  Mic,
  PanelRight,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
} from "lucide-react";
import {
  captureTask,
  draftNudge,
  fetchAccounts,
  fetchChats,
  fetchContext,
  fetchMessages,
  fetchStreams,
  fetchTemplates,
  generateDraft,
  sendTemplate,
  sendText,
  transcribeMessage,
} from "./lib/api";
import {
  STREAMS,
  type WaAccount,
  type WaChat,
  type WaChatContext,
  type WaMessage,
  type WaStreams,
  type WaTemplate,
  type WaWaitingOn,
} from "./lib/types";

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

  const reloadMessages = useCallback(async () => {
    if (selectedChat) setMessages(await fetchMessages(selectedChat.id));
  }, [selectedChat]);

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
        <div className="mt-auto">
          <div className="px-2 py-1 text-[10px] font-bold tracking-wider text-muted-foreground/70">
            AUTOMATION
          </div>
          <Link
            href="/whatsapp/settings/categories"
            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-muted-foreground hover:bg-muted/50"
          >
            <Settings className="h-3.5 w-3.5" /> Categories
          </Link>
          <Link
            href="/whatsapp/settings/rules"
            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-muted-foreground hover:bg-muted/50"
          >
            ⚖ Rules preview
          </Link>
        </div>
        <div className="flex items-center gap-2 border-t border-border pt-3">
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
          <Conversation
            chat={selectedChat}
            messages={messages}
            accountId={accounts[0].id}
            onReload={reloadMessages}
          />
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
  accountId,
  onReload,
}: {
  chat: WaChat;
  messages: WaMessage[];
  accountId: string;
  onReload: () => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [context, setContext] = useState<WaChatContext | null>(null);
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);

  // Load context + approved templates when the details drawer or picker opens.
  useEffect(() => {
    if (showDetails) fetchContext(chat.id).then(setContext);
  }, [showDetails, chat.id]);
  useEffect(() => {
    if (showTemplates && !templates.length)
      fetchTemplates(accountId).then(setTemplates);
  }, [showTemplates, templates.length, accountId]);

  const doSendText = useCallback(async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    const res = await sendText(chat.id, text.trim());
    setSending(false);
    if (res.ok) {
      setText("");
      await onReload();
    } else {
      setError(res.error ?? "send failed");
    }
  }, [text, sending, chat.id, onReload]);

  const doDraft = useCallback(async () => {
    if (drafting) return;
    setDrafting(true);
    setError(null);
    const res = await generateDraft(chat.id);
    setDrafting(false);
    if (res.ok && res.data) setText(res.data.draft_text);
    else setError(res.error ?? "couldn't draft a reply");
  }, [drafting, chat.id]);

  const doSendTemplate = useCallback(
    async (t: WaTemplate) => {
      setSending(true);
      setError(null);
      const res = await sendTemplate(chat.id, t.name, t.language);
      setSending(false);
      setShowTemplates(false);
      if (res.ok) await onReload();
      else setError(res.error ?? "send failed");
    },
    [chat.id, onReload]
  );

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center gap-3 border-b border-border px-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-foreground/80">
            {initials(chat.name, chat.wa_chat_id)}
          </span>
          <b className="text-[13px]">{chat.name || chat.wa_chat_id}</b>
          {chat.window_open ? (
            <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-500">
              session open
            </span>
          ) : (
            <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
              window closed · template only
            </span>
          )}
          <button
            onClick={() => setShowDetails((v) => !v)}
            className={`ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] ${
              showDetails ? "bg-muted text-foreground" : "text-muted-foreground"
            }`}
          >
            <PanelRight className="h-3.5 w-3.5" /> Details
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="pt-8 text-center text-[12px] text-muted-foreground">
              No messages loaded.
            </div>
          ) : (
            messages.map((m) => (
              <Bubble key={m.id} msg={m} onReload={onReload} />
            ))
          )}
        </div>

        {/* Composer — window-aware. Open: free-form text. Closed: template picker. */}
        <div className="border-t border-border p-3">
          {error && (
            <div className="mb-2 rounded-md bg-red-500/10 px-3 py-1.5 text-[11px] text-red-500">
              {error}
            </div>
          )}
          {chat.window_open ? (
            <div>
              <button
                onClick={doDraft}
                disabled={drafting}
                className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary disabled:opacity-50"
              >
                {drafting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                Suggest reply
              </button>
              <div className="flex items-end gap-2">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
                      doSendText();
                  }}
                  rows={2}
                  placeholder="Type a reply…  (⌘↵ to send)"
                  className="min-h-[40px] flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-[12px] outline-none focus:border-primary"
                />
                <button
                  onClick={doSendText}
                  disabled={!text.trim() || sending}
                  className="flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-[12px] font-semibold text-white disabled:opacity-50"
                >
                  {sending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  Send
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button
                onClick={() => setShowTemplates((v) => !v)}
                className="w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-[12px] text-muted-foreground"
              >
                The 24h window is closed — send an approved template ▾
              </button>
              {showTemplates && (
                <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-border">
                  {templates.length === 0 ? (
                    <div className="p-3 text-[11px] text-muted-foreground">
                      No approved templates yet.
                    </div>
                  ) : (
                    templates.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => doSendTemplate(t)}
                        disabled={sending}
                        className="block w-full border-b border-border px-3 py-2 text-left last:border-0 hover:bg-muted/50 disabled:opacity-50"
                      >
                        <div className="text-[12px] font-semibold">{t.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {t.body}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showDetails && (
        <DetailsDrawer context={context} onUseDraft={(t) => setText(t)} />
      )}
    </div>
  );
}

function DetailsDrawer({
  context,
  onUseDraft,
}: {
  context: WaChatContext | null;
  onUseDraft: (text: string) => void;
}) {
  return (
    <div className="w-60 shrink-0 overflow-y-auto border-l border-border bg-muted/20 p-4 text-[11px]">
      <div className="mb-2 text-[12px] font-semibold">Details</div>
      {!context ? (
        <div className="text-muted-foreground">Loading…</div>
      ) : (
        <div className="space-y-4">
          {context.contact && (
            <div>
              <div className="mb-1 text-[9px] font-bold tracking-wider text-muted-foreground/70">
                CONTACT
              </div>
              <div className="font-semibold">
                {context.contact.display_name || context.contact.phone_number}
              </div>
              <div className="text-muted-foreground">
                {context.contact.phone_number}
              </div>
              {context.contact.category && (
                <div className="mt-1 inline-block rounded-full bg-muted px-2 py-0.5 text-[10px]">
                  {context.contact.category}
                </div>
              )}
              {context.contact.entity && (
                <div className="mt-1 text-muted-foreground">
                  {context.contact.entity.system} ·{" "}
                  {context.contact.entity.kind} #{context.contact.entity.id}
                </div>
              )}
            </div>
          )}
          <div>
            <div className="mb-1 text-[9px] font-bold tracking-wider text-muted-foreground/70">
              OPEN LOOPS
            </div>
            {context.open_loops.length === 0 ? (
              <div className="text-muted-foreground">None</div>
            ) : (
              <ul className="space-y-1">
                {context.open_loops.map((l) => (
                  <li key={l.id} className="leading-snug">
                    {l.kind === "commitment" ? "★ " : "☐ "}
                    {l.title}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {context.waiting_on.length > 0 && (
            <div>
              <div className="mb-1 text-[9px] font-bold tracking-wider text-muted-foreground/70">
                WAITING ON THEM
              </div>
              <ul className="space-y-2">
                {context.waiting_on.map((w) => (
                  <WaitingOnRow key={w.id} item={w} onUseDraft={onUseDraft} />
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="mb-1 text-[9px] font-bold tracking-wider text-muted-foreground/70">
              HISTORY
            </div>
            <div className="text-muted-foreground">
              {context.stats.message_count} messages
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WaitingOnRow({
  item,
  onUseDraft,
}: {
  item: WaWaitingOn;
  onUseDraft: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doNudge = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await draftNudge(item.id);
    setBusy(false);
    if (res.ok && res.data) {
      setDraft(res.data.nudge_text);
      onUseDraft(res.data.nudge_text); // drops it into the composer, if open
    } else {
      setError(res.error ?? "couldn't draft a nudge");
    }
  }, [busy, item.id, onUseDraft]);

  return (
    <li className="leading-snug">
      <div className="text-foreground/90">
        {item.text}
        {item.due_hint && (
          <span className="text-muted-foreground"> · {item.due_hint}</span>
        )}
      </div>
      <button
        onClick={doNudge}
        disabled={busy}
        className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
        ) : (
          <Sparkles className="h-2.5 w-2.5" />
        )}
        Nudge
      </button>
      {draft && (
        <div className="mt-1 rounded-md border border-border bg-background px-2 py-1 text-[10.5px] text-foreground/80">
          {draft}
        </div>
      )}
      {error && <div className="mt-1 text-[10px] text-red-500">{error}</div>}
    </li>
  );
}

function Bubble({
  msg,
  onReload,
}: {
  msg: WaMessage;
  onReload?: () => Promise<void> | void;
}) {
  const [captured, setCaptured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const out = msg.direction === "out";
  const isVoice = msg.kind === "voice" || msg.kind === "audio";

  const doCapture = useCallback(async () => {
    if (busy || captured) return;
    setBusy(true);
    const res = await captureTask(msg.id);
    setBusy(false);
    if (res.ok) setCaptured(true);
  }, [busy, captured, msg.id]);

  const doTranscribe = useCallback(async () => {
    if (transcribing) return;
    setTranscribing(true);
    const res = await transcribeMessage(msg.id);
    setTranscribing(false);
    if (res.ok) await onReload?.(); // reloads to show the transcript + new intent
  }, [transcribing, msg.id, onReload]);

  return (
    <div className={`group flex flex-col ${out ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[78%] rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
          out
            ? "rounded-br-sm border border-emerald-500/25 bg-emerald-500/15"
            : "rounded-bl-sm border border-border bg-muted"
        }`}
      >
        {isVoice ? (
          <div>
            <span className="flex items-center gap-1 text-muted-foreground">
              <Mic className="h-3 w-3" /> voice note
            </span>
            {msg.transcript_text ? (
              <div className="mt-1 italic text-foreground/90">
                “{msg.transcript_text}”
              </div>
            ) : (
              !out && (
                <button
                  onClick={doTranscribe}
                  disabled={transcribing}
                  className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary disabled:opacity-50"
                >
                  {transcribing ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-2.5 w-2.5" />
                  )}
                  Transcribe
                </button>
              )
            )}
          </div>
        ) : (
          <>
            {msg.kind !== "text" && (
              <span className="mr-1 text-muted-foreground">[{msg.kind}]</span>
            )}
            {msg.body_text || (
              <span className="text-muted-foreground">(no text)</span>
            )}
          </>
        )}
        <span className="mt-1 block text-right text-[8.5px] text-muted-foreground/60">
          {relTime(msg.sent_at)}
        </span>
      </div>
      {!out && (
        <button
          onClick={doCapture}
          disabled={busy}
          className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />
          {captured ? "captured" : "task"}
        </button>
      )}
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
