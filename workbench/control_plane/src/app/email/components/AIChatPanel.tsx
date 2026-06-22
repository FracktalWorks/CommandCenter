"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send, Bot, Sparkles, Plus, MessagesSquare, Trash2, X, Square,
  Search, Mail, PenLine, Archive, Tag, CheckCircle2, Loader2, Wrench,
  Settings2, ListChecks,
} from "lucide-react";
import { ChatMessage } from "../lib/types";
import { QUICK_ACTIONS } from "../lib/mockData";
import { streamAIChat, triggerQuickAction } from "../lib/api";
import { useEmailStore } from "../lib/emailStore";
import {
  EmailChatSession, StoredChatMessage, getSessions, createSession,
  deleteSession, getMessages, saveMessages, fetchActiveSessionIds,
} from "../lib/emailChatSessions";

interface AIChatPanelProps {
  selectedAccountId?: string | null;
  selectedEmailId?: string | null;
}

const GREETING =
  "Hi! I'm your email assistant. I can manage your inbox, draft replies, find " +
  "important emails, summarize threads, and set up your automation rules.\n\n" +
  "Try a quick action below, or just ask me anything.";

const toChat = (m: StoredChatMessage): ChatMessage => ({
  id: m.id,
  role: m.role,
  content: m.content,
  timestamp: new Date(m.timestamp),
});
const toStored = (m: ChatMessage): StoredChatMessage => ({
  id: m.id,
  role: m.role as "user" | "assistant",
  content: m.content,
  timestamp: m.timestamp instanceof Date ? m.timestamp.getTime() : Date.now(),
});

export function AIChatPanel({ selectedAccountId, selectedEmailId }: AIChatPanelProps) {
  const [sessions, setSessions] = useState<EmailChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  // AG-UI tool activity: live for the in-flight turn + a per-message archive.
  const [turnTools, setTurnTools] = useState<ChatToolEvent[]>([]);
  const turnToolsRef = useRef<ChatToolEvent[]>([]);
  const [toolsByMsg, setToolsByMsg] = useState<Record<string, ChatToolEvent[]>>({});
  /** Messages typed while a turn is streaming — sent in order once idle. */
  const [queued, setQueued] = useState<string[]>([]);
  const [showSessions, setShowSessions] = useState(false);
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The Assistant's "Fix" flow hands a correction prompt through the store;
  // drop it into the input (the user reviews & sends it).
  const pendingChatPrompt = useEmailStore((s) => s.pendingChatPrompt);
  const setPendingChatPrompt = useEmailStore((s) => s.setPendingChatPrompt);
  useEffect(() => {
    if (pendingChatPrompt) {
      setInput(pendingChatPrompt);
      setPendingChatPrompt(null);
    }
  }, [pendingChatPrompt, setPendingChatPrompt]);

  // Restore the most recent session (or start one) on mount.
  useEffect(() => {
    const list = getSessions();
    const active = list[0] ?? createSession();
    setSessions(getSessions());
    setSessionId(active.id);
    setMessages(getMessages(active.id).map(toChat));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping, streamingContent]);

  // Poll which sessions have an agent run in flight (background-aware).
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      fetchActiveSessionIds().then((ids) => !cancelled && setActiveIds(ids));
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const refreshSessions = () => setSessions(getSessions());

  const persist = useCallback(
    (id: string, msgs: ChatMessage[]) => {
      saveMessages(id, msgs.map(toStored));
      refreshSessions();
    },
    []
  );

  const switchSession = (id: string) => {
    abortRef.current?.abort();
    setSessionId(id);
    setMessages(getMessages(id).map(toChat));
    setShowSessions(false);
    setIsTyping(false);
    setStreamingContent("");
  };

  const newSession = () => {
    abortRef.current?.abort();
    const s = createSession();
    refreshSessions();
    setSessionId(s.id);
    setMessages([]);
    setShowSessions(false);
    setIsTyping(false);
    setStreamingContent("");
  };

  const removeSession = (id: string) => {
    deleteSession(id);
    const remaining = getSessions();
    setSessions(remaining);
    if (id === sessionId) {
      const next = remaining[0] ?? createSession();
      setSessions(getSessions());
      setSessionId(next.id);
      setMessages(getMessages(next.id).map(toChat));
      setIsTyping(false);
      setStreamingContent("");
    }
  };

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isTyping || !sessionId) return;

      const userMsg: ChatMessage = {
        id: Date.now().toString(),
        role: "user",
        content: text.trim(),
        timestamp: new Date(),
      };
      const updated = [...messages, userMsg];
      setMessages(updated);
      persist(sessionId, updated);
      setInput("");
      setIsTyping(true);
      setStreamingContent("");
      turnToolsRef.current = [];
      setTurnTools([]);

      const apiMessages = updated.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
      const controller = new AbortController();
      abortRef.current = controller;

      const finish = (assistantText: string, isError = false) => {
        const assistantMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: assistantText,
          timestamp: new Date(),
        };
        const tools = turnToolsRef.current;
        if (tools.length) {
          setToolsByMsg((prev) => ({ ...prev, [assistantMsg.id]: tools }));
        }
        const final = [...updated, assistantMsg];
        setMessages(final);
        if (!isError) persist(sessionId, final);
        else persist(sessionId, final);
        turnToolsRef.current = [];
        setTurnTools([]);
        setIsTyping(false);
        setStreamingContent("");
      };

      try {
        await streamAIChat(
          {
            messages: apiMessages,
            accountId: selectedAccountId ?? undefined,
            emailContextId: selectedEmailId ?? undefined,
            sessionId,
          },
          (event) => {
            if (event.type === "content" && event.content) {
              setStreamingContent((prev) => prev + event.content);
            } else if (event.type === "tool") {
              if (event.phase === "start") {
                const next = [
                  ...turnToolsRef.current,
                  { id: event.id || `${Date.now()}`, name: event.name || "tool", done: false },
                ];
                turnToolsRef.current = next;
                setTurnTools(next);
              } else if (event.phase === "result") {
                const next = turnToolsRef.current.map((t) =>
                  t.id === event.id
                    ? { ...t, done: true, result: event.result, success: event.success }
                    : t,
                );
                turnToolsRef.current = next;
                setTurnTools(next);
              }
            } else if (event.type === "done") {
              setStreamingContent((prev) => {
                if (prev || turnToolsRef.current.length) finish(prev);
                else setIsTyping(false);
                return "";
              });
            } else if (event.type === "error") {
              finish("Sorry, I ran into an error. Please try again.", true);
            }
          },
          controller.signal
        );
      } catch {
        if (!controller.signal.aborted) {
          finish("Sorry, I couldn't reach the assistant. Please try again.", true);
        } else {
          setIsTyping(false);
          setStreamingContent("");
        }
      }
    },
    [messages, isTyping, sessionId, selectedAccountId, selectedEmailId, persist]
  );

  const handleQuickAction = useCallback(
    async (actionLabel: string, _prompt: string, actionKey: string) => {
      if (isTyping || !sessionId) return;
      const userMsg: ChatMessage = {
        id: Date.now().toString(),
        role: "user",
        content: actionLabel,
        timestamp: new Date(),
      };
      const afterUser = [...messages, userMsg];
      setMessages(afterUser);
      persist(sessionId, afterUser);
      setIsTyping(true);
      try {
        const result = await triggerQuickAction(
          actionKey,
          selectedAccountId ?? undefined,
          selectedEmailId ?? undefined
        );
        const assistantMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: result.result || "Done!",
          timestamp: new Date(),
        };
        const final = [...afterUser, assistantMsg];
        setMessages(final);
        persist(sessionId, final);
      } catch {
        const errorMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: "Sorry, the quick action failed. Please try again.",
          timestamp: new Date(),
        };
        const final = [...afterUser, errorMsg];
        setMessages(final);
        persist(sessionId, final);
      }
      setIsTyping(false);
    },
    [isTyping, sessionId, messages, selectedAccountId, selectedEmailId, persist]
  );

  // Stop the in-flight turn (abort the stream), mirroring the main chat app.
  const stop = useCallback(() => {
    abortRef.current?.abort();
    setIsTyping(false);
    setStreamingContent("");
  }, []);

  // Drain the queue: when the assistant goes idle and messages are queued, send
  // the next one automatically (same UX as the main chat's send-while-busy).
  useEffect(() => {
    if (!isTyping && queued.length > 0 && sessionId) {
      const [next, ...rest] = queued;
      setQueued(rest);
      sendMessage(next);
    }
  }, [isTyping, queued, sessionId, sendMessage]);

  // Send if idle, otherwise queue the message to run after the current turn.
  const submit = useCallback(
    (text: string) => {
      if (!text.trim() || !sessionId) return;
      if (isTyping) {
        setQueued((q) => [...q, text.trim()]);
        setInput("");
        return;
      }
      sendMessage(text);
    },
    [isTyping, sessionId, sendMessage]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(input);
    }
  };

  return (
    <div className="flex flex-col h-full bg-sidebar text-sidebar-foreground overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-sidebar-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center">
            <Sparkles size={12} />
          </div>
          <span className="text-xs font-semibold text-sidebar-foreground">
            AI Assistant
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowSessions((v) => !v)}
            title="Chat history"
            className={`p-1 rounded transition-colors ${
              showSessions
                ? "text-primary bg-primary/10"
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent"
            }`}
          >
            <MessagesSquare size={14} />
          </button>
          <button
            onClick={newSession}
            title="New chat"
            className="p-1 rounded text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      {/* Sessions list */}
      {showSessions && (
        <div className="border-b border-sidebar-border bg-secondary/30 max-h-56 overflow-y-auto scrollbar-hide">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Conversations
            </span>
            <button
              onClick={() => setShowSessions(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          </div>
          {sessions.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              No conversations yet.
            </div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                  s.id === sessionId
                    ? "bg-primary/10"
                    : "hover:bg-secondary/60"
                }`}
                onClick={() => switchSession(s.id)}
              >
                {activeIds.has(s.id) ? (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"
                    title="Active — agent is working"
                  />
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-foreground truncate">
                    {s.title || "New conversation"}
                  </div>
                  {s.lastPreview && (
                    <div className="text-[10px] text-muted-foreground truncate">
                      {s.lastPreview}
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSession(s.id);
                  }}
                  title="Delete conversation"
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive flex-shrink-0"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto scrollbar-hide px-3 py-3 space-y-3">
        {messages.length === 0 && !isTyping && (
          <div className="flex gap-2">
            <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center flex-shrink-0 mt-0.5">
              <Bot size={12} />
            </div>
            <div className="max-w-[85%] rounded-xl rounded-tl-sm px-3 py-2 text-xs leading-relaxed bg-secondary text-foreground">
              <MessageContent content={GREETING} />
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
          >
            {msg.role === "assistant" && (
              <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center flex-shrink-0 mt-0.5">
                <Bot size={12} />
              </div>
            )}
            <div className="max-w-[85%] flex flex-col gap-1.5">
              {msg.role === "assistant" && toolsByMsg[msg.id]?.length > 0 && (
                <ToolCards events={toolsByMsg[msg.id]} />
              )}
              {msg.content && (
                <div
                  className={`rounded-xl px-3 py-2 text-xs leading-relaxed ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground rounded-tr-sm self-end"
                      : "bg-secondary text-foreground rounded-tl-sm"
                  }`}
                >
                  <MessageContent content={msg.content} />
                </div>
              )}
            </div>
          </div>
        ))}

        {isTyping && (
          <div className="flex gap-2">
            <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center flex-shrink-0">
              <Bot size={12} />
            </div>
            <div className="max-w-[85%] flex flex-col gap-1.5">
              {turnTools.length > 0 && <ToolCards events={turnTools} />}
              {(streamingContent || turnTools.length === 0) && (
                <div className="bg-secondary rounded-xl rounded-tl-sm px-3 py-2.5 w-fit">
                  {streamingContent ? (
                    <MessageContent content={streamingContent} />
                  ) : (
                    <div className="flex gap-1 items-center">
                      <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
                      <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
                      <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Quick actions */}
      <div className="px-3 pb-2 flex-shrink-0">
        <div className="flex flex-wrap gap-1.5">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              onClick={() => handleQuickAction(action.label, action.prompt, action.action)}
              className="text-[10px] px-2 py-1 rounded-full border border-sidebar-border text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-primary/10 transition-colors"
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>

      {/* Input */}
      <div className="px-3 pb-3 flex-shrink-0">
        <div className="flex items-end gap-2 bg-secondary rounded-xl px-3 py-2 border border-sidebar-border focus-within:border-primary/50 transition-colors">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your inbox..."
            rows={1}
            className="flex-1 bg-transparent outline-none text-xs text-foreground placeholder:text-muted-foreground resize-none min-h-[20px] max-h-[80px] leading-relaxed"
            style={{ height: "auto" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 80) + "px";
            }}
          />
          {isTyping ? (
            <button
              onClick={stop}
              title="Stop generating"
              className="p-1.5 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors flex-shrink-0"
            >
              <Square size={11} />
            </button>
          ) : (
            <button
              onClick={() => submit(input)}
              disabled={!input.trim()}
              className="p-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            >
              <Send size={11} />
            </button>
          )}
        </div>
        {queued.length > 0 && (
          <p className="text-center text-[9px] text-primary mt-1.5">
            {queued.length} message{queued.length > 1 ? "s" : ""} queued · will send when ready
          </p>
        )}
        <p className="text-center text-[9px] text-muted-foreground mt-1.5">
          {isTyping
            ? "Generating… press Stop to cancel · you can queue another message"
            : "Press Enter to send · Shift+Enter for new line"}
        </p>
      </div>
    </div>
  );
}

/** An AG-UI tool activity surfaced inline in the chat (search/read/draft/rule). */
export interface ChatToolEvent {
  id: string;
  name: string;
  done: boolean;
  result?: string;
  success?: boolean;
}

/** Friendly label + icon + present-tense verb for the email-assistant's tools. */
const TOOL_META: Record<
  string,
  { icon: React.ElementType; label: string; running: string }
> = {
  search_emails: { icon: Search, label: "Searched inbox", running: "Searching inbox…" },
  search_inbox: { icon: Search, label: "Searched inbox", running: "Searching inbox…" },
  read_email: { icon: Mail, label: "Read email", running: "Reading email…" },
  list_rules: { icon: ListChecks, label: "Listed rules", running: "Loading rules…" },
  create_rule: { icon: Sparkles, label: "Created rule", running: "Creating rule…" },
  update_rule: { icon: Sparkles, label: "Updated rule", running: "Updating rule…" },
  update_rule_state: { icon: Sparkles, label: "Updated rule", running: "Updating rule…" },
  learn_rule_pattern: { icon: Sparkles, label: "Taught a pattern", running: "Learning…" },
  draft_reply: { icon: PenLine, label: "Drafted a reply", running: "Drafting a reply…" },
  draft_email: { icon: PenLine, label: "Drafted an email", running: "Drafting…" },
  send_email: { icon: Send, label: "Sent email", running: "Sending…" },
  archive_emails: { icon: Archive, label: "Archived", running: "Archiving…" },
  archive_email: { icon: Archive, label: "Archived", running: "Archiving…" },
  label_emails: { icon: Tag, label: "Labelled", running: "Labelling…" },
  update_assistant_settings: { icon: Settings2, label: "Updated settings", running: "Updating settings…" },
};

function toolMeta(name: string) {
  return (
    TOOL_META[name] ?? {
      icon: Wrench,
      label: name.replace(/_/g, " "),
      running: `${name.replace(/_/g, " ")}…`,
    }
  );
}

/** Inline AG-UI cards showing what the assistant did this turn. */
function ToolCards({ events }: { events: ChatToolEvent[] }) {
  if (!events.length) return null;
  return (
    <div className="space-y-1.5">
      {events.map((e) => {
        const meta = toolMeta(e.name);
        const Icon = e.done ? (e.success === false ? X : CheckCircle2) : meta.icon;
        return (
          <div
            key={e.id}
            className="flex items-start gap-2 rounded-lg border border-sidebar-border bg-secondary/40 px-2.5 py-1.5"
          >
            <span
              className={`mt-0.5 flex-shrink-0 ${
                e.done
                  ? e.success === false
                    ? "text-destructive"
                    : "text-emerald-500"
                  : "text-primary"
              }`}
            >
              {e.done ? <Icon size={13} /> : <Loader2 size={13} className="animate-spin" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-foreground">
                {e.done ? meta.label : meta.running}
              </div>
              {e.done && e.result && (
                <div className="text-[10px] text-muted-foreground line-clamp-2 whitespace-pre-wrap">
                  {e.result}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={i} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i} style={{ whiteSpace: "pre-wrap" }}>
            {part}
          </span>
        )
      )}
    </>
  );
}
