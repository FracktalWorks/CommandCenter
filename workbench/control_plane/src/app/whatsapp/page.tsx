"use client";

// WhatsApp Message Manager — W0 read-only surface.
//
// The calm v3 IA (ai-company-brain/specs/mockups/whatsapp_message_manager.html):
// one organizing spine (triage streams in the nav), quiet near-textual rows, a
// two-pane list→thread view. No stat wall, no chip cloud, no resident row
// buttons — capability arrives in later phases as streams / settings / drawers,
// never as more always-on chrome on the queue.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ChevronsUpDown,
  Clock,
  Loader2,
  MessageCircle,
  Mic,
  PanelRight,
  Plus,
  Search,
  Send,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { useViewMode } from "@/components/ViewModeProvider";
import {
  captureTask,
  draftNudge,
  fetchAccounts,
  fetchChats,
  fetchContext,
  fetchMessages,
  fetchSavedReplies,
  fetchStreams,
  fetchTemplates,
  generateDraft,
  sendTemplate,
  sendText,
  snoozeChat,
  transcribeMessage,
  unsnoozeChat,
} from "./lib/api";
import {
  STREAMS,
  type WaAccount,
  type WaChat,
  type WaChatContext,
  type WaMessage,
  type WaSavedReply,
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

// Snooze presets, computed in the founder's own timezone (the browser's), so the
// server just stores the absolute instant we send.
function snoozePresets(): { label: string; at: Date }[] {
  const now = new Date();
  const laterToday = new Date(now.getTime() + 3 * 3600 * 1000);
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening <= now) evening.setDate(evening.getDate() + 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now);
  const daysUntilMonday = (8 - nextWeek.getDay()) % 7 || 7;
  nextWeek.setDate(nextWeek.getDate() + daysUntilMonday);
  nextWeek.setHours(9, 0, 0, 0);
  return [
    { label: "Later today", at: laterToday },
    { label: "This evening", at: evening },
    { label: "Tomorrow 9am", at: tomorrow },
    { label: "Next week", at: nextWeek },
  ];
}

function snoozeLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function initials(name: string, fallback: string): string {
  const src = (name || fallback || "?").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export default function WhatsAppPage() {
  const { isMobile } = useViewMode();
  // On mobile the three panes collapse to one: the list drills down into a
  // single conversation ("chat"), with a back button returning to "list".
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<WaAccount[]>([]);
  const [streams, setStreams] = useState<WaStreams>({
    needs_reply: 0,
    waiting: 0,
    groups: 0,
    all: 0,
    snoozed: 0,
  });
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [activeStream, setActiveStream] = useState("needs_reply");
  const [chats, setChats] = useState<WaChat[]>([]);
  const [selectedChat, setSelectedChat] = useState<WaChat | null>(null);
  const [messages, setMessages] = useState<WaMessage[]>([]);

  // Initial load: accounts (pick the default number as active).
  useEffect(() => {
    (async () => {
      const accs = await fetchAccounts();
      setAccounts(accs);
      if (accs.length) {
        setActiveAccountId(accs.find((a) => a.is_default)?.id ?? accs[0].id);
      }
      setLoading(false);
    })();
  }, []);

  // Stream counts follow the active number.
  useEffect(() => {
    if (activeAccountId) fetchStreams(activeAccountId).then(setStreams);
  }, [activeAccountId]);

  // Reload the chat list whenever the active stream OR number changes.
  const loadChats = useCallback(async () => {
    if (!activeAccountId) return;
    setChats(await fetchChats(activeStream, activeAccountId));
  }, [activeAccountId, activeStream]);

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  // Tracks the most recently opened chat so an out-of-order fetch (fast A→B
  // clicks) can't render A's messages under B.
  const openChatReq = useRef<string | null>(null);
  const openChat = useCallback(async (chat: WaChat) => {
    setSelectedChat(chat);
    setMobileView("chat"); // drill into the single-pane thread on mobile
    setMessages([]); // clear immediately so a slow fetch can't show the old chat
    openChatReq.current = chat.id;
    const msgs = await fetchMessages(chat.id);
    if (openChatReq.current === chat.id) setMessages(msgs);
  }, []);

  const reloadMessages = useCallback(async () => {
    if (selectedChat) setMessages(await fetchMessages(selectedChat.id));
  }, [selectedChat]);

  // Switch the active number: drop the open chat and let the effects reload.
  const switchAccount = useCallback((id: string) => {
    setActiveAccountId(id);
    setSelectedChat(null);
    setMobileView("list");
    setActiveStream("needs_reply");
  }, []);

  // After a snooze/unsnooze the chat leaves (or joins) the current stream —
  // drop the selection and refresh the counts + list.
  const refreshTriage = useCallback(async () => {
    setSelectedChat(null);
    setMobileView("list"); // a snoozed chat leaves the pane — return to the list
    if (activeAccountId) setStreams(await fetchStreams(activeAccountId));
    await loadChats();
  }, [activeAccountId, loadChats]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!accounts.length) return <ConnectEmptyState />;

  const activeAccount =
    accounts.find((a) => a.id === activeAccountId) ?? accounts[0];
  const streamCount = (key: string) =>
    (streams as unknown as Record<string, number>)[key] ?? 0;

  // ── Mobile: single-pane drill-down (list ⇄ conversation) ──────────────
  if (isMobile) {
    if (mobileView === "chat" && selectedChat) {
      return (
        <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
          <Conversation
            key={selectedChat.id}
            chat={selectedChat}
            messages={messages}
            accountId={activeAccount.id}
            onReload={reloadMessages}
            onTriageChange={refreshTriage}
            isMobile
            onBack={() => setMobileView("list")}
          />
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
        {/* number + triage-stream header */}
        <div className="shrink-0 border-b border-border">
          <MobileAccountBar
            accounts={accounts}
            active={activeAccount}
            onSwitch={switchAccount}
          />
          <div className="flex gap-1.5 overflow-x-auto px-3 pb-2">
            {STREAMS.map((s) => {
              const active = s.key === activeStream;
              const count = streamCount(s.key);
              const Icon = s.icon;
              return (
                <button
                  key={s.key}
                  onClick={() => {
                    setActiveStream(s.key);
                    setSelectedChat(null);
                  }}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] whitespace-nowrap ${
                    active
                      ? "bg-primary/15 font-semibold text-primary"
                      : "text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {s.label}
                  <span
                    className={`tabular-nums ${
                      active ? "text-primary font-bold" : "text-muted-foreground/60"
                    }`}
                  >
                    {count || "·"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {/* chat list (full width) */}
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
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      {/* ── Spine: triage streams ─────────────────────────────────── */}
      <nav className="w-52 shrink-0 space-y-0.5 border-r border-border p-2 flex flex-col">
        <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
          Triage
        </div>
        {STREAMS.map((s) => {
          const active = s.key === activeStream;
          const count = streamCount(s.key);
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              onClick={() => {
                setActiveStream(s.key);
                setSelectedChat(null);
              }}
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors ${
                active
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate text-xs">{s.label}</span>
              {count > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
        {/* Pulse / Categories / Replies / Rules / Numbers now live in the shared
            WhatsApp nav (whatsapp/layout.tsx), so they stay reachable from every
            sub-app. The switcher stays here — it scopes this inbox. */}
        <div className="mt-auto">
          <AccountSwitcher
            accounts={accounts}
            active={activeAccount}
            onSwitch={switchAccount}
          />
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
            key={selectedChat.id}
            chat={selectedChat}
            messages={messages}
            accountId={activeAccount.id}
            onReload={reloadMessages}
            onTriageChange={refreshTriage}
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

function AccountSwitcher({
  accounts,
  active,
  onSwitch,
}: {
  accounts: WaAccount[];
  active: WaAccount;
  onSwitch: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative border-t border-border pt-3">
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-lg border border-border bg-background shadow-lg">
          {accounts.map((a) => (
            <button
              key={a.id}
              onClick={() => {
                onSwitch(a.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/50 ${
                a.id === active.id ? "bg-muted/40" : ""
              }`}
            >
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                style={{ background: a.avatar_color || "#25D366" }}
              >
                {initials(a.display_name, "WA")}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-semibold">
                  {a.display_name || a.phone_number}
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {a.phone_number}
                </div>
              </div>
              {a.id === active.id && (
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              )}
            </button>
          ))}
          <Link
            href="/whatsapp/connect"
            className="flex items-center gap-2 border-t border-border px-2.5 py-2 text-[11px] font-semibold text-primary hover:bg-muted/50"
          >
            <Plus className="h-3.5 w-3.5" /> Connect another number
          </Link>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2"
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
          style={{ background: active.avatar_color || "#25D366" }}
        >
          {initials(active.display_name, "WA")}
        </span>
        <div className="min-w-0 flex-1 text-left text-[10px]">
          <div className="truncate font-semibold">
            {active.display_name || active.phone_number}
          </div>
          <div className="text-success">
            ● live
            {accounts.length > 1 ? ` · ${accounts.length} numbers` : ""}
          </div>
        </div>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      </button>
    </div>
  );
}

// Mobile equivalent of the desktop AccountSwitcher: a header row that names the
// active number and, when more than one is connected, opens a downward menu to
// switch. Desktop's switcher opens upward from the spine's foot — no good at the
// top of a phone screen — so this one drops down instead.
function MobileAccountBar({
  accounts,
  active,
  onSwitch,
}: {
  accounts: WaAccount[];
  active: WaAccount;
  onSwitch: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const multi = accounts.length > 1;
  return (
    <div className="relative">
      <button
        onClick={() => multi && setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
          style={{ background: active.avatar_color || "#25D366" }}
        >
          {initials(active.display_name, "WA")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold">
            {active.display_name || active.phone_number}
          </div>
          <div className="text-[10px] text-success">
            ● live{multi ? ` · ${accounts.length} numbers` : ""}
          </div>
        </div>
        {multi && (
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        )}
      </button>
      {open && multi && (
        <div className="absolute inset-x-3 top-full z-20 overflow-hidden rounded-lg border border-border bg-background shadow-lg">
          {accounts.map((a) => (
            <button
              key={a.id}
              onClick={() => {
                onSwitch(a.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/50 ${
                a.id === active.id ? "bg-muted/40" : ""
              }`}
            >
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                style={{ background: a.avatar_color || "#25D366" }}
              >
                {initials(a.display_name, "WA")}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-semibold">
                  {a.display_name || a.phone_number}
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {a.phone_number}
                </div>
              </div>
              {a.id === active.id && (
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              )}
            </button>
          ))}
          <Link
            href="/whatsapp/connect"
            className="flex items-center gap-2 border-t border-border px-2.5 py-2 text-[11px] font-semibold text-primary hover:bg-muted/50"
          >
            <Plus className="h-3.5 w-3.5" /> Connect another number
          </Link>
        </div>
      )}
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
  onTriageChange,
  isMobile = false,
  onBack,
}: {
  chat: WaChat;
  messages: WaMessage[];
  accountId: string;
  onReload: () => Promise<void> | void;
  onTriageChange: () => Promise<void> | void;
  isMobile?: boolean;
  onBack?: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [context, setContext] = useState<WaChatContext | null>(null);
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [savedReplies, setSavedReplies] = useState<WaSavedReply[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const [showSnooze, setShowSnooze] = useState(false);
  const isSnoozed = Boolean(
    chat.snoozed_until && new Date(chat.snoozed_until) > new Date()
  );

  const doSnooze = useCallback(
    async (at: Date) => {
      setShowSnooze(false);
      const res = await snoozeChat(chat.id, at.toISOString());
      if (res.ok) await onTriageChange();
      else setError(res.error ?? "couldn't snooze");
    },
    [chat.id, onTriageChange]
  );

  const doUnsnooze = useCallback(async () => {
    const res = await unsnoozeChat(chat.id);
    if (res.ok) await onTriageChange();
    else setError(res.error ?? "couldn't unsnooze");
  }, [chat.id, onTriageChange]);

  // Load context + approved templates when the details drawer or picker opens.
  useEffect(() => {
    if (showDetails) fetchContext(chat.id).then(setContext);
  }, [showDetails, chat.id]);
  useEffect(() => {
    if (showTemplates && !templates.length)
      fetchTemplates(accountId).then(setTemplates);
  }, [showTemplates, templates.length, accountId]);
  useEffect(() => {
    if (showSaved && !savedReplies.length)
      fetchSavedReplies(accountId).then(setSavedReplies);
  }, [showSaved, savedReplies.length, accountId]);

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
    <div className="relative flex h-full min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center gap-2 border-b border-border px-3">
          {onBack && (
            <button
              onClick={onBack}
              aria-label="Back to list"
              className="-ml-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-foreground/80">
            {initials(chat.name, chat.wa_chat_id)}
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <b className="truncate text-[13px]">{chat.name || chat.wa_chat_id}</b>
            {chat.window_open ? (
              <span className="hidden shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success sm:inline">
                session open
              </span>
            ) : (
              <span className="hidden shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground sm:inline">
                window closed · template only
              </span>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {isSnoozed ? (
              <button
                onClick={doUnsnooze}
                className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground"
                title={`Snoozed until ${snoozeLabel(chat.snoozed_until)}`}
              >
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden sm:inline">
                  Snoozed · {snoozeLabel(chat.snoozed_until)} — wake
                </span>
                <span className="sm:hidden">Snoozed</span>
              </button>
            ) : (
              <div className="relative">
                <button
                  onClick={() => setShowSnooze((v) => !v)}
                  className={`flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] ${
                    showSnooze ? "bg-muted text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">Snooze</span>
                </button>
                {showSnooze && (
                  <div className="absolute right-0 top-8 z-10 w-40 overflow-hidden rounded-lg border border-border bg-background shadow-lg">
                    {snoozePresets().map((p) => (
                      <button
                        key={p.label}
                        onClick={() => doSnooze(p.at)}
                        className="flex w-full items-center justify-between border-b border-border px-3 py-2 text-left text-[11px] last:border-0 hover:bg-muted/50"
                      >
                        <span>{p.label}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {snoozeLabel(p.at.toISOString())}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => setShowDetails((v) => !v)}
              className={`flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] ${
                showDetails ? "bg-muted text-foreground" : "text-muted-foreground"
              }`}
            >
              <PanelRight className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">Details</span>
            </button>
          </div>
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
              <div className="mb-2 flex items-center gap-2">
                <button
                  onClick={doDraft}
                  disabled={drafting}
                  className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary disabled:opacity-50"
                >
                  {drafting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  Suggest reply
                </button>
                <div className="relative">
                  <button
                    onClick={() => setShowSaved((v) => !v)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                      showSaved
                        ? "bg-muted text-foreground"
                        : "bg-muted/50 text-muted-foreground"
                    }`}
                  >
                    <Zap className="h-3 w-3" /> Saved
                  </button>
                  {showSaved && (
                    <div className="absolute bottom-8 left-0 z-10 max-h-56 w-72 overflow-y-auto rounded-lg border border-border bg-background shadow-lg">
                      {savedReplies.length === 0 ? (
                        <Link
                          href="/whatsapp/settings/replies"
                          className="block p-3 text-[11px] text-muted-foreground hover:bg-muted/50"
                        >
                          No saved replies yet — add some →
                        </Link>
                      ) : (
                        savedReplies.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => {
                              setText((t) => (t ? `${t}\n${r.body}` : r.body));
                              setShowSaved(false);
                            }}
                            className="block w-full border-b border-border px-3 py-2 text-left last:border-0 hover:bg-muted/50"
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12px] font-semibold">
                                {r.title}
                              </span>
                              {r.shortcut && (
                                <span className="font-mono text-[9.5px] text-muted-foreground">
                                  {r.shortcut}
                                </span>
                              )}
                            </div>
                            <div className="truncate text-[11px] text-muted-foreground">
                              {r.body}
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
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
                  className="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
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

      {showDetails &&
        (isMobile ? (
          <div className="absolute inset-0 z-20 flex flex-col bg-background">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
              <span className="text-[13px] font-semibold">Details</span>
              <button
                onClick={() => setShowDetails(false)}
                aria-label="Close details"
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <DetailsDrawer
                context={context}
                onUseDraft={(t) => setText(t)}
                mobile
              />
            </div>
          </div>
        ) : (
          <DetailsDrawer context={context} onUseDraft={(t) => setText(t)} />
        ))}
    </div>
  );
}

function DetailsDrawer({
  context,
  onUseDraft,
  mobile = false,
}: {
  context: WaChatContext | null;
  onUseDraft: (text: string) => void;
  mobile?: boolean;
}) {
  return (
    <div
      className={
        mobile
          ? "p-4 text-[11px]"
          : "w-60 shrink-0 overflow-y-auto border-l border-border bg-muted/20 p-4 text-[11px]"
      }
    >
      {!mobile && <div className="mb-2 text-[12px] font-semibold">Details</div>}
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
            ? "rounded-br-sm border border-primary/30 bg-primary/10"
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
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <MessageCircle className="h-7 w-7" />
        </div>
        <h1 className="text-lg font-semibold">Connect WhatsApp Business</h1>
        <p className="mx-auto mt-2 max-w-sm text-[13px] text-muted-foreground">
          Link your WhatsApp Business number through Meta&apos;s official Cloud
          API. A short guided setup tests your credentials against Meta before
          saving, so you know it works — then messages land in your triage queue.
        </p>
        <Link
          href="/whatsapp/connect"
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
        >
          <MessageCircle className="h-4 w-4" /> Connect a number
        </Link>
        <p className="mt-3 text-[11px] text-muted-foreground/70">
          Official Cloud API · business numbers only · ~15 minutes.
        </p>
      </div>
    </div>
  );
}
