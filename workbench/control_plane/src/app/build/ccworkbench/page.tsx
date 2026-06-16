"use client";

/**
 * CC Workbench — developer chat for CommandCenter.
 * UI is an exact replica of AgentChat: model picker + thinking mode inside the
 * bottom input pill, VS Code-style minimal header, same token classes throughout.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { Terminal, Trash2 } from "lucide-react";
import MarkdownMessage from "@/components/MarkdownMessage";
import type { UnifiedModel } from "@/app/api/models/all/route";

// ── Types ────────────────────────────────────────────────────────────────────

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: "running" | "done" | "error";
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  streaming?: boolean;
  timestamp: number;
}

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read file",
  write_file: "Write file",
  list_directory: "List directory",
  search_code: "Search code",
  git_status: "Git status",
  git_diff: "Git diff",
  git_commit: "Git commit",
  run_command: "Run command",
  run_tests: "Run tests",
  view_logs: "View logs",
  trigger_deploy: "Deploy",
};

const STARTER_PROMPTS = [
  "What's the current git status?",
  "Run the unit tests and summarise failures",
  "Search for all uses of run_agent_stream",
  "View the last 50 lines of gateway logs",
];

type ThinkMode = "auto" | "thinking" | "max";
const THINK_MODES: { mode: ThinkMode; label: string; title: string }[] = [
  { mode: "auto",     label: "Auto",    title: "Let the model decide" },
  { mode: "thinking", label: "Thinking", title: "Enable chain-of-thought reasoning" },
  { mode: "max",      label: "Max",     title: "Maximum effort / deeper reasoning" },
];

// ── Tool row ─────────────────────────────────────────────────────────────────

function ToolRow({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const firstArg = Object.values(tc.args)[0];
  const hint = firstArg !== undefined ? String(firstArg).slice(0, 60) : "";

  return (
    <div className="rounded-xl border border-border bg-card/60 overflow-hidden text-xs mb-1.5 tech-transition">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-secondary/60 text-left tech-transition"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${
          tc.status === "done" ? "bg-success" : tc.status === "error" ? "bg-destructive" : "bg-warning animate-pulse"
        }`} />
        <span className="font-medium text-foreground">{TOOL_LABELS[tc.name] ?? tc.name}</span>
        {hint && <span className="text-muted-foreground truncate max-w-[240px] font-mono text-[10px]">{hint}</span>}
        <span className="ml-auto shrink-0 text-muted-foreground text-[10px]">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && tc.result && (
        <pre className="px-3 py-2.5 border-t border-border bg-background text-muted-foreground overflow-x-auto max-h-64 overflow-y-auto leading-relaxed text-[11px] scrollbar-thin">
          {tc.result}
        </pre>
      )}
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  const timestamp = new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (message.role === "user") {
    return (
      <div className="flex justify-end animate-fade-in">
        <div className="max-w-[88%] sm:max-w-[78%]">
          <div className="px-4 py-2.5 text-[13px] sm:text-sm leading-relaxed bg-primary/15 text-foreground rounded-2xl rounded-tr-md">
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          </div>
          <div className="flex items-center justify-end mt-1 pr-0.5">
            <span className="text-[10px] text-muted-foreground">{timestamp}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {message.toolCalls?.map((tc) => <ToolRow key={tc.id} tc={tc} />)}
      {message.content ? (
        <MarkdownMessage content={message.content} streaming={message.streaming} sessionId="" />
      ) : (
        !message.toolCalls?.some((t) => t.status === "running") && (
          <div className="flex gap-1 px-1 py-2">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
          </div>
        )
      )}
      {!message.streaming && message.content && (
        <div className="mt-1">
          <span className="text-[10px] text-muted-foreground">{timestamp}</span>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CCWorkbenchPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("copilot/claude-sonnet");
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [thinkMode, setThinkMode] = useState<ThinkMode>("auto");
  const [gatewayDown, setGatewayDown] = useState(false);

  // Model menu state
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showThinkMenu, setShowThinkMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isNearBottomRef = useRef(true);

  // Close model menu on outside click
  useEffect(() => {
    if (!showModelMenu && !showThinkMenu) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
        setShowThinkMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModelMenu, showThinkMenu]);

  // Track scroll for auto-scroll
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = () => {
      isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (isNearBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Fetch models from the same source as main chat
  useEffect(() => {
    fetch("/api/models/all")
      .then((r) => r.json())
      .then((data: { models: UnifiedModel[] }) => {
        const litellm = (data.models ?? []).filter((m) => m.runtime === "litellm");
        setModels(litellm);
        const firstCopilot = litellm.find((m) => m.group.toLowerCase().includes("copilot"));
        const first = firstCopilot ?? litellm[0];
        if (first) setModel(first.id);
      })
      .catch(() => {});
  }, []);

  const currentModelLabel = models.find((m) => m.id === model)?.label ?? model;
  const modelGroups = Array.from(new Set(models.map((m) => m.group)));

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text, timestamp: Date.now() };
    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = { id: assistantId, role: "assistant", content: "", toolCalls: [], streaming: true, timestamp: Date.now() };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setLoading(true);

    const history = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await fetch("/api/ccworkbench/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, model, thinkMode }),
        signal: ctrl.signal,
      });

      if (!resp.ok) throw new Error((await resp.text()) || `HTTP ${resp.status}`);

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          try {
            const ev = JSON.parse(raw);
            if (ev.type === "delta") {
              setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: m.content + ev.content } : m));
            } else if (ev.type === "tool_start") {
              const tc: ToolCall = { id: ev.id, name: ev.name, args: ev.args ?? {}, status: "running" };
              setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, toolCalls: [...(m.toolCalls ?? []), tc] } : m));
            } else if (ev.type === "tool_end") {
              setMessages((prev) => prev.map((m) => {
                if (m.id !== assistantId) return m;
                return { ...m, toolCalls: (m.toolCalls ?? []).map((t) =>
                  t.id === ev.id ? { ...t, result: ev.result, status: ev.success ? ("done" as const) : ("error" as const) } : t) };
              }));
            } else if (ev.type === "gateway_down") {
              setGatewayDown(true);
            } else if (ev.type === "error") {
              setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: `⚠ ${ev.content}`, streaming: false } : m));
            }
          } catch { /* malformed SSE */ }
        }
      }
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: `⚠ ${msg}`, streaming: false } : m));
    } finally {
      setLoading(false);
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, streaming: false } : m));
      inputRef.current?.focus();
    }
  }, [input, loading, messages, model, thinkMode]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  return (
    <div className="flex flex-col h-full bg-background">

      {/* ── VS Code-style minimal header bar ─────────────────────── */}
      <div className="flex items-center gap-2 h-9 px-4 border-b border-border bg-card/40 shrink-0">
        <div className={`w-2 h-2 rounded-full shrink-0 ${loading ? "bg-warning animate-pulse" : "bg-success"}`} />
        <Terminal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-foreground truncate">cc-workbench</span>
        {loading && <span className="hidden sm:inline text-[10px] text-warning/70 animate-pulse">running…</span>}
        <div className="ml-auto">
          <button
            onClick={() => setMessages([])}
            title="Clear conversation"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Gateway-down fallback banner */}
      {gatewayDown && (
        <div className="shrink-0 border-b border-warning/20 bg-warning/5 px-4 py-1.5 flex items-center gap-2 text-[11px]">
          <span className="text-warning">⚡</span>
          <span className="text-warning/80">CC gateway unreachable — using direct GitHub Copilot API. All tools still work.</span>
          <button onClick={() => setGatewayDown(false)} className="ml-auto w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition">✕</button>
        </div>
      )}

      {/* ── Message thread ─────────────────────────────────────────── */}
      <div ref={threadRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 scrollbar-thin">
        <div className="max-w-3xl mx-auto space-y-5">

          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3 text-center">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center tech-glow">
                <Terminal className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold text-foreground">CC Workbench</p>
                <p className="text-sm text-muted-foreground mt-1 max-w-md leading-relaxed">
                  Direct developer chat for CommandCenter. Reads and writes files, searches code,
                  runs shell commands, tests, git operations, views logs, and deploys.
                  Falls back to direct GitHub Copilot when the CC gateway is down.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center mt-1">
                {STARTER_PROMPTS.map((s) => (
                  <button key={s} onClick={() => setInput(s)}
                    className="text-xs border border-border rounded-full px-3 py-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Input area — exact AgentChat layout ───────────────────── */}
      <div className="shrink-0 border-t border-border bg-card/40 px-3 sm:px-4 pt-2 pb-3">
        <div className="max-w-3xl mx-auto">
          <div className="rounded-2xl border border-border bg-secondary/50 focus-within:border-primary/40 tech-transition">

            {/* Row 1: textarea + send/stop button */}
            <div className="flex items-end gap-2 px-2 pt-2 pb-1">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder={loading ? "Running… (⏎ to follow up)" : "Message cc-workbench…"}
                className="flex-1 resize-none bg-transparent px-1 py-1.5 text-[16px] sm:text-sm text-foreground placeholder-muted-foreground focus:outline-none max-h-40 overflow-y-auto scrollbar-thin"
                style={{ minHeight: "32px" }}
                onInput={(e) => {
                  const t = e.currentTarget;
                  t.style.height = "auto";
                  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
                }}
              />
              {loading ? (
                <button type="button" onClick={stopGeneration}
                  className="shrink-0 self-end w-8 h-8 rounded-lg bg-destructive/20 border border-destructive/40 text-destructive text-xs flex items-center justify-center hover:bg-destructive/30 tech-transition"
                  title="Stop generation">■</button>
              ) : (
                <button type="button" onClick={sendMessage} disabled={!input.trim()}
                  className="shrink-0 self-end w-8 h-8 rounded-lg bg-primary text-primary-foreground font-semibold text-sm flex items-center justify-center disabled:opacity-25 disabled:cursor-not-allowed hover:opacity-90 tech-transition"
                  title="Send (Enter)">↑</button>
              )}
            </div>

            {/* Row 2: model picker + thinking mode — inside the pill, exact AgentChat style */}
            <div className="flex items-center gap-1 px-2 pb-1.5 text-[11px] text-muted-foreground" ref={modelMenuRef}>

              {/* Model selector */}
              <div className="relative">
                <button onClick={() => { setShowModelMenu((v) => !v); setShowThinkMenu(false); }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-secondary hover:text-foreground tech-transition truncate max-w-[140px] sm:max-w-[180px]">
                  <span className="truncate">{currentModelLabel}</span>
                  <span className="text-muted-foreground/50 shrink-0">▾</span>
                </button>
                {showModelMenu && (
                  <div className="absolute bottom-full left-0 mb-1.5 w-72 rounded-lg border border-border bg-popover shadow-2xl z-50 overflow-hidden">
                    <div className="max-h-72 overflow-y-auto py-1 scrollbar-thin">
                      {modelGroups.map((group) => (
                        <div key={group}>
                          <div className="px-3 pt-2 pb-1 text-[9px] text-muted-foreground/60 uppercase tracking-wider font-semibold">{group}</div>
                          {models.filter((m) => m.group === group).map((m) => (
                            <button key={m.id}
                              onClick={() => { setModel(m.id); setShowModelMenu(false); }}
                              className={`w-full text-left px-3 py-1.5 text-xs tech-transition flex items-center justify-between gap-2 ${m.id === model ? "text-foreground bg-secondary/60" : "text-muted-foreground hover:bg-secondary"}`}>
                              <span className="truncate">{m.label}</span>
                              {m.id === model && <span className="text-emerald-400 text-[10px] shrink-0">✓</span>}
                            </button>
                          ))}
                        </div>
                      ))}
                      {models.length === 0 && (
                        <div className="px-3 py-2 text-xs text-muted-foreground">No models — gateway unreachable</div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <span className="w-px h-3.5 bg-secondary/60 shrink-0" />

              {/* Thinking mode */}
              <div className="relative">
                <button type="button"
                  onClick={() => { setShowThinkMenu((v) => !v); setShowModelMenu(false); }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-secondary hover:text-foreground tech-transition text-muted-foreground"
                  title={THINK_MODES.find((t) => t.mode === thinkMode)?.title}>
                  <span>{THINK_MODES.find((t) => t.mode === thinkMode)?.label ?? "Auto"}</span>
                  <span className="text-muted-foreground/50 text-[9px]">▾</span>
                </button>
                {showThinkMenu && (
                  <div className="absolute bottom-full left-0 mb-1.5 w-44 rounded-lg border border-border bg-popover shadow-xl z-50 py-1"
                    onMouseLeave={() => setShowThinkMenu(false)}>
                    {THINK_MODES.map((tm) => (
                      <button key={tm.mode} type="button"
                        onClick={() => { setThinkMode(tm.mode); setShowThinkMenu(false); }}
                        className={`w-full text-left px-3 py-2 text-xs hover:bg-secondary tech-transition ${thinkMode === tm.mode ? "text-foreground bg-secondary/60" : "text-muted-foreground"}`}>
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-medium">{tm.label}</span>
                          {thinkMode === tm.mode && <span className="text-emerald-400 text-[10px]">✓</span>}
                        </div>
                        <div className="text-muted-foreground mt-0.5 text-[10px]">{tm.title}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="ml-auto hidden sm:block">
                <span className="text-[10px] text-muted-foreground/50">
                  <kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> newline
                </span>
              </div>
            </div>

          </div>

          <p className="text-[9px] text-muted-foreground/50 text-center mt-1.5">
            CC Workbench can make mistakes. Always verify important changes before committing.
          </p>
        </div>
      </div>

    </div>
  );
}
