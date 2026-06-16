"use client";

/**
 * CC Workbench — developer chat for CommandCenter.
 *
 * Session management: localStorage only (cc-workbench-sessions / cc-workbench-msgs-{id}).
 * No Postgres — this is a developer tool, browser-local persistence is sufficient.
 * Sessions survive page refresh and are listed in a slim left panel.
 * Auto-title from the first user message.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Terminal, Trash2, Plus, MessageSquare } from "lucide-react";
import MarkdownMessage from "@/components/MarkdownMessage";
import type { UnifiedModel } from "@/app/api/models/all/route";

// ── Storage keys ──────────────────────────────────────────────────────────────

const SESSIONS_KEY = "cc-workbench-sessions";
const msgKey = (id: string) => `cc-workbench-msgs-${id}`;

// ── Types ──────────────────────────────────────────────────────────────────────

interface WBSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

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
  git_push: "Git push → CI/CD",
  github_workflow_runs: "Check pipeline",
  github_workflow_logs: "Pipeline logs",
  run_command: "Run command",
  run_tests: "Run tests",
  view_logs: "View logs",
  trigger_deploy: "Emergency deploy",
};

const STARTER_PROMPTS = [
  "What's the current git status?",
  "Run the unit tests and summarise failures",
  "Search for all uses of run_agent_stream",
  "Check the latest CI/CD pipeline status",
];

type ThinkMode = "auto" | "thinking" | "max";
const THINK_MODES: { mode: ThinkMode; label: string; title: string }[] = [
  { mode: "auto",     label: "Auto",     title: "Let the model decide" },
  { mode: "thinking", label: "Thinking", title: "Enable chain-of-thought reasoning" },
  { mode: "max",      label: "Max",      title: "Maximum effort / deeper reasoning" },
];

// ── Session helpers ───────────────────────────────────────────────────────────

function loadSessions(): WBSession[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "[]"); } catch { return []; }
}

function saveSessions(sessions: WBSession[]) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

function loadMessages(sessionId: string): Message[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(msgKey(sessionId)) ?? "[]"); } catch { return []; }
}

function saveMessages(sessionId: string, messages: Message[]) {
  const settled = messages.filter((m) => !m.streaming || m.content.trim().length > 0);
  localStorage.setItem(msgKey(sessionId), JSON.stringify(settled));
}

function newSession(): WBSession {
  return { id: crypto.randomUUID(), title: "New session", createdAt: Date.now(), updatedAt: Date.now() };
}

function truncate(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// ── Tool row ──────────────────────────────────────────────────────────────────

function ToolRow({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const firstArg = Object.values(tc.args)[0];
  const hint = firstArg !== undefined ? String(firstArg).slice(0, 60) : "";
  return (
    <div className="rounded-xl border border-border bg-card/60 overflow-hidden text-xs mb-1.5 tech-transition">
      <button onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-secondary/60 text-left tech-transition">
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
        <div className="mt-1"><span className="text-[10px] text-muted-foreground">{timestamp}</span></div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CCWorkbenchPage() {
  // ── Session state ──────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<WBSession[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);

  // Bootstrap from localStorage on mount
  useEffect(() => {
    let stored = loadSessions();
    if (stored.length === 0) {
      const s = newSession();
      stored = [s];
      saveSessions(stored);
    }
    setSessions(stored);
    setActiveId(stored[0].id);
    setMessages(loadMessages(stored[0].id));
  }, []);

  // Persist messages whenever they change
  useEffect(() => {
    if (!activeId) return;
    saveMessages(activeId, messages);
  }, [messages, activeId]);

  // Switch session
  const switchSession = useCallback((id: string) => {
    if (id === activeId) return;
    setActiveId(id);
    setMessages(loadMessages(id));
    setInput("");
  }, [activeId]);

  // Create new session
  const createSession = useCallback(() => {
    const s = newSession();
    setSessions((prev) => { const next = [s, ...prev]; saveSessions(next); return next; });
    setActiveId(s.id);
    setMessages([]);
    setInput("");
  }, []);

  // Delete session
  const deleteSession = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    localStorage.removeItem(msgKey(id));
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveSessions(next);
      if (id === activeId) {
        if (next.length === 0) {
          const s = newSession();
          saveSessions([s]);
          setActiveId(s.id);
          setMessages([]);
          return [s];
        }
        setActiveId(next[0].id);
        setMessages(loadMessages(next[0].id));
      }
      return next;
    });
  }, [activeId]);

  // Auto-title from first user message (set once, never overwritten)
  const titledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeId || titledRef.current.has(activeId)) return;
    const first = messages.find((m) => m.role === "user" && m.content.trim());
    if (!first) return;
    titledRef.current.add(activeId);
    const title = truncate(first.content, 50);
    setSessions((prev) => {
      const next = prev.map((s) => s.id === activeId && s.title === "New session" ? { ...s, title, updatedAt: Date.now() } : s);
      saveSessions(next);
      return next;
    });
  }, [messages, activeId]);

  // ── Chat state ─────────────────────────────────────────────────────────────
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("copilot/claude-sonnet");
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [thinkMode, setThinkMode] = useState<ThinkMode>("auto");
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showThinkMenu, setShowThinkMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isNearBottomRef = useRef(true);

  // Close menus on outside click
  useEffect(() => {
    if (!showModelMenu && !showThinkMenu) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false); setShowThinkMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModelMenu, showThinkMenu]);

  // Scroll tracking
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = () => { isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (isNearBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Fetch models
  useEffect(() => {
    fetch("/api/models/all")
      .then((r) => r.json())
      .then((data: { models: UnifiedModel[] }) => {
        const litellm = (data.models ?? []).filter((m) => m.runtime === "litellm");
        setModels(litellm);
        const first = litellm.find((m) => m.group.toLowerCase().includes("copilot")) ?? litellm[0];
        if (first) setModel(first.id);
      })
      .catch(() => {});
  }, []);

  const currentModelLabel = useMemo(() => models.find((m) => m.id === model)?.label ?? model, [models, model]);
  const modelGroups = useMemo(() => Array.from(new Set(models.map((m) => m.group))), [models]);

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

    // Touch session updatedAt
    setSessions((prev) => { const next = prev.map((s) => s.id === activeId ? { ...s, updatedAt: Date.now() } : s); saveSessions(next); return next; });

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
  }, [input, loading, messages, model, thinkMode, activeId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const activeSession = sessions.find((s) => s.id === activeId);

  return (
    <div className="flex h-full bg-background overflow-hidden">

      {/* ── Sessions sidebar ──────────────────────────────────────── */}
      <div className="hidden sm:flex flex-col w-52 shrink-0 border-r border-border bg-card/30">
        {/* Sidebar header */}
        <div className="flex items-center gap-2 h-9 px-3 border-b border-border shrink-0">
          <Terminal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex-1 truncate">Workbench</span>
          <button onClick={createSession} title="New session"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition shrink-0">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
        {/* Session list */}
        <div className="flex-1 overflow-y-auto scrollbar-thin py-1">
          {sessions.map((s) => (
            <div key={s.id} onClick={() => switchSession(s.id)}
              className={`group flex items-start gap-2 px-3 py-2 cursor-pointer tech-transition ${
                s.id === activeId
                  ? "bg-primary/10 border-r-2 border-primary"
                  : "hover:bg-secondary/60"
              }`}>
              <MessageSquare className={`w-3 h-3 shrink-0 mt-0.5 ${s.id === activeId ? "text-primary" : "text-muted-foreground"}`} />
              <span className={`flex-1 text-[11px] leading-snug truncate ${s.id === activeId ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                {s.title}
              </span>
              <button onClick={(e) => deleteSession(s.id, e)} title="Delete"
                className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground/60 hover:text-destructive tech-transition">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Main chat area ────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0">

        {/* VS Code-style header bar */}
        <div className="flex items-center gap-2 h-9 px-4 border-b border-border bg-card/40 shrink-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${loading ? "bg-warning animate-pulse" : "bg-success"}`} />
          <span className="text-xs font-medium text-foreground truncate">
            {activeSession?.title ?? "cc-workbench"}
          </span>
          {loading && <span className="hidden sm:inline text-[10px] text-warning/70 animate-pulse">running…</span>}
          {/* Mobile: new session */}
          <div className="ml-auto sm:hidden">
            <button onClick={createSession} title="New session"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Message thread */}
        <div ref={threadRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 scrollbar-thin">
          <div className="max-w-3xl mx-auto space-y-5">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3 text-center">
                <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center tech-glow">
                  <Terminal className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="font-semibold text-foreground">CC Workbench</p>
                  <p className="text-sm text-muted-foreground mt-1 max-w-sm leading-relaxed">
                    Developer chat for CommandCenter. Reads and writes files, searches code,
                    runs shell commands, manages git, deploys via CI/CD.
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

        {/* Input area */}
        <div className="shrink-0 border-t border-border bg-card/40 px-3 sm:px-4 pt-2 pb-3">
          <div className="max-w-3xl mx-auto">
            <div className="rounded-2xl border border-border bg-secondary/50 focus-within:border-primary/40 tech-transition">

              {/* Row 1: textarea + send/stop */}
              <div className="flex items-end gap-2 px-2 pt-2 pb-1">
                <textarea ref={inputRef} value={input}
                  onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} rows={1}
                  placeholder={loading ? "Running… (⏎ to follow up)" : "Message cc-workbench…"}
                  className="flex-1 resize-none bg-transparent px-1 py-1.5 text-[16px] sm:text-sm text-foreground placeholder-muted-foreground focus:outline-none max-h-40 overflow-y-auto scrollbar-thin"
                  style={{ minHeight: "32px" }}
                  onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }}
                />
                {loading ? (
                  <button type="button" onClick={stopGeneration}
                    className="shrink-0 self-end w-8 h-8 rounded-lg bg-destructive/20 border border-destructive/40 text-destructive text-xs flex items-center justify-center hover:bg-destructive/30 tech-transition"
                    title="Stop">■</button>
                ) : (
                  <button type="button" onClick={sendMessage} disabled={!input.trim()}
                    className="shrink-0 self-end w-8 h-8 rounded-lg bg-primary text-primary-foreground font-semibold text-sm flex items-center justify-center disabled:opacity-25 disabled:cursor-not-allowed hover:opacity-90 tech-transition"
                    title="Send (Enter)">↑</button>
                )}
              </div>

              {/* Row 2: model picker + thinking mode */}
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
                              <button key={m.id} onClick={() => { setModel(m.id); setShowModelMenu(false); }}
                                className={`w-full text-left px-3 py-1.5 text-xs tech-transition flex items-center justify-between gap-2 ${m.id === model ? "text-foreground bg-secondary/60" : "text-muted-foreground hover:bg-secondary"}`}>
                                <span className="truncate">{m.label}</span>
                                {m.id === model && <span className="text-emerald-400 text-[10px] shrink-0">✓</span>}
                              </button>
                            ))}
                          </div>
                        ))}
                        {models.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">Gateway unreachable</div>}
                      </div>
                    </div>
                  )}
                </div>

                <span className="w-px h-3.5 bg-secondary/60 shrink-0" />

                {/* Thinking mode */}
                <div className="relative">
                  <button type="button" onClick={() => { setShowThinkMenu((v) => !v); setShowModelMenu(false); }}
                    className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-secondary hover:text-foreground tech-transition text-muted-foreground"
                    title={THINK_MODES.find((t) => t.mode === thinkMode)?.title}>
                    <span>{THINK_MODES.find((t) => t.mode === thinkMode)?.label ?? "Auto"}</span>
                    <span className="text-muted-foreground/50 text-[9px]">▾</span>
                  </button>
                  {showThinkMenu && (
                    <div className="absolute bottom-full left-0 mb-1.5 w-44 rounded-lg border border-border bg-popover shadow-xl z-50 py-1"
                      onMouseLeave={() => setShowThinkMenu(false)}>
                      {THINK_MODES.map((tm) => (
                        <button key={tm.mode} type="button" onClick={() => { setThinkMode(tm.mode); setShowThinkMenu(false); }}
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
                  <span className="text-[10px] text-muted-foreground/50"><kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> newline</span>
                </div>
              </div>

            </div>
            <p className="text-[9px] text-muted-foreground/50 text-center mt-1.5">
              CC Workbench can make mistakes. Always verify important changes before committing.
            </p>
          </div>
        </div>

      </div>
    </div>
  );
}
