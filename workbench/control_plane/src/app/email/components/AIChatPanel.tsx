"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Bot, Sparkles, RotateCcw } from "lucide-react";
import { ChatMessage } from "../lib/types";
import { QUICK_ACTIONS } from "../lib/mockData";
import { streamAIChat, triggerQuickAction } from "../lib/api";

interface AIChatPanelProps {
  selectedAccountId?: string | null;
  selectedEmailId?: string | null;
}

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "1",
    role: "assistant",
    content:
      "Hi! I'm your email assistant. I can help you manage your inbox, draft replies, find important emails, summarize threads, and automate repetitive tasks.\n\nTry one of the quick actions below, or just ask me anything.",
    timestamp: new Date(),
  },
];

export function AIChatPanel({ selectedAccountId, selectedEmailId }: AIChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping, streamingContent]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isTyping) return;

      const userMsg: ChatMessage = {
        id: Date.now().toString(),
        role: "user",
        content: text.trim(),
        timestamp: new Date(),
      };
      const updatedMessages = [...messages, userMsg];
      setMessages(updatedMessages);
      setInput("");
      setIsTyping(true);
      setStreamingContent("");

      // Build conversation history
      const apiMessages = updatedMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      try {
        await streamAIChat(
          {
            messages: apiMessages,
            accountId: selectedAccountId ?? undefined,
            emailContextId: selectedEmailId ?? undefined,
          },
          (event) => {
            if (event.type === "content" && event.content) {
              setStreamingContent((prev) => prev + event.content);
            } else if (event.type === "done") {
              setStreamingContent((prev) => {
                if (prev) {
                  const assistantMsg: ChatMessage = {
                    id: (Date.now() + 1).toString(),
                    role: "assistant",
                    content: prev,
                    timestamp: new Date(),
                  };
                  setMessages((msgs) => [...msgs, assistantMsg]);
                }
                return "";
              });
              setIsTyping(false);
            } else if (event.type === "error") {
              const errorMsg: ChatMessage = {
                id: (Date.now() + 1).toString(),
                role: "assistant",
                content: "Sorry, I ran into an error. Please try again.",
                timestamp: new Date(),
              };
              setMessages((msgs) => [...msgs, errorMsg]);
              setIsTyping(false);
              setStreamingContent("");
            }
          }
        );
      } catch {
        const errorMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: "Sorry, I couldn't reach the assistant. Please try again.",
          timestamp: new Date(),
        };
        setMessages((msgs) => [...msgs, errorMsg]);
        setIsTyping(false);
        setStreamingContent("");
      }
    },
    [messages, isTyping, selectedAccountId, selectedEmailId]
  );

  const handleQuickAction = useCallback(
    async (actionLabel: string, prompt: string, actionKey: string) => {
      if (isTyping) return;

      const userMsg: ChatMessage = {
        id: Date.now().toString(),
        role: "user",
        content: actionLabel,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsTyping(true);
      setStreamingContent("");

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
        setMessages((prev) => [...prev, assistantMsg]);
      } catch {
        const errorMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: "Sorry, the quick action failed. Please try again.",
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      }
      setIsTyping(false);
      setStreamingContent("");
    },
    [isTyping, selectedAccountId, selectedEmailId]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const reset = () => {
    abortRef.current?.abort();
    setMessages(INITIAL_MESSAGES);
    setIsTyping(false);
    setStreamingContent("");
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
          <span className="text-[9px] px-1.5 py-0.5 bg-primary/15 text-primary rounded-full">
            Beta
          </span>
        </div>
        <button
          onClick={reset}
          title="Clear conversation"
          className="p-1 rounded text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        >
          <RotateCcw size={13} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto scrollbar-hide px-3 py-3 space-y-3">
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
