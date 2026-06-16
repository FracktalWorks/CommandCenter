"use client";

/**
 * CC Workbench — developer chat interface for working on the CommandCenter repo.
 *
 * Uses the /api/ccworkbench/chat route which calls the CC gateway LiteLLM endpoint
 * directly — no MAF, no Postgres dependency for the chat itself.
 *
 * UI matches the main AgentChat design system: same tokens, same component shapes.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { Terminal, Send, Square, ChevronDown, ChevronUp, Loader2, Trash2 } from "lucide-react";
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
  list_directory: "List directory",
  git_status: "Git status",
  git_diff: "Git diff",
  run_tests: "Run tests",
  view_logs: "View logs",
  trigger_deploy: "Deploy",
};

const STARTER_PROMPTS = [
  "What's the current git status?",
  "Run the unit tests and summarise failures",
  "Show me the orchestrator executor code",
  "View the last 30 lines of gateway logs",
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
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            tc.status === "done"
              ? "bg-success"
              : tc.status === "error"
                ? "bg-destructive"
                : "bg-warning animate-pulse"
          }`}
        />
        <span className="font-medium text-foreground">{TOOL_LABELS[tc.name] ?? tc.name}</span>
        {hint && (
          <span className="text-muted-foreground truncate max-w-[240px] font-mono text-[10px]">
            {hint}
          </span>
        )}
        <span className="ml-auto shrink-0 text-muted-foreground">
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
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
  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

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

  // Assistant message
  return (
    <div className="animate-fade-in">
      {/* Tool calls first */}
      {message.toolCalls?.map((tc) => <ToolRow key={tc.id} tc={tc} />)}
      {/* Content */}
      {message.content ? (
        <MarkdownMessage content={message.content} streaming={message.streaming} sessionId="" />
      ) : (
        // Thinking dots — no tool running, waiting for first token
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

// ── Model picker ──────────────────────────────────────────────────────────────

function ModelPicker({
  model,
  models,
  loading,
  onChange,
}: {
  model: string;
  models: UnifiedModel[];
  loading: boolean;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = models.find((m) => m.id === model)?.label ?? model;
  const groups = Array.from(new Set(models.map((m) => m.group)));

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (loading) return <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground border border-border rounded-md px-2 py-1 bg-secondary/50 hover:bg-secondary tech-transition"
      >
        <span className="truncate max-w-[140px]">{label}</span>
        <ChevronDown className="w-3 h-3 shrink-0" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[220px] rounded-xl border border-border bg-popover shadow-xl overflow-hidden">
          <div className="max-h-72 overflow-y-auto scrollbar-thin py-1">
            {groups.map((group) => (
              <div key={group}>
                <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
                  {group}
                </div>
                {models
                  .filter((m) => m.group === group)
                  .map((m) => (
                    <button
                      key={m.id}
                      onClick={() => { onChange(m.id); setOpen(false); }}
                      className={`w-full text-left px-3 py-1.5 text-[12px] tech-transition ${
                        m.id === model
                          ? "bg-primary/15 text-primary"
                          : "text-foreground hover:bg-secondary"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
              </div>
            ))}
            {models.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-muted-foreground">No models available</div>
            )}
          </div>
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
  const [modelsLoading, setModelsLoading] = useState(true);
  const threadRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isNearBottomRef = useRef(true);

  // Track scroll position for auto-scroll
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      isNearBottomRef.current = dist < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Fetch models from the same source as main chat
  useEffect(() => {
    fetch("/api/models/all")
      .then((r) => r.json())
      .then((data: { models: UnifiedModel[] }) => {
        const litellm = (data.models ?? []).filter((m) => m.runtime === "litellm");
        setModels(litellm);
        const firstCopilot = litellm.find((m) => m.group.toLowerCase().includes("copilot"));
        if (firstCopilot ?? litellm[0]) setModel((firstCopilot ?? litellm[0]).id);
      })
      .catch(() => {})
      .finally(() => setModelsLoading(false));
  }, []);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
    // Seal any streaming message
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    );
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      toolCalls: [],
      streaming: true,
      timestamp: Date.now(),
    };

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
        body: JSON.stringify({ messages: history, model }),
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(errText || `HTTP ${resp.status}`);
      }

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
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + ev.content } : m,
                ),
              );
            } else if (ev.type === "tool_start") {
              const tc: ToolCall = { id: ev.id, name: ev.name, args: ev.args ?? {}, status: "running" };
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, toolCalls: [...(m.toolCalls ?? []), tc] } : m,
                ),
              );
            } else if (ev.type === "tool_end") {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantId) return m;
                  return {
                    ...m,
                    toolCalls: (m.toolCalls ?? []).map((t) =>
                      t.id === ev.id
                        ? { ...t, result: ev.result, status: ev.success ? ("done" as const) : ("error" as const) }
                        : t,
                    ),
                  };
                }),
              );
            } else if (ev.type === "error") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: `⚠ ${ev.content}`, streaming: false }
                    : m,
                ),
              );
            }
          } catch {
            // malformed SSE line — skip
          }
        }
      }
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: `⚠ ${msg}`, streaming: false } : m,
        ),
      );
    } finally {
      setLoading(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
      );
      inputRef.current?.focus();
    }
  }, [input, loading, messages, model]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-full bg-background">

      {/* ── VS Code-style header bar ───────────────────────────────── */}
      <div className="flex items-center gap-2 h-9 px-4 border-b border-border bg-card/40 shrink-0">
        <div className={`w-2 h-2 rounded-full shrink-0 ${loading ? "bg-warning animate-pulse" : "bg-success"}`} />
        <Terminal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-foreground truncate">cc-workbench</span>
        {loading && (
          <span className="hidden sm:inline text-[10px] text-warning/70 animate-pulse">running…</span>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <ModelPicker
            model={model}
            models={models}
            loading={modelsLoading}
            onChange={setModel}
          />
          <button
            onClick={() => { setMessages([]); }}
            title="Clear conversation"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Message thread ─────────────────────────────────────────── */}
      <div ref={threadRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 scrollbar-thin">
        <div className="max-w-3xl mx-auto space-y-5">

          {/* Empty state */}
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3 text-center">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center tech-glow">
                <Terminal className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold text-foreground">CC Workbench</p>
                <p className="text-sm text-muted-foreground mt-1 max-w-md leading-relaxed">
                  Direct developer chat for CommandCenter. Reads files, runs tests, checks git,
                  views logs, and can trigger deployments. Works independently of the CC gateway stack.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center mt-1">
                {STARTER_PROMPTS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setInput(s)}
                    className="text-xs border border-border rounded-full px-3 py-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Input area ─────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-border bg-card/40 px-3 sm:px-4 pt-2 pb-3">
        <div className="max-w-3xl mx-auto">
          <div className="rounded-2xl border border-border bg-secondary/50 focus-within:border-primary/40 tech-transition">
            <div className="flex items-end gap-2 px-3 pt-2 pb-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={loading ? "Running… (Enter to send follow-up)" : "Message cc-workbench…"}
                rows={1}
                className="flex-1 resize-none bg-transparent px-1 py-1.5 text-[16px] sm:text-sm text-foreground placeholder-muted-foreground focus:outline-none max-h-40 overflow-y-auto scrollbar-thin"
                style={{ minHeight: "32px" }}
                onInput={(e) => {
                  const t = e.currentTarget;
                  t.style.height = "auto";
                  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
                }}
              />
              {loading ? (
                <button
                  type="button"
                  onClick={stopGeneration}
                  className="h-8 w-8 rounded-lg bg-secondary border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/80 tech-transition shrink-0 self-end"
                  title="Stop generation"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={sendMessage}
                  disabled={!input.trim()}
                  className="h-8 w-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-30 hover:opacity-90 tech-transition shrink-0 self-end"
                  title="Send (Enter)"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between mt-1.5 px-0.5">
            <span className="text-[10px] text-muted-foreground/50">
              Enter to send · Shift+Enter for new line
            </span>
            <span className="text-[10px] text-muted-foreground/40">
              read_file · git · run_tests · view_logs · deploy
            </span>
          </div>
        </div>
      </div>

    </div>
  );
}


// ── Types ────────────────────────────────────────────────────────────────────

