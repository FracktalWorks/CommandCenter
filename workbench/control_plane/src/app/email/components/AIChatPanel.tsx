"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send, Bot, Sparkles, Plus, MessagesSquare, Trash2, X,
} from "lucide-react";
import { ChatMessage } from "../lib/types";
import { QUICK_ACTIONS } from "../lib/mockData";
import { streamAIChat, triggerQuickAction } from "../lib/api";
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
  const [showSessions, setShowSessions] = useState(false);
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

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
        const final = [...updated, assistantMsg];
        setMessages(final);
        if (!isError) persist(sessionId, final);
        else persist(sessionId, final);
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
            } else if (event.type === "done") {
              setStreamingContent((prev) => {
                if (prev) finish(prev);
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
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
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground rounded-tr-sm"
                  : "bg-secondary text-foreground rounded-tl-sm"
              }`}
            >
              <MessageContent content={msg.content} />
            </div>
          </div>
        ))}

        {isTyping && (
          <div className="flex gap-2">
            <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center flex-shrink-0">
              <Bot size={12} />
            </div>
            <div className="bg-secondary rounded-xl rounded-tl-sm px-3 py-2.5">
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
          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || isTyping}
            className="p-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            <Send size={11} />
          </button>
        </div>
        <p className="text-center text-[9px] text-muted-foreground mt-1.5">
          Press Enter to send · Shift+Enter for new line
        </p>
      </div>
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
