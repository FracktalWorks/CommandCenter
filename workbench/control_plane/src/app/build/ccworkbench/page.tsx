"use client";

/**
 * CC Workbench — developer chat interface for working on the CommandCenter repo.
 *
 * Uses the /api/ccworkbench/chat route which calls GitHub Copilot SDK directly
 * (no CC gateway, no MAF, no Postgres dependency). Safe to use even when the
 * main CC stack is down.
 *
 * Available tools: read_file, list_directory, git_status, git_diff,
 *                  run_tests, view_logs, trigger_deploy
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { Terminal, Send, RefreshCw, ChevronDown, ChevronUp, Trash2, Loader2 } from "lucide-react";
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
  "What's the current status of the orchestrator?",
  "Run all tests and summarise failures",
  "Show me git status",
  "View the last 30 lines of gateway logs",
];

// ── Tool row ─────────────────────────────────────────────────────────────────

function ToolRow({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const firstArg = Object.values(tc.args)[0];
  const hint = firstArg !== undefined ? String(firstArg).slice(0, 50) : "";

  return (
    <div className="border rounded-lg overflow-hidden text-xs mb-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/40 hover:bg-muted text-left"
      >
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            tc.status === "done"
              ? "bg-green-500"
              : tc.status === "error"
                ? "bg-destructive"
                : "bg-yellow-400 animate-pulse"
          }`}
        />
        <span className="font-medium text-foreground">{TOOL_LABELS[tc.name] ?? tc.name}</span>
        {hint && <span className="text-muted-foreground truncate max-w-[200px]">{hint}</span>}
        <span className="ml-auto shrink-0">
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
      </button>
      {expanded && tc.result && (
        <pre className="px-3 py-2 bg-background text-muted-foreground overflow-x-auto max-h-60 overflow-y-auto leading-relaxed">
          {tc.result}
        </pre>
      )}
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 bg-primary text-primary-foreground text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 max-w-[90%]">
      {/* Tool calls */}
      {message.toolCalls?.map((tc) => <ToolRow key={tc.id} tc={tc} />)}
      {/* Text content */}
      {message.content && (
        <div className="rounded-2xl rounded-bl-sm px-4 py-2.5 bg-muted text-sm">
          <MarkdownMessage content={message.content} sessionId="" />
        </div>
      )}
      {/* Thinking dot while awaiting first text */}
      {!message.content && (!message.toolCalls || message.toolCalls.every((t) => t.status !== "running")) && (
        <div className="flex gap-1 px-2 pt-1">
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Fetch configured models from the CC gateway (same source as main chat picker)
  useEffect(() => {
    fetch("/api/models/all")
      .then((r) => r.json())
      .then((data: { models: UnifiedModel[] }) => {
        const filtered = (data.models ?? []).filter((m) => m.runtime === "litellm");
        setModels(filtered);
        // Default to the first copilot model, then any litellm model
        const firstCopilot = filtered.find((m) => m.group.includes("Copilot"));
        const firstAny = filtered[0];
        const defaultModel = firstCopilot ?? firstAny;
        if (defaultModel) setModel(defaultModel.id);
      })
      .catch(() => {
        // Gateway unreachable — keep fallback model id
      })
      .finally(() => setModelsLoading(false));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = { id: assistantId, role: "assistant", content: "", toolCalls: [] };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setLoading(true);

    // Build the history to send (exclude the blank assistant placeholder)
    const history = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));

    try {
      const resp = await fetch("/api/ccworkbench/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, model }),
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
              const tc: ToolCall = { id: ev.id, name: ev.name, args: ev.args, status: "running" };
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
                  m.id === assistantId ? { ...m, content: `⚠ ${ev.content}` } : m,
                ),
              );
            }
          } catch {
            // malformed SSE line — skip
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: `⚠ ${msg}` } : m)),
      );
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, messages, model]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="border-b px-4 py-3 flex items-center gap-3 shrink-0">
        <Terminal className="w-5 h-5 text-primary shrink-0" />
        <div className="min-w-0">
          <h1 className="font-semibold text-sm leading-tight">CC Workbench</h1>
          <p className="text-xs text-muted-foreground leading-tight truncate">
            GitHub Copilot SDK · direct · no gateway dependency
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {modelsLoading ? (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          ) : (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="text-xs border rounded px-2 py-1 bg-background text-foreground max-w-[200px]"
            >
              {/* Group models by their group label */}
              {Array.from(new Set(models.map((m) => m.group))).map((group) => (
                <optgroup key={group} label={group}>
                  {models
                    .filter((m) => m.group === group)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                </optgroup>
              ))}
              {/* Fallback if models didn't load */}
              {models.length === 0 && (
                <option value="copilot/claude-sonnet">Claude Sonnet (Copilot)</option>
              )}
            </select>
          )}
          <button
            onClick={() => setMessages([])}
            title="Clear conversation"
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Messages ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
            <Terminal className="w-12 h-12 text-muted-foreground/30" />
            <div>
              <p className="font-semibold">CC Workbench</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                Direct GitHub Copilot SDK agent for developing CommandCenter. Reads files, runs
                tests, checks git, views logs, and can trigger deployments. Works independently of
                the CC gateway stack.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center mt-1">
              {STARTER_PROMPTS.map((s) => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="text-xs border rounded-full px-3 py-1.5 hover:bg-muted transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        <div ref={bottomRef} />
      </div>

      {/* ── Input ──────────────────────────────────────────────────── */}
      <div className="border-t px-4 py-3 shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about the codebase, run tests, deploy…  Ctrl+Enter to send"
            rows={2}
            disabled={loading}
            className="flex-1 resize-none border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-60"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="p-2.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90 transition-opacity shrink-0"
          >
            {loading ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1.5">
          Tools: read_file · list_directory · git_status · git_diff · run_tests · view_logs ·
          trigger_deploy
        </p>
      </div>
    </div>
  );
}
