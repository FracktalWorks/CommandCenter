"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Bot, Sparkles, RotateCcw } from "lucide-react";
import { ChatMessage } from "../lib/types";
import { QUICK_ACTIONS } from "../lib/mockData";

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "1",
    role: "assistant",
    content:
      "Hi! I'm your email assistant. I can help you manage your inbox, draft replies, find important emails, summarize threads, and automate repetitive tasks.\n\nTry one of the quick actions below, or just ask me anything.",
    timestamp: new Date(),
  },
];

// ── Simulated AI response (will be replaced by real streaming agent) ─────

function simulateResponse(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes("summarize") || lower.includes("summary")) {
    return "Here's a summary of your unread emails:\n\n• **Sarah Chen (Acme)** — Project kickoff meeting scheduled for Thursday at 2pm. Action required: confirm attendance.\n• **GitHub** — 3 pull request reviews pending on the design-system repo.\n• **Stripe** — Monthly invoice for $248 is ready to download.\n• **James at Legal** — NDA amendments sent for review, deadline is Friday.\n\nWould you like me to help you prioritize or respond to any of these?";
  }
  if (lower.includes("urgent") || lower.includes("important")) {
    return "Based on your inbox, these emails need attention today:\n\n🔴 **High priority**\n— NDA from Legal (James) — due Friday\n— PR review requests from the design team\n\n🟡 **Should respond soon**\n— Sarah's meeting confirmation\n— Client follow-up from last week's demo\n\nShall I draft responses for any of these?";
  }
  if (lower.includes("draft") || lower.includes("reply") || lower.includes("write")) {
    return "Sure! Here's a professional reply draft:\n\n---\nHi Sarah,\n\nThanks for the update. Thursday at 2pm works great for me — I've added it to my calendar.\n\nLooking forward to the kickoff. Let me know if there's anything I should prepare in advance.\n\nBest,\nAlex\n---\n\nWould you like me to adjust the tone or add any specific details?";
  }
  if (lower.includes("unsubscribe") || lower.includes("mailing")) {
    return "I found several newsletters you haven't opened in 30+ days:\n\n• ProductHunt Digest (last opened 45 days ago)\n• SaaStr Weekly (last opened 60 days ago)\n• The Hustle (never opened)\n• DataElixir (last opened 38 days ago)\n\nWould you like me to generate unsubscribe requests for any of these?";
  }
  if (lower.includes("follow-up") || lower.includes("followup")) {
    return "These conversations haven't had a reply in over 3 days:\n\n• **Dan Kim** — 'Quick sync this week?' (3 days ago)\n• **James Whitfield** — NDA review (today — but deadline is Friday)\n\nWould you like me to draft follow-up messages for any of these?";
  }
  return "Got it! I'll look into that for you. Based on what I can see in your inbox, I'd recommend starting with the most recent unread threads and working backwards. Is there a specific time period or sender you'd like me to focus on?";
}

export function AIChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const sendMessage = (text: string) => {
    if (!text.trim()) return;
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: text.trim(),
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);

    setTimeout(() => {
      const response = simulateResponse(text);
      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: response,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setIsTyping(false);
    }, 900 + Math.random() * 700);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const reset = () => setMessages(INITIAL_MESSAGES);

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
              <div className="flex gap-1 items-center">
                <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
                <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
                <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
              </div>
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
              onClick={() => sendMessage(action.prompt)}
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
