"use client";

/**
 * AgentChat — chat UI for LangGraph agents routed via the CommandCenter gateway.
 *
 * Used by chat/page.tsx when session.agentName is set to a named agent.
 * Missing integrations are surfaced inline — users can configure them via chat
 * or dismiss the banner and configure later in the Integrations page.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import React from "react";
import Link from "next/link";
import { ArrowUp, Square, ListOrdered, CornerDownRight, ChevronDown, CheckCircle } from "lucide-react";
import { useAgentChat } from "@/hooks/useAgentChat";
import type { ArtifactEntry, ChatMessage } from "@/hooks/useAgentChat";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";
import type { AgentEntry } from "@/app/api/agent/list/route";
import type { UnifiedModel } from "@/app/api/models/all/route";
import MarkdownMessage from "@/components/MarkdownMessage";
import AgentStatusBar from "@/components/AgentStatusBar";
import MessageActionBar from "@/components/MessageActionBar";
import GenerativeUIPanel from "@/components/GenerativeUIPanel";
import ArtifactCard, { type ArtifactMeta } from "@/components/ArtifactCard";
import ArtifactViewerModal from "@/components/ArtifactViewerModal";
import type { FileEntry } from "@/components/ArtifactSidebar";
import FileUploadButton from "@/components/FileUploadButton";
import SuggestionPills from "@/components/SuggestionPills";
import ConfirmationCard from "@/components/ConfirmationCard";
import ElicitationCard from "@/components/ElicitationCard";
import type { ElicitationQuestion, ElicitationAnswers } from "@/components/ElicitationCard";
import TodoPanel from "@/components/TodoPanel";
import { parseAgentError } from "@/lib/parseAgentError";
import type { ParsedAgentError } from "@/lib/parseAgentError";
import { getMessages, saveMessages, fetchMessagesFromDb, type PersistedMessage } from "@/lib/sessions";
import { computeContextUsage, activeContextSlice, isCompactionCheckpoint } from "@/lib/tokenCount";
import { useAgentEvents } from "@/lib/agentEvents";
import { buildFrontendToolsAddendum } from "@/hooks/useFrontendTool";

// ── Context-window ring ─────────────────────────────────────────────────────
/**
 * Small circular SVG progress ring showing context-window usage.
 * Always shows the token count. Clickable to trigger manual /compact when ≥ 60%.
 * Color transitions: primary (< 60%) → warning (60–79%) → destructive (≥ 80%).
 *
 * Hover (desktop) or tap (mobile) reveals a detail popup with used/total tokens
 * and percentage.  Click away or mouse-out dismisses it.
 */
function ContextRing({
  pct,
  usedTokens,
  totalTokens,
  compacting,
  onCompact,
  modelId,
  isLoading,
}: {
  pct: number;
  usedTokens: number;
  totalTokens: number;
  compacting: boolean;
  onCompact?: () => void;
  modelId?: string;
  /** When true, show an animated spinner instead of the static ring. */
  isLoading?: boolean;
}) {
  const r = 9;
  const circ = 2 * Math.PI * r;
  const filled = Math.min(1, pct / 100) * circ;
  // NOTE: the theme defines these vars as FULL colors (e.g.
  // `--primary: hsl(198 89% 50%)`), so use `var(--x)` directly — wrapping them
  // in `hsl(var(--x))` yields `hsl(hsl(...))`, which is invalid and renders
  // nothing (this is why the ring was invisible and only the % text showed).
  const color =
    pct >= 80
      ? "var(--destructive)"
      : pct >= 60
        ? "var(--warning)"
        : "var(--primary)";
  const canCompact = pct >= 60 && onCompact && !compacting;

  // ── Popup state ──────────────────────────────────────────────────────
  const [showPopup, setShowPopup] = React.useState(false);
  const containerRef = React.useRef<HTMLSpanElement>(null);

  // Click-away: close popup when clicking outside the container.
  React.useEffect(() => {
    if (!showPopup) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowPopup(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showPopup]);

  // ── Mini progress bar color (use computed `color` directly) ──────────
  const barColor = color; // "var(--primary)" etc. — works in style={}

  // ── Detail popup ─────────────────────────────────────────────────────
  const popup = showPopup && (
    <div
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50
        rounded-lg border border-border bg-popover px-3 py-2.5 shadow-xl
        text-xs whitespace-nowrap
        animate-in fade-in slide-in-from-bottom-1 duration-150"
    >
      {/* Arrow */}
      <div className="absolute top-full left-1/2 -translate-x-1/2
        w-0 h-0 border-l-4 border-r-4 border-t-4
        border-l-transparent border-r-transparent border-t-border" />

      <div className="flex items-center gap-2 mb-1.5">
        <span className={`font-semibold ${
          pct >= 80 ? "text-destructive" : pct >= 60 ? "text-warning" : "text-foreground"
        }`}>
          {pct}% full
        </span>
        {modelId && (
          <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">
            {modelId}
          </span>
        )}
      </div>

      {/* Mini progress bar */}
      <div className="w-full h-1.5 rounded-full bg-border/50 mb-2 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${Math.min(100, pct)}%`, backgroundColor: barColor }}
        />
      </div>

      <div className="flex items-center justify-between gap-4 text-[10px]">
        <span className="text-muted-foreground">Used</span>
        <span className="font-mono font-medium text-foreground tabular-nums">
          {usedTokens.toLocaleString()}
        </span>
      </div>
      <div className="flex items-center justify-between gap-4 text-[10px]">
        <span className="text-muted-foreground">Total</span>
        <span className="font-mono font-medium text-foreground tabular-nums">
          {totalTokens.toLocaleString()}
        </span>
      </div>
      <div className="flex items-center justify-between gap-4 text-[10px]">
        <span className="text-muted-foreground">Remaining</span>
        <span className="font-mono font-medium text-foreground tabular-nums">
          {Math.max(0, totalTokens - usedTokens).toLocaleString()}
        </span>
      </div>
    </div>
  );

  // ── Shared hover / tap handlers ──────────────────────────────────────
  const hoverProps = {
    onMouseEnter: () => setShowPopup(true),
    onMouseLeave: () => setShowPopup(false),
    onClick: (e: React.MouseEvent) => {
      // Toggle popup on tap (mobile).  On desktop hover handles show/hide.
      // Don't toggle if the click landed on the /compact button itself —
      // let that button fire its own onCompact handler.
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      setShowPopup((v) => !v);
    },
  };

  // ── Ring content (filling donut gauge + % label) ─────────────────────
  // The arc fills clockwise from 12 o'clock as context is consumed.  The
  // PRIMARY label is the percentage (so the user reads "how full") — the raw
  // token fraction lives in the hover popup.
  const ring = (
    <span className="shrink-0 flex items-center gap-1.5">
      <svg width="18" height="18" viewBox="0 0 24 24" className="shrink-0">
        {/* Background track */}
        <circle cx="12" cy="12" r={r} fill="none" strokeWidth="3"
          style={{ stroke: "var(--border)" } as React.CSSProperties} />
        {/* Progress arc — starts at 12 o'clock, fills clockwise */}
        <circle
          cx="12" cy="12" r={r}
          fill="none"
          strokeWidth="3"
          strokeDasharray={`${filled} ${circ}`}
          strokeLinecap="round"
          transform="rotate(-90 12 12)"
          style={{ stroke: color, transition: "stroke-dasharray 0.4s ease" } as React.CSSProperties}
        />
      </svg>
      <span className={`text-[11px] font-mono font-semibold tabular-nums ${
        pct >= 80 ? "text-destructive" : pct >= 60 ? "text-warning" : "text-muted-foreground"
      }`}>
        {pct}%
      </span>
    </span>
  );

  // ── Compacting spinner overlaid on the ring ────────────────────────
  if (compacting) {
    return (
      <span className="shrink-0 flex items-center gap-1 text-[10px] text-primary/70 animate-pulse px-1.5 py-0.5 rounded-md">
        {/* Show the filled ring + a spinning overlay so user sees both fill level and activity */}
        <span className="relative w-4 h-4 shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" className="absolute inset-0">
            <circle cx="12" cy="12" r={r} fill="none" strokeWidth="2"
              style={{ stroke: "var(--border)" } as React.CSSProperties} />
            <circle cx="12" cy="12" r={r} fill="none" strokeWidth="2"
              strokeDasharray={`${filled} ${circ}`} strokeLinecap="round"
              style={{ stroke: color, transform: "rotate(-90deg)", transformOrigin: "center" } as React.CSSProperties} />
          </svg>
          <svg width="16" height="16" viewBox="0 0 24 24" className="absolute inset-0 animate-spin" fill="none">
            <path d="M12 3a9 9 0 0 1 9 9" strokeWidth="2" strokeLinecap="round"
              style={{ stroke: "var(--primary)" } as React.CSSProperties} />
          </svg>
        </span>
        <span className="hidden sm:inline">Compacting…</span>
      </span>
    );
  }

  // ── /compact button (≥ 60%) ──────────────────────────────────────────
  if (canCompact) {
    return (
      <span ref={containerRef} className="relative" {...hoverProps}>
        {popup}
        <button
          type="button"
          onClick={onCompact}
          className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-warning/10 tech-transition ${isLoading ? "animate-pulse" : ""}`}>
          {ring}
          <span className="hidden sm:inline text-[9px] text-warning font-medium">/compact</span>
        </button>
      </span>
    );
  }

  // ── Normal ring — pulses subtly while agent is streaming ────────────
  return (
    <span ref={containerRef} className="relative" {...hoverProps}>
      {popup}
      <span className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md cursor-default ${isLoading ? "animate-pulse" : ""}`}>
        {ring}
      </span>
    </span>
  );
}

// ── Error card — shown inline in the message thread and in the header banner ──
function ErrorCard({ parsed, compact = false }: { parsed: ParsedAgentError; compact?: boolean }) {
  const [copied, setCopied] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(parsed.raw).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const codeLabel = parsed.code === 429 ? "429 Rate limit"
    : parsed.code === 401 ? "401 Unauthorized"
    : parsed.code === 402 ? "402 Payment required"
    : parsed.code === 400 ? "400 Bad request"
    : parsed.code === 404 ? "404 Not found"
    : null;

  return (
    <div className={`rounded-xl border border-red-900/50 bg-red-950/30 ${compact ? "px-3 py-2" : "px-4 py-3"} text-sm`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-red-300 font-semibold">{parsed.title}</span>
            {codeLabel && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-red-800/60 text-red-400">{codeLabel}</span>
            )}
          </div>
          {!compact && (
            <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{parsed.detail}</p>
          )}
          <div className="mt-2 flex items-start gap-1.5">
            <span className="text-amber-500 shrink-0 text-xs mt-0.5">→</span>
            <p className="text-xs text-amber-400/90 leading-relaxed">{parsed.suggestion}</p>
          </div>
        </div>
        <button
          onClick={handleCopy}
          title="Copy full error"
          className="shrink-0 text-[10px] px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 tech-transition mt-0.5 whitespace-nowrap"
        >
          {copied ? "Copied!" : "Copy error"}
        </button>
      </div>
      {!compact && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground tech-transition"
          >
            {expanded ? "▲ Hide full error" : "▼ Show full error"}
          </button>
          {expanded && (
            <pre className="mt-1.5 text-[10px] text-muted-foreground bg-muted/60 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
              {parsed.raw}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// Unified model fallback — shown while /api/models/all is loading.
// Always includes the tiers (always accessible) and Gemini models (default provider).
// Provider-specific models for other providers are added dynamically after fetch.
const MODELS_FALLBACK: UnifiedModel[] = [
  { id: "auto",              label: "auto (SDK picks)",     runtime: "copilot", group: "GitHub Copilot SDK" },
  { id: "tier-fast",     label: "Tier 1 (fast / cheap)", runtime: "litellm", group: "LiteLLM — Tiers" },
  { id: "tier-balanced", label: "Tier 2 (balanced)",     runtime: "litellm", group: "LiteLLM — Tiers" },
  { id: "tier-powerful", label: "Tier 3 (powerful)",     runtime: "litellm", group: "LiteLLM — Tiers" },
  { id: "gemini/gemini-2.5-flash", label: "Gemini 2.5 Flash", runtime: "litellm", group: "LiteLLM — Gemini" },
  { id: "gemini/gemini-2.5-pro",   label: "Gemini 2.5 Pro",   runtime: "litellm", group: "LiteLLM — Gemini" },
];

// Number of messages loaded per window when restoring / paging history.
// Keeps initial restore fast for very long sessions; older messages load on
// scroll-up.
const HISTORY_PAGE_SIZE = 30;

type SendMode = "send" | "queue" | "steer";

const SEND_MODE_LABELS: Record<SendMode, string> = {
  send: "Send",
  queue: "Queue",
  steer: "Steer",
};

const SEND_MODE_DESCRIPTIONS: Record<SendMode, string> = {
  steer: "Interrupt current reply and send now (default)",
  send:  "Send when idle, queue if busy",
  queue: "Wait for current reply, then send",
};

// ── Suggestion pills (CopilotKit-style starter prompts) ─────────────────

const DEFAULT_SUGGESTIONS = [
  "What can you help me with?",
  "Summarize recent activity",
  "Create a new task",
];

const AGENT_SUGGESTIONS: Record<string, string[]> = {
  orchestrator: [
    "What can you help me with?",
    "Summarize recent activity across the company",
    "Create a task in ClickUp",
  ],
  "task-manager": [
    "Show my open tasks",
    "Create a new high-priority task",
    "What's due this week?",
  ],
  "sales-assistant": [
    "Show pipeline summary",
    "Create a new lead",
    "What deals are closing this month?",
  ],
};

// ── Per-agent model memory ──────────────────────────────────────────────

const MODEL_PREF_KEY = (agent: string) => `cc-model-${agent}`;
const MODEL_USAGE_KEY = "cc-model-usage";

function getLastModel(agentName: string): string | null {
  try {
    return localStorage.getItem(MODEL_PREF_KEY(agentName));
  } catch { return null; }
}

function setLastModel(agentName: string, modelId: string): void {
  try { localStorage.setItem(MODEL_PREF_KEY(agentName), modelId); } catch { /* noop */ }
}

function getModelUsage(): Record<string, number> {
  try {
    const raw = localStorage.getItem(MODEL_USAGE_KEY);
    return raw ? JSON.parse(raw) as Record<string, number> : {};
  } catch { return {}; }
}

function incrementModelUsage(modelId: string): void {
  if (modelId === "auto") return; // don't track auto
  try {
    const usage = getModelUsage();
    usage[modelId] = (usage[modelId] ?? 0) + 1;
    localStorage.setItem(MODEL_USAGE_KEY, JSON.stringify(usage));
  } catch { /* noop */ }
}

interface AgentChatProps {
  agentName: string;
  sessionId: string;
  agentDescription?: string;
  /** Integration statuses passed from the parent. If absent, fetched on mount. */
  integrationStatuses?: IntegrationStatus[];
  /** Full agent list for mid-chat agent switching. If absent, fetched on mount. */
  availableAgents?: AgentEntry[];
  /** Persona / system prompt injected as system context (e.g. CommandCenter brain). */
  persona?: string;
  /** Persistent memory lines (Mem0) injected as system context. */
  memories?: string[];
  /** When set, the conversation is saved to Mem0 on unmount under this userId. */
  memoryUserId?: string;
  /**
   * Reports conversation activity to the parent so it can enrich the session
   * list (auto-title from the first user message + last-turn preview).
   */
  onActivity?: (info: {
    firstUserMessage?: string;
    lastPreview?: string;
    messageCount: number;
  }) => void;
  /** Called when the agent writes a file via write_artifact tool. */
  onArtifact?: (entry: ArtifactEntry) => void;
  /**
   * Number of messages this session is known to have (from the sidebar list,
   * sourced from Postgres). Drives the history-loading skeleton when the local
   * cache is empty but the server still has rows to fetch.
   */
  expectedMessageCount?: number;
}

export default function AgentChat({
  agentName,
  sessionId,
  agentDescription,
  integrationStatuses: externalStatuses,
  availableAgents: externalAgents,
  persona,
  memories,
  memoryUserId,
  onActivity,
  onArtifact,
  expectedMessageCount,
}: AgentChatProps) {
  // Active agent / model can change mid-chat (VS Code Copilot style).
  const [currentAgentName, setCurrentAgentName] = useState(agentName);
  const [currentModel, setCurrentModel] = useState(() => getLastModel(agentName) ?? "auto");
  // ── Thinking mode ──────────────────────────────────────────────────
  type ThinkMode = "auto" | "thinking" | "max";
  const [thinkMode, setThinkMode] = useState<ThinkMode>("auto");
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [agents, setAgents] = useState<AgentEntry[]>(externalAgents ?? []);
  const [models, setModels] = useState<UnifiedModel[]>(MODELS_FALLBACK);

  // Fetch the unified model list (Copilot SDK + LiteLLM) on mount.
  useEffect(() => {
    fetch("/api/models/all")
      .then((r) => r.json())
      .then((data: unknown) => {
        const d = data as { models?: UnifiedModel[] };
        if (Array.isArray(d.models) && d.models.length > 0) {
          setModels(d.models);
        }
      })
      .catch(() => {}); // Keep fallback list on error
  }, []);

  // Persist model preference per agent + track usage count.
  // Only count usage on an ACTUAL model change (not on mount or agent switch),
  // otherwise every session open inflates the "Frequently Used" ranking.
  const prevModelRef = useRef<string | null>(null);
  useEffect(() => {
    setLastModel(currentAgentName, currentModel);
    if (prevModelRef.current !== null && prevModelRef.current !== currentModel) {
      incrementModelUsage(currentModel);
    }
    prevModelRef.current = currentModel;
  }, [currentModel, currentAgentName]);

  // ── Model sorting: frequently used models float to the top ──────────────
  const sortedModels = useMemo(() => {
    const usage = getModelUsage();
    const topIds = Object.entries(usage)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 4)
      .map(([id]) => id);
    const topSet = new Set(topIds);

    // Only promote models that are still in the list (not hidden/removed).
    const frequent = models.filter((m) => topSet.has(m.id) && m.id !== "auto");
    const rest = models.filter((m) => !topSet.has(m.id) || m.id === "auto");

    // Attach a synthetic group so the picker can render the section header.
    const withGroup = (m: UnifiedModel, group: string): UnifiedModel => ({ ...m, group });
    return [
      ...frequent.map((m) => withGroup(m, "Frequently Used")),
      ...rest,
    ];
  }, [models]);
  // ────────────────────────────────────────────────────────────────────────

  // Resolve the selected model's routing runtime (copilot SDK vs gateway BYOK).
  const selectedModel = models.find((m) => m.id === currentModel);
  const currentRuntime = selectedModel?.runtime ?? "copilot";

  // Resolve the active agent's metadata (runtime classification, repo link, etc.)
  // NOTE: computed here (before useAgentChat) so we can override the routing mode.
  const currentAgentEntry = agents.find((a) => a.name === currentAgentName);
  const agentRuntime: string = currentAgentEntry?.agent_runtime ?? "maf";

  // All named agents route through the Copilot SDK executor (/agent/run/stream)
  // regardless of the model selected. The model is forwarded as a hint for
  // BYOK provider injection in the executor. This ensures every agent gets
  // its tools + instructions even when using a custom model.
  // The orchestrator (CommandCenter) still uses model-driven routing for
  // fast stateless chat when LiteLLM models are selected.
  const isOrchestrator = currentAgentName === "orchestrator" || currentAgentName === "commandcenter";
  const effectiveRuntime = isOrchestrator ? currentRuntime : "copilot";

  // System context = persona + persistent memories + frontend tools (sent as system message).
  const systemContext = useMemo(() => {
    const parts: string[] = [];
    if (persona) parts.push(persona);
    if (memories && memories.length > 0) {
      parts.push(
        "Memories from past conversations with this user — use them for continuity:\n" +
          memories.map((m) => `• ${m}`).join("\n")
      );
    }
    // Inject registered frontend tools into the agent's system prompt
    const toolsAddendum = buildFrontendToolsAddendum();
    if (toolsAddendum) parts.push(toolsAddendum);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }, [persona, memories]);

  // Local cache (localStorage) — instant restore when re-opening a session that
  // was active in this browser. Empty when the session lives only in Postgres
  // (cache cleared, a different device, or the first time we open it here).
  // Drop stale __ERROR__ system messages saved by older builds.
  const cachedFull = useMemo(
    () =>
      (getMessages(sessionId) as ChatMessage[]).filter(
        (m) => !(m.role === "system" && m.content.startsWith("__ERROR__")),
      ),
    [sessionId],
  );
  const { messages, isLoading, error, sendMessage, stopGeneration, setMessages, recovering, runStatus } = useAgentChat({
    agentName: currentAgentName,
    threadId: sessionId,
    model: currentModel,
    mode: effectiveRuntime,
    systemContext,
    thinkMode,
    onArtifact,
    // Load the FULL persisted history into memory so the context sent to the
    // model and the context-usage estimate are both accurate.  We only window
    // the RENDERING (below) for performance — not the data.
    initialMessages: cachedFull,
  });

  // ── Windowed RENDERING (perf) ───────────────────────────────────────────────
  // The full conversation lives in `messages`; we render only the most recent
  // `renderLimit` to keep very long sessions snappy.  Scrolling near the top
  // reveals older messages (no refetch — they're already in memory).
  const [renderLimit, setRenderLimit] = useState(HISTORY_PAGE_SIZE);
  const hasMoreHistory = renderLimit < messages.length;
  // Scroll-position preservation when revealing older messages: holds the
  // pre-expand scrollHeight so a layout effect can keep the viewport anchored.
  const pendingPrependRef = useRef<number | null>(null);
  // Latest reveal-older fn, callable from the (deps:[]) scroll handler.
  const loadOlderHistoryRef = useRef<() => void>(() => {});

  // Reset the render window when switching sessions.
  useEffect(() => {
    setRenderLimit(HISTORY_PAGE_SIZE);
  }, [sessionId]);

  // History-loading state: always true when the sidebar says this session has
  // prior messages.  When localStorage has cached messages we show them right
  // away with a subtle "syncing…" banner; when nothing is cached we show a
  // skeleton until the DB fetch completes.  This avoids both the blank "start
  // a conversation" empty state and the jarring silent update when richer DB
  // messages replace the local cache.
  const [loadingHistory, setLoadingHistory] = useState(
    () => (expectedMessageCount ?? 0) > 0,
  );

  // On mount, fetch the authoritative FULL message history from Postgres and
  // sync into memory if it's richer than the local cache (more messages OR
  // longer content — refresh-recovery where persistAssistantMessage grew the
  // assistant record in-place during streaming).  The cached window paints
  // instantly; this background load keeps the full context + token estimate
  // accurate.  Rendering stays windowed regardless of how many we hold.
  useEffect(() => {
    let cancelled = false;
    fetchMessagesFromDb(sessionId).then((remoteRaw) => {
      if (cancelled || remoteRaw.length === 0) return;
      // Drop stale __ERROR__ system messages persisted by older builds —
      // transient errors must never resurface on reload.
      const remote = (remoteRaw as ChatMessage[]).filter(
        (m) => !(m.role === "system" && m.content?.startsWith("__ERROR__")),
      );
      if (remote.length === 0) return;
      const local = messages;
      // Quick check: more messages → definitely use DB.
      if (remote.length > local.length) {
        setMessages(remote as ChatMessage[]);
        return;
      }
      // Same count but maybe richer content?  Compare total content length
      // and tool-event counts (refresh-recovery: same id, longer content).
      const localTotalLen = local.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
      const remoteTotalLen = remote.reduce((sum: number, m: { content?: string }) => sum + (m.content?.length ?? 0), 0);
      const localToolCount = local.reduce((sum, m) => sum + ((m as { toolEvents?: unknown[] }).toolEvents?.length ?? 0), 0);
      const remoteToolCount = remote.reduce((sum: number, m: { toolEvents?: unknown[] }) => sum + (m.toolEvents?.length ?? 0), 0);
      if (remoteTotalLen > localTotalLen || remoteToolCount > localToolCount) {
        setMessages(remote as ChatMessage[]);
      }
    }).catch(() => {}).finally(() => {
      if (!cancelled) setLoadingHistory(false);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Persist messages to localStorage + Postgres whenever they change.
  // We skip mid-stream placeholder messages (streaming=true, content empty)
  // to avoid saving incomplete assistant turns.  We also skip transient
  // __ERROR__ system messages so a one-off disconnect error doesn't get
  // persisted and re-displayed on every future refresh.
  useEffect(() => {
    const settled = messages.filter(
      (m) =>
        (!m.streaming || m.content.trim().length > 0) &&
        !(m.role === "system" && m.content.startsWith("__ERROR__")),
    );
    if (settled.length === 0) return;
    const toSave: PersistedMessage[] = settled.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      streaming: m.streaming,
      toolEvents: m.toolEvents,
      progressLines: m.progressLines,
      reasoningBlocks: m.reasoningBlocks,
      agentState: m.agentState,
      customEvents: m.customEvents,
      todos: m.todos,
    }));
    saveMessages(sessionId, toSave);
  }, [messages, sessionId]);

  const [input, setInput] = useState("");
  const [sendMode, setSendMode] = useState<SendMode>("steer");
  const [showSendMenu, setShowSendMenu] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const queueRef = useRef<string[]>([]);
  const prevLoadingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [statuses, setStatuses] = useState<IntegrationStatus[]>(externalStatuses ?? []);
  const [viewerEntry, setViewerEntry] = useState<FileEntry | null>(null);

  // ── Context-window tracking + auto-compaction ─────────────────────────────
  // Recompute when the count changes (new message added), when the total settled
  // content length changes (streaming completed and content grew), when the model
  // changes (different context limit), or when the system context changes.
  // Using settled length (non-streaming messages only) avoids thrashing on every
  // streaming delta while still updating promptly after each turn completes.
  // Context usage reflects only the ACTIVE window (from the last compaction
  // checkpoint forward) — the same set sent to the model — so the ring drops
  // after a compaction, exactly like Claude Code / Copilot CLI.
  const activeMessages = useMemo(() => activeContextSlice(messages), [messages]);
  const settledCount = activeMessages.filter((m) => !m.streaming).length;
  const settledContentLen = useMemo(
    () => activeMessages
      .filter((m) => !m.streaming)
      .reduce((s, m) => {
        let len = m.content?.length ?? 0;
        for (const t of m.toolEvents ?? []) {
          len += (t.result?.length ?? 0) + (t.args ? JSON.stringify(t.args).length : 0);
        }
        for (const b of m.reasoningBlocks ?? []) len += b.length;
        return s + len;
      }, 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeMessages.length, settledCount],
  );
  // Real per-model context window (dynamically loaded from the gateway via
  // /api/models/all).  Falls back to the static estimate when unknown.
  const currentModelContextWindow = selectedModel?.contextWindow;
  const contextUsage = useMemo(
    () => computeContextUsage(activeMessages, currentModel, systemContext, currentModelContextWindow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settledContentLen, activeMessages.length, currentModel, systemContext, currentModelContextWindow],
  );
  const [compacting, setCompacting] = useState(false);
  // Armed = allowed to auto-compact.  Disarmed after a compaction fires and
  // re-armed (via hysteresis) once usage falls back below the lower bound, so
  // a long conversation auto-compacts EACH time it fills up — not just once.
  const compactArmedRef = useRef(true);

  // Re-arm on session or model change so a switch (especially to a smaller
  // context window) can trigger its own auto-compaction immediately.
  useEffect(() => {
    compactArmedRef.current = true;
  }, [sessionId]);

  useEffect(() => {
    compactArmedRef.current = true;
  }, [currentModel]);

  // ── Compaction (Claude Code / Copilot CLI checkpoint model) ────────────────
  // Summarise the ACTIVE window (from the last checkpoint) into a new summary
  // checkpoint, INSERTED before the last few turns.  The full transcript stays
  // visible for scrollback; only [summary + recent turns] are sent to the model
  // and counted toward context usage.  Returns true if a checkpoint was added.
  const KEEP_LAST = 6;
  const applyCompaction = useCallback(async (): Promise<boolean> => {
    const forSession = sessionId;
    const active = activeContextSlice(messagesRef.current);
    if (active.length <= KEEP_LAST + 1) return false; // not enough to compact
    setCompacting(true);
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Summarise only the active window — bounds the summariser's input and
        // subsumes any earlier checkpoint it contains.
        body: JSON.stringify({ messages: active, keepLast: KEEP_LAST }),
      });
      const data = (await res.json()) as { messages?: ChatMessage[]; compacted?: boolean };
      if (forSession !== sessionIdRef.current) return false; // session switched
      if (!data.compacted || !Array.isArray(data.messages)) return false;
      const summaryMsg = data.messages.find((m) => isCompactionCheckpoint(m));
      if (!summaryMsg) return false;
      setMessages((prev) => {
        if (prev.some((m) => m.id === summaryMsg.id)) return prev;
        const keep = Math.min(KEEP_LAST, prev.length);
        // Insert the checkpoint before the kept tail: active window becomes
        // [summary + last KEEP_LAST turns]; everything older stays for scrollback.
        return [...prev.slice(0, prev.length - keep), summaryMsg, ...prev.slice(prev.length - keep)];
      });
      return true;
    } catch {
      return false;
    } finally {
      setCompacting(false);
    }
  }, [sessionId, setMessages]);

  // Auto-compact at 80% of the model's context window (GitHub Copilot CLI
  // parity; Claude Code uses ~83%).  70/80 hysteresis so it fires once per
  // fill-up and re-arms after a compaction drops usage.  Between turns only.
  // Because contextUsage uses the model's REAL window, switching mid-chat to a
  // smaller-context model re-triggers compaction if the history now overflows.
  useEffect(() => {
    if (contextUsage.pct < 70) compactArmedRef.current = true;
    if (contextUsage.pct < 80) return;
    if (isLoading || compacting) return;
    if (!compactArmedRef.current) return;
    compactArmedRef.current = false;
    void applyCompaction();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextUsage.pct, isLoading, compacting, applyCompaction]);

  /** Manual /compact trigger — user clicks the context ring when it's high. */
  const handleCompact = useCallback(() => {
    if (compacting || isLoading) return;
    compactArmedRef.current = false; // prevent auto-fire right after manual compact
    void applyCompaction();
  }, [compacting, isLoading, applyCompaction]);

  // ── HITL (Human-in-the-Loop) confirmation state ────────────────────────
  const [confirmation, setConfirmation] = useState<{
    id: string; title: string; detail?: string; context?: string;
  } | null>(null);

  // ── HITL elicitation state (VS Code ask_questions parity) ────────────
  // When requestId is set the tool is blocking (MAF Tier 2 path — the
  // agent is parked on a Future).  The answer must be POSTed to
  // /api/agent/respond-input to resume the SAME stream, identical to the
  // native ask_user flow below.  When requestId is absent (Copilot SDK
  // path), the answer is sent as a new chat message.
  const [elicitation, setElicitation] = useState<{
    questions: ElicitationQuestion[];
    requestId?: string;
  } | null>(null);

  // ── Native ask_user state (Copilot SDK on_user_input_request) ────────
  // This prompt BLOCKS the agent run; the answer is POSTed to
  // /api/agent/respond-input to resume the SAME stream.
  const [userInput, setUserInput] = useState<{
    requestId: string;
    question: string;
    choices: string[];
    allowFreeform: boolean;
  } | null>(null);

  // Subscribe to agent events for HITL detection
  useAgentEvents({
    onCustomEvent: ({ name, value }) => {
      if (name === "confirmation_requested" && value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        setConfirmation({
          id: String(v.id ?? Date.now()),
          title: String(v.title ?? "Confirm action"),
          detail: v.detail ? String(v.detail) : undefined,
          context: v.context ? String(v.context) : undefined,
        });
      }
      if (name === "elicitation_requested" && value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        const qs = v.questions;
        const reqId = v.request_id ? String(v.request_id) : undefined;
        if (Array.isArray(qs) && qs.length > 0) {
          setElicitation({ questions: qs as ElicitationQuestion[], requestId: reqId });
        }
      }
      if (name === "user_input_requested" && value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        const requestId = String(v.request_id ?? "");
        const question = String(v.question ?? "");
        if (requestId && question) {
          setUserInput({
            requestId,
            question,
            choices: Array.isArray(v.choices)
              ? (v.choices as unknown[]).map(String)
              : [],
            allowFreeform: v.allowFreeform !== false,
          });
        }
      }
    },
    onRunFinalized: () => {
      // Clear any stale HITL state when a run completes — a finished
      // run can never be waiting on input anymore.
      setConfirmation((prev) => prev ? null : prev);
      // Only clear elicitation when the agent was BLOCKED on a Future
      // (requestId present, MAF Tier 2 path).  For the Copilot SDK
      // non-blocking path (no requestId), the card must persist until
      // the user submits — clearing here makes it vanish mid-interaction.
      setElicitation((prev) => prev && prev.requestId ? null : prev);
      setUserInput((prev) => prev && prev.requestId ? null : prev);
    },
  });

  // Keep a live ref to messages so the unmount handler can save the latest.
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Live ref to the current sessionId so async callbacks (e.g. /compact) can
  // bail if the user switched sessions while the request was in flight.
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Save messages on beforeunload so partial streams survive browser close.
  useEffect(() => {
    const handleUnload = () => {
      const msgs = messagesRef.current;
      const settled = msgs.filter(
        (m) =>
          (!m.streaming || m.content.trim().length > 0) &&
          !(m.role === "system" && m.content.startsWith("__ERROR__")),
      );
      if (settled.length === 0) return;
      const toSave: PersistedMessage[] = settled.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        toolEvents: m.toolEvents,
        progressLines: m.progressLines,
        reasoningBlocks: m.reasoningBlocks,
        agentState: m.agentState,
        customEvents: m.customEvents,
        todos: m.todos,
      }));
      // Use sendBeacon for reliable delivery during page unload
      const payload = toSave.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        tool_events: m.toolEvents ?? [],
        progress_lines: m.progressLines ?? [],
        reasoning: m.reasoningBlocks && m.reasoningBlocks.length > 0
          ? m.reasoningBlocks.join("\n---\n")
          : null,
        agent_state: m.agentState ?? null,
        custom_events: m.customEvents ?? [],
        todos: m.todos ?? [],
      }));
      try {
        navigator.sendBeacon(
          `/api/chat/sessions/${sessionId}/messages`,
          JSON.stringify(payload)
        );
      } catch { /* best-effort */ }
      // Also save to localStorage synchronously
      try {
        localStorage.setItem(`cc-msgs-${sessionId}`, JSON.stringify(toSave));
      } catch { /* quota exceeded */ }
    };
    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("pagehide", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pagehide", handleUnload);
    };
  }, [sessionId]);

  // Report activity to the parent for session-list enrichment (title + preview).
  const onActivityRef = useRef(onActivity);
  useEffect(() => {
    onActivityRef.current = onActivity;
  }, [onActivity]);
  useEffect(() => {
    if (!onActivityRef.current) return;
    const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content.trim());
    const counted = messages.filter(
      (m) => (m.role === "user" || m.role === "assistant") && m.content.trim(),
    ).length;
    if (counted === 0) return;
    onActivityRef.current({
      firstUserMessage: firstUser?.content,
      lastPreview: lastAssistant?.content,
      messageCount: counted,
    });
  }, [messages]);

  // Drain the queue when a generation finishes (Queue / Steer send modes).
  useEffect(() => {
    if (prevLoadingRef.current && !isLoading && queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      setQueuedCount(queueRef.current.length);
      if (next) void sendMessage(next);
    }
    prevLoadingRef.current = isLoading;
  }, [isLoading, sendMessage]);

  // Persist the conversation to Mem0 on unmount (default / CommandCenter agent).
  useEffect(() => {
    return () => {
      if (!memoryUserId) return;
      const payload = messagesRef.current
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      if (payload.length === 0) return;
      fetch("/api/chat/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: memoryUserId, messages: payload }),
        keepalive: true,
      }).catch(() => {});
    };
  }, [memoryUserId]);

  // Fetch integration statuses if not passed from parent
  useEffect(() => {
    if (externalStatuses) { setStatuses(externalStatuses); return; }
    fetch(`/api/integrations/status?agent=${encodeURIComponent(currentAgentName)}`)
      .then((r) => r.json())
      .then((data: unknown) => { if (Array.isArray(data)) setStatuses(data as IntegrationStatus[]); })
      .catch(() => {});
  }, [currentAgentName, externalStatuses]);

  // Fetch available agents for the switcher if not provided by parent
  useEffect(() => {
    if (externalAgents) { setAgents(externalAgents); return; }
    fetch("/api/agent/list")
      .then((r) => r.json())
      .then((data: unknown) => { if (Array.isArray(data)) setAgents(data as AgentEntry[]); })
      .catch(() => {});
  }, [externalAgents]);

  // Refresh statuses when a new assistant message arrives (in case credentials were just saved)
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
      fetch(`/api/integrations/status?agent=${encodeURIComponent(currentAgentName)}`)
        .then((r) => r.json())
        .then((data: unknown) => { if (Array.isArray(data)) setStatuses(data as IntegrationStatus[]); })
        .catch(() => {});
    }
  }, [messages, currentAgentName]);

  const missingMandatory = statuses.filter((s) => s.mandatory && !s.configured);

  // ── Smart follow-up suggestions (LLM-generated, contextual) ───────
  const [smartSuggestions, setSmartSuggestions] = useState<string[]>([]);
  const lastSuggestedForRef = useRef<string>("");
  useEffect(() => {
    if (isLoading) return;
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant" || !last.content.trim() || last.streaming) return;
    if (lastSuggestedForRef.current === last.id) return; // already fetched
    lastSuggestedForRef.current = last.id;
    setSmartSuggestions([]); // clear stale suggestions while fetching
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const ctrl = new AbortController();
    fetch("/api/chat/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userMessage: lastUser?.content ?? "",
        assistantMessage: last.content.slice(0, 4000),
        agentName: currentAgentName,
      }),
      signal: ctrl.signal,
    })
      .then((r) => r.json())
      .then((d: { suggestions?: string[] }) => {
        if (Array.isArray(d.suggestions) && d.suggestions.length > 0) {
          setSmartSuggestions(d.suggestions);
        }
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [messages, isLoading, currentAgentName]);

  // ── Smart auto-scroll + scroll-to-bottom button ─────────────────────
  const threadRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isNearBottomRef = useRef(true);

  // Track whether user has scrolled away from the bottom
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = dist < 80;
      isNearBottomRef.current = nearBottom;
      setShowScrollBtn(!nearBottom && el.scrollHeight > el.clientHeight + 200);
      // Near the top → lazy-load the previous page of history.
      if (el.scrollTop < 140) loadOlderHistoryRef.current();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll only when user is near the bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // ── Reveal older history (scroll-up) — expand the render window ────────────
  // The full conversation is already in memory; this just renders more of it.
  const loadOlderHistory = useCallback(() => {
    if (renderLimit >= messages.length) return;
    const el = threadRef.current;
    pendingPrependRef.current = el ? el.scrollHeight : null; // anchor viewport
    setRenderLimit((r) => Math.min(r + HISTORY_PAGE_SIZE, messages.length));
  }, [renderLimit, messages.length]);

  // Keep the scroll-handler-callable ref pointing at the latest closure.
  useEffect(() => {
    loadOlderHistoryRef.current = loadOlderHistory;
  }, [loadOlderHistory]);

  // After revealing older messages, keep the viewport anchored where the user
  // was reading (offset by the height that was just added at the top).
  React.useLayoutEffect(() => {
    if (pendingPrependRef.current != null) {
      const el = threadRef.current;
      if (el) el.scrollTop += el.scrollHeight - pendingPrependRef.current;
      pendingPrependRef.current = null;
    }
  }, [renderLimit, messages]);

  // The slice of messages actually rendered (most recent `renderLimit`).
  const visibleMessages = useMemo(
    () => (messages.length > renderLimit ? messages.slice(-renderLimit) : messages),
    [messages, renderLimit],
  );

  const enqueue = useCallback((text: string, front = false) => {
    if (front) queueRef.current.unshift(text);
    else queueRef.current.push(text);
    setQueuedCount(queueRef.current.length);
  }, []);

  /** Submit honouring the active send mode (Send / Queue / Steer). */
  const submitText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!isLoading) {
        void sendMessage(trimmed);
        return;
      }
      // A generation is in flight — branch on send mode.
      if (sendMode === "steer") {
        // Drop the incomplete assistant message so history is clean when the
        // steer text is sent — mirrors VS Code Copilot Chat behaviour.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.streaming ? prev.slice(0, -1) : prev;
        });
        stopGeneration();
        enqueue(trimmed, true); // jump the queue, sent as soon as the stream stops
      } else {
        enqueue(trimmed); // queue (also the fallback for "send" while busy)
      }
    },
    [isLoading, sendMode, sendMessage, stopGeneration, enqueue, setMessages]
  );

  /** Explicit Stop — also clears the queue so steered/queued messages don't
   *  auto-send when the run halts (the drain effect fires on isLoading→false). */
  const handleStop = useCallback(() => {
    queueRef.current = [];
    setQueuedCount(0);
    stopGeneration();
  }, [stopGeneration]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loadingHistory) return;
    submitText(input);
    setInput("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  /** Send an MCQ choice the user clicked. */
  const handleChoice = useCallback(
    (choice: string) => {
      submitText(choice);
    },
    [submitText]
  );

  /** Ask the agent to help configure a specific integration. */
  const handleAskAgentConfigure = (svc: IntegrationStatus) => {
    setBannerDismissed(true);
    sendMessage(
      `I need to configure the ${svc.label ?? svc.service} integration. ` +
      `Please guide me through setting it up.`
    );
  };

  /** Switch the active agent mid-chat. History is retained and passed as context. */
  const handleSwitchAgent = useCallback((entry: AgentEntry) => {
    setCurrentAgentName(entry.name);
    setCurrentModel(getLastModel(entry.name) ?? "auto");
    setShowAgentMenu(false);
  }, []);

  const currentModelLabel =
    sortedModels.find((m) => m.id === currentModel)?.label ?? currentModel;
  const modelGroups = Array.from(new Set(sortedModels.map((m) => m.group)));

  // GitHub Copilot SDK agents support BYOK (Bring Your Own Key): when a
  // LiteLLM model (e.g. openrouter/deepseek/deepseek-v4-pro) is selected,
  // the executor injects a provider block so the SDK routes through the local
  // gateway /v1 (litellm SDK) instead of api.githubcopilot.com.  All models are available.
  const isCopilotSdkAgent = agentRuntime === "github-copilot";
  // True when a Copilot SDK agent is running via BYOK (gateway /v1).
  const isByokActive = isCopilotSdkAgent && currentRuntime === "litellm";

  // Model picker state
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showThinkMenu, setShowThinkMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const sendMenuRef = useRef<HTMLDivElement>(null);

  // Close model menu on outside click
  useEffect(() => {
    if (!showModelMenu) return;
    const handleOutside = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [showModelMenu]);

  // Close send-mode menu on outside click (works on touch devices too)
  useEffect(() => {
    if (!showSendMenu) return;
    const handleOutside = (e: MouseEvent) => {
      if (sendMenuRef.current && !sendMenuRef.current.contains(e.target as Node)) {
        setShowSendMenu(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [showSendMenu]);

  /** Display labels + styling for an agent_runtime value. */
  function agentRuntimeMeta(rt: string): { label: string; title: string; cls: string }[] {
    if (rt === "github-copilot") {
      return [
        {
          label: "Copilot SDK",
          title: "GitHub Copilot SDK — native shell, file r/w, MCP servers, BYOK provider support",
          cls: "border-sky-700/50 bg-sky-900/30 text-sky-300",
        },
      ];
    }
    if (rt === "langgraph") {
      return [{
        label: "LangGraph",
        title: "Legacy LangGraph agent runner",
        cls: "border-violet-700/50 bg-violet-900/30 text-violet-300",
      }];
    }
    return [{
      label: "MAF",
      title: "Microsoft Agent Framework agent",
      cls: "border-amber-700/50 bg-amber-900/30 text-amber-300",
    }];
  }

  const THINK_MODES: { mode: ThinkMode; label: string; title: string }[] = [
    { mode: "auto", label: "Auto", title: "Let the model decide" },
    { mode: "thinking", label: "Thinking", title: "Enable chain-of-thought reasoning" },
    { mode: "max", label: "Max", title: "Maximum effort / deeper reasoning" },
  ];

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Agent header — VS Code-style minimal bar */}
      <div className="flex items-center gap-2 h-9 px-4 border-b border-border bg-card/40 shrink-0">
        <div className={`w-2 h-2 rounded-full shrink-0 ${isLoading ? "bg-warning animate-pulse" : "bg-success"}`} />
        <span className="text-xs font-medium text-foreground truncate">{currentAgentName}</span>
        {isLoading && (
          <span className="hidden sm:inline text-[10px] text-warning/70 animate-pulse">thinking…</span>
        )}
        {agentRuntime === "github-copilot" && currentAgentEntry?.repo_url && (
          <a href={currentAgentEntry.repo_url} target="_blank" rel="noopener noreferrer"
            className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground tech-transition ml-auto"
            title={`Source: ${currentAgentEntry.repo_name ?? currentAgentEntry.repo_url}`}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
        )}
      </div>

      {/* Missing integrations banner (compact) */}
      {!bannerDismissed && missingMandatory.length > 0 && (
        <div className="shrink-0 border-b border-warning/20 bg-warning/5 px-4 py-2 flex items-center gap-2 text-[11px]">
          <span className="text-warning">⚡</span>
          <span className="text-warning/80">{missingMandatory.length} integration{missingMandatory.length > 1 ? "s" : ""} not configured</span>
          <button onClick={() => setBannerDismissed(true)} className="ml-auto w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition">✕</button>
        </div>
      )}

      {/* Message thread */}
      <div ref={threadRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 relative scrollbar-thin">
        {/* Scroll-to-bottom floating button */}
        {showScrollBtn && (
          <button onClick={scrollToBottom}
            className="sticky bottom-3 left-1/2 -translate-x-1/2 z-10 w-8 h-8 rounded-full bg-card border border-border text-foreground shadow-lg flex items-center justify-center hover:bg-secondary hover:text-foreground tech-transition"
            aria-label="Scroll to bottom">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        )}

        <div className="max-w-3xl mx-auto space-y-5">
          {/* Stream recovery / agent status indicator */}
          {recovering || runStatus === "running" ? (
            <div role="status" aria-live="polite" className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-[12px] text-primary/90 flex items-center gap-2">
              <span className={[
                "w-2.5 h-2.5 rounded-full shrink-0",
                runStatus === "running" ? "bg-green-500 animate-pulse" : "bg-primary animate-pulse",
              ].join(" ")} />
              <span className="font-medium">
                {runStatus === "running" ? "Agent running…" : "Reconnecting…"}
              </span>
              <span className="text-primary/60">
                {runStatus === "running"
                  ? "The agent is still working. Content will appear as it's produced."
                  : runStatus === "recovering"
                    ? "Recovering your stream from the server"
                    : "Checking agent status…"}
              </span>
            </div>
          ) : !isLoading && messages.length > 0 && (() => {
            const last = messages[messages.length - 1];
            const wasInterrupted = last?.role === "assistant" && last.content && !/[.?!]\s*$/.test(last.content.trim());
            return wasInterrupted ? (
              <div className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-[11px] text-warning/80">
                ⚡ Stream was interrupted. Messages are saved — you can continue chatting below.
              </div>
            ) : null;
          })()}
          {loadingHistory && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3 text-center">
              <span className="w-6 h-6 rounded-full border-2 border-muted border-t-primary animate-spin" />
              <div className="text-foreground text-sm font-medium">Loading conversation…</div>
              <div className="text-muted-foreground text-xs">Fetching your history from the server</div>
              <div className="w-full max-w-3xl mx-auto space-y-3 pt-6" aria-hidden>
                <div className="h-12 w-2/3 rounded-2xl bg-muted/40 animate-pulse" />
                <div className="h-16 w-3/4 rounded-2xl bg-muted/30 animate-pulse ml-auto" />
                <div className="h-12 w-1/2 rounded-2xl bg-muted/40 animate-pulse" />
              </div>
            </div>
          )}
          {/* Subtle syncing banner — messages are visible (from localStorage) but
              the richer DB versions are still loading in the background. */}
          {loadingHistory && messages.length > 0 && (
            <div className="flex items-center justify-center gap-2 py-2 px-4 mx-auto mb-1 rounded-lg border border-border/50 bg-card/60 text-[11px] text-muted-foreground animate-fade-in">
              <span className="w-3 h-3 rounded-full border-2 border-muted border-t-primary animate-spin" />
              <span>Syncing your history…</span>
            </div>
          )}
          {!loadingHistory && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3 text-center">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center tech-glow">
                <div className="w-2.5 h-2.5 rounded-full bg-success" />
              </div>
              <div className="text-muted-foreground text-sm font-medium">
                Chat with <span className="text-foreground">{currentAgentName}</span>
              </div>
              {agentDescription && currentAgentName === agentName && (
                <div className="text-muted-foreground/60 text-xs max-w-sm leading-relaxed">{agentDescription}</div>
              )}
              <SuggestionPills
                suggestions={AGENT_SUGGESTIONS[currentAgentName] ?? DEFAULT_SUGGESTIONS}
                onPick={handleChoice}
              />
            </div>
          )}

          {/* Older-history affordance — auto-reveals on scroll-up; also clickable.
              Messages are already in memory; this just renders more of them. */}
          {hasMoreHistory && visibleMessages.length > 0 && (
            <div className="flex items-center justify-center py-2">
              <button
                type="button"
                onClick={() => loadOlderHistory()}
                className="text-[11px] text-muted-foreground hover:text-foreground px-3 py-1 rounded-full border border-border/60 hover:border-primary/40 tech-transition"
              >
                ↑ Show earlier messages ({messages.length - renderLimit} more)
              </button>
            </div>
          )}

          {visibleMessages.map((msg, i) => {
            const prevMsg = i > 0 ? visibleMessages[i - 1] : null;
            // Find the preceding user message for retry (walk back to the
            // most recent user message before this assistant message).
            const prevUserMsg =
              msg.role === "assistant"
                ? [...visibleMessages.slice(0, i)].reverse().find((m) => m.role === "user")
                : null;
            const showDateDivider = prevMsg &&
              new Date(msg.timestamp).toDateString() !== new Date(prevMsg.timestamp).toDateString();
            return (
              <div key={msg.id} className="animate-fade-in">
                {showDateDivider && (
                  <div className="flex items-center gap-3 my-4">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-[10px] text-muted-foreground/40 font-medium shrink-0">
                      {new Date(msg.timestamp).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                    </span>
                    <div className="flex-1 h-px bg-secondary" />
                  </div>
                )}
                <MessageBubble message={msg} sessionId={sessionId} onChoice={handleChoice}
                  onFileOpen={(entry) => setViewerEntry(entry)}
                  onResend={(content) => { submitText(content); }}
                  onRetry={prevUserMsg ? () => { submitText(prevUserMsg.content); } : undefined} />
              </div>
            );
          })}

          {confirmation && (
            <ConfirmationCard title={confirmation.title} detail={confirmation.detail} context={confirmation.context}
              onApprove={() => { submitText(`APPROVE: ${confirmation.id}`); setConfirmation(null); }}
              onReject={() => { submitText(`REJECT: ${confirmation.id}`); setConfirmation(null); }} />
          )}

          {elicitation && (
            <ElicitationCard
              questions={elicitation.questions}
              onSubmit={(answers: ElicitationAnswers) => {
                if (elicitation.requestId) {
                  // ── Blocking path (MAF Tier 2) ───────────────────
                  // The agent is parked on a Future — POST the answer
                  // to /api/agent/respond-input to unblock it.  The
                  // agent receives the answer as the tool return value
                  // and continues in the SAME stream.
                  //
                  // For multi-question cards, concatenate all answers
                  // into one string (same format as the non-blocking
                  // path) so the LLM can parse structured responses.
                  const formatted = Object.entries(answers)
                    .map(([header, ans]) => {
                      const parts: string[] = [`[${header}]`];
                      if (ans.selected && ans.selected.length > 0) {
                        parts.push(`Selected: ${ans.selected.join(", ")}`);
                      }
                      if (ans.freeform) {
                        parts.push(`Answer: ${ans.freeform}`);
                      }
                      return parts.join("\n");
                    })
                    .join("\n\n");
                  const firstHeader = elicitation.questions[0]?.header ?? "Question";
                  const a = answers[firstHeader] ?? {};
                  const selected = a.selected?.[0];
                  const freeform = a.freeform?.trim();
                  const answer = freeform || selected || formatted;
                  const wasFreeform = !!freeform && !selected;
                  const reqId = elicitation.requestId;
                  setElicitation(null);
                  void fetch("/api/agent/respond-input", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      request_id: reqId,
                      answer,
                      was_freeform: wasFreeform,
                    }),
                  }).catch(() => {});
                } else {
                  // ── Non-blocking path (Copilot SDK / standalone) ──
                  // Send the answer as a new chat message for the
                  // agent to process in its next turn.
                  const formatted = Object.entries(answers)
                    .map(([header, ans]) => {
                      const parts: string[] = [`[${header}]`];
                      if (ans.selected && ans.selected.length > 0) {
                        parts.push(`Selected: ${ans.selected.join(", ")}`);
                      }
                      if (ans.freeform) {
                        parts.push(`Answer: ${ans.freeform}`);
                      }
                      return parts.join("\n");
                    })
                    .join("\n\n");
                  submitText(formatted);
                  setElicitation(null);
                }
              }}
            />
          )}

          {userInput && (
            <ElicitationCard
              questions={[{
                header: "Question",
                question: userInput.question,
                multiSelect: false,
                allowFreeformInput: userInput.allowFreeform,
                options: userInput.choices.length > 0
                  ? userInput.choices.map((c) => ({ label: c }))
                  : null,
              }]}
              onSubmit={(answers: ElicitationAnswers) => {
                const a = answers["Question"] ?? {};
                const selected = a.selected?.[0];
                const freeform = a.freeform?.trim();
                const answer = freeform || selected || "";
                const wasFreeform = !!freeform && !selected;
                const reqId = userInput.requestId;
                setUserInput(null);
                // Unblock the parked agent run — it resumes in the SAME
                // stream (no new chat message, no queuing).
                void fetch("/api/agent/respond-input", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    request_id: reqId,
                    answer,
                    was_freeform: wasFreeform,
                  }),
                }).catch(() => {});
              }}
            />
          )}

          {!isLoading && messages.length > 0 && (() => {
            const last = messages[messages.length - 1];
            if (last?.role === "assistant" && last.content.trim() && !last.streaming) {
              return (
                <SuggestionPills
                  suggestions={smartSuggestions.length > 0
                    ? smartSuggestions
                    : (AGENT_SUGGESTIONS[currentAgentName] ?? DEFAULT_SUGGESTIONS)}
                  onPick={handleChoice} label="Follow up" align="start" />
              );
            }
            return null;
          })()}

          {error && !isLoading && <ErrorCard parsed={parseAgentError(error)} />}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* ── Input area + VS Code-style bottom bar ─────────────────────── */}
      <form onSubmit={handleSubmit} className="shrink-0 border-t border-border bg-card/40 px-3 sm:px-4 pt-2 pb-safe-full">
        {/* VS Code-style Todos panel — latest assistant turn's todo list */}
        {(() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role === "assistant" && m.todos && m.todos.length > 0) {
              return <TodoPanel todos={m.todos} running={!!m.streaming} />;
            }
            if (m.role === "user") break; // only the current turn's todos
          }
          return null;
        })()}
        {queuedCount > 0 && (
          <div className="max-w-3xl mx-auto mb-2 flex items-center gap-2 text-[11px] text-amber-400">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            {queuedCount} message{queuedCount > 1 ? "s" : ""} queued
            <button type="button" onClick={() => { queueRef.current = []; setQueuedCount(0); }}
              className="text-muted-foreground hover:text-foreground underline">clear</button>
          </div>
        )}

        <div className="max-w-3xl mx-auto">
          {/* Input pill — textarea + inline controls, unified container */}
          <div className="rounded-2xl border border-border bg-secondary/50 focus-within:border-primary/40 tech-transition">
            {/* Row 1: upload + textarea + send */}
            <div className="flex items-end gap-2 px-2 pt-2 pb-1">
              <FileUploadButton sessionId={sessionId}
                onUploadComplete={(files) => {
                  const names = files.map((f) => f.name).join(", ");
                  const paths = files.map((f) => `\`${f.path}\``).join(", ");
                  const ctx = `📎 Uploaded ${files.length} file(s): ${names}\n\nThese files are available in the workspace at:\n${paths}\n\nYou can read them with the read_file tool. Refer to them whenever I mention the uploaded content.`;
                  setInput((prev) => prev.trim() ? `${prev}\n\n${ctx}` : ctx);
                  inputRef.current?.focus();
                }}
                className="shrink-0 self-end mb-1" />

              <textarea ref={inputRef} value={input}
                onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} rows={1}
                disabled={loadingHistory}
                aria-label={`Message ${currentAgentName}`}
                placeholder={
                  loadingHistory
                    ? "Loading previous messages…"
                    : isLoading
                      ? `${SEND_MODE_LABELS[sendMode]} a follow-up to ${currentAgentName}…`
                      : `Message ${currentAgentName}…`
                }
                className="flex-1 resize-none bg-transparent px-1 py-1.5 text-[16px] sm:text-sm text-foreground placeholder-muted-foreground focus:outline-none max-h-40 overflow-y-auto scrollbar-thin disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ minHeight: "32px" }}
                onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }} />

              {/* Contextual send / stop button */}
              {loadingHistory ? (
                <div className="shrink-0 self-end h-9 w-9 rounded-xl bg-muted flex items-center justify-center">
                  <span className="w-4 h-4 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
                </div>
              ) : isLoading ? (
                <div className="shrink-0 flex items-stretch self-end" ref={sendMenuRef}>
                  {/* Stop button — always visible while loading */}
                  <button type="button" onClick={handleStop}
                    className="h-9 w-9 rounded-xl bg-destructive/10 border border-destructive/30 text-destructive flex items-center justify-center hover:bg-destructive/20 tech-transition"
                    aria-label="Stop generation" title="Stop generation">
                    <Square size={15} strokeWidth={2.5} fill="currentColor" />
                  </button>
                  {/* Send/Queue/Steer — unified pill: button + dropdown toggle merged */}
                  {input.trim() && (
                    <div className="relative ml-1.5">
                      <div className={`flex items-stretch rounded-xl overflow-hidden border ${
                        sendMode === "steer" ? "bg-amber-600 border-amber-500" :
                        sendMode === "queue" ? "bg-sky-600 border-sky-500" :
                        "bg-primary border-primary"
                      }`}>
                        {/* Main send action */}
                        <button type="submit"
                          className={`h-9 pl-3 pr-2 text-white font-semibold text-xs flex items-center gap-1.5 hover:brightness-110 tech-transition ${
                            sendMode === "steer" ? "bg-amber-600" :
                            sendMode === "queue" ? "bg-sky-600" :
                            "bg-primary"
                          }`}
                          aria-label={SEND_MODE_LABELS[sendMode]}
                          title={`${SEND_MODE_LABELS[sendMode]} — press Enter`}>
                          {sendMode === "steer" ? <CornerDownRight size={14} strokeWidth={2} /> :
                           sendMode === "queue" ? <ListOrdered size={14} strokeWidth={2} /> :
                           <ArrowUp size={14} strokeWidth={2.5} />}
                          <span className="hidden sm:inline text-[11px]">{SEND_MODE_LABELS[sendMode]}</span>
                        </button>
                        {/* Dropdown toggle — divider + chevron */}
                        <button type="button"
                          onClick={(e) => { e.preventDefault(); setShowSendMenu((v) => !v); }}
                          className={`h-9 w-7 flex items-center justify-center border-l hover:brightness-110 tech-transition ${
                            sendMode === "steer" ? "bg-amber-600 border-amber-500" :
                            sendMode === "queue" ? "bg-sky-600 border-sky-500" :
                            "bg-primary border-primary-foreground/20"
                          }`}
                          aria-label="Change send mode" title="Change how messages are sent">
                          <ChevronDown size={14} strokeWidth={2.5} className="text-white/80" />
                        </button>
                      </div>
                      {/* Dropdown menu */}
                      {showSendMenu && (
                        <div className="absolute bottom-full right-0 mb-1.5 w-56 rounded-xl border border-border bg-popover shadow-2xl z-50 py-1.5 tech-glass-subtle"
                          onMouseLeave={() => setShowSendMenu(false)}>
                          <div className="px-3 pb-1 text-[9px] text-muted-foreground/60 uppercase tracking-wider font-semibold">Send mode</div>
                          {(["steer", "send", "queue"] as SendMode[]).map((m) => (
                            <button key={m} type="button"
                              onClick={() => { setSendMode(m); setShowSendMenu(false); }}
                              className={`w-full text-left px-3 py-2 text-xs hover:bg-secondary tech-transition ${m === sendMode ? "text-foreground bg-secondary/60" : "text-muted-foreground"}`}>
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium flex items-center gap-2">
                                  <span className={`w-6 h-6 rounded-lg flex items-center justify-center ${
                                    m === "steer" ? "bg-amber-500/15 text-amber-400" :
                                    m === "queue" ? "bg-sky-500/15 text-sky-400" :
                                    "bg-primary/15 text-primary"
                                  }`}>
                                    {m === "steer" ? <CornerDownRight size={13} strokeWidth={2} /> :
                                     m === "queue" ? <ListOrdered size={13} strokeWidth={2} /> :
                                     <ArrowUp size={13} strokeWidth={2.5} />}
                                  </span>
                                  {m === "steer" ? "Steer" : m === "queue" ? "Queue" : "Send"}
                                </span>
                                {m === sendMode && <CheckCircle size={13} className="text-emerald-400 shrink-0" />}
                              </div>
                              <div className="text-muted-foreground mt-0.5 text-[10px] ml-8">
                                {SEND_MODE_DESCRIPTIONS[m]}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <button type="submit" disabled={!input.trim()}
                  className="shrink-0 self-end h-9 w-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-25 disabled:cursor-not-allowed hover:opacity-90 tech-transition"
                  aria-label="Send" title="Send message">
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              )}
            </div>

            {/* Row 2: control bar inside the pill — wraps on narrow screens */}
            <div className="flex items-center gap-1 px-2 pb-1.5 text-[11px] text-muted-foreground flex-wrap" ref={modelMenuRef}>
              {/* Agent selector — only the orchestrator can switch agents mid-session.
                  Specialised agents lock you into their session for clean history. */}
              {isOrchestrator && (
                <div className="relative">
                  <button onClick={() => setShowAgentMenu((v) => !v)}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-secondary hover:text-foreground tech-transition">
                    <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                    <span className="truncate max-w-[72px] sm:max-w-[90px] font-medium">{currentAgentName}</span>
                    <span className="text-muted-foreground/50">▾</span>
                  </button>
                  {showAgentMenu && (
                    <div className="absolute bottom-full left-0 mb-1.5 w-64 rounded-lg border border-border bg-popover shadow-xl z-50 py-1 tech-glass-subtle"
                      onMouseLeave={() => setShowAgentMenu(false)}>
                      {agents.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground">No agents available</div>
                      ) : (
                        agents.map((a) => (
                          <button key={a.name} onClick={() => handleSwitchAgent(a)}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-secondary tech-transition ${a.name === currentAgentName ? "text-foreground bg-secondary/60" : "text-muted-foreground"}`}>
                            <div className="flex items-center justify-between gap-1">
                              <span className="font-medium">{a.name}</span>
                              {a.name === currentAgentName && <span className="text-emerald-400 text-[10px]">✓</span>}
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}

              {isOrchestrator && <span className="w-px h-3.5 bg-border shrink-0" />}

              {/* Model selector */}
              <div className="relative">
                <button onClick={() => setShowModelMenu((v) => !v)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-secondary hover:text-foreground tech-transition truncate max-w-[110px] sm:max-w-[150px]">
                  <span className="truncate">{currentModelLabel}</span>
                  <span className="text-muted-foreground/50 shrink-0">▾</span>
                </button>
                {showModelMenu && (
                  <div className="absolute bottom-full left-0 mb-1.5 w-72 rounded-lg border border-border bg-popover shadow-2xl z-50 overflow-hidden tech-glass-subtle">
                    <div className="max-h-72 overflow-y-auto py-1 scrollbar-thin">
                      {modelGroups.map((group) => (
                        <div key={group}>
                          <div className="px-3 pt-2 pb-1 text-[9px] text-muted-foreground/60 uppercase tracking-wider font-semibold">{group}</div>
                          {sortedModels.filter((m) => m.group === group).map((m) => (
                            <button key={m.id}
                              onClick={() => { setCurrentModel(m.id); setShowModelMenu(false); }}
                              className={`w-full text-left px-3 py-1.5 text-xs tech-transition flex items-center justify-between gap-2 ${m.id === currentModel ? "text-foreground bg-secondary/60" : "text-muted-foreground hover:bg-secondary"}`}>
                              <span className="truncate">{m.label}</span>
                              {m.id === currentModel && <span className="text-emerald-400 text-[10px] shrink-0">✓</span>}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <span className="w-px h-3.5 bg-secondary/60 shrink-0" />

              {/* Thinking mode — compact dropdown (saves space, easier tap on mobile) */}
              <div className="relative">
                <button type="button"
                  onClick={() => setShowThinkMenu((v) => !v)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-secondary hover:text-foreground tech-transition text-muted-foreground"
                  title={THINK_MODES.find((t) => t.mode === thinkMode)?.title}>
                  <span>{THINK_MODES.find((t) => t.mode === thinkMode)?.label ?? "Auto"}</span>
                  <span className="text-muted-foreground/50 text-[9px]">▾</span>
                </button>
                {showThinkMenu && (
                  <div className="absolute bottom-full left-0 mb-1.5 w-44 rounded-lg border border-border bg-popover shadow-xl z-50 py-1 tech-glass-subtle"
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

              <span className="w-px h-3.5 bg-secondary/60 shrink-0" />

              {/* Context-window ring — always visible inline */}
              <ContextRing
                pct={contextUsage.pct}
                usedTokens={contextUsage.usedTokens}
                totalTokens={contextUsage.totalTokens}
                compacting={compacting}
                onCompact={handleCompact}
                modelId={currentModel}
                isLoading={isLoading}
              />

              {isLoading && sendMode !== "send" && (
                <span className="text-amber-400 text-[10px] font-medium">
                  {sendMode === "queue" ? "⏱ Queued" : "⤳ Steering"}
                </span>
              )}

              <span className="hidden sm:inline text-muted-foreground text-[10px] ml-auto">
                <kbd className="text-muted-foreground">⏎</kbd> send · <kbd className="text-muted-foreground">⇧⏎</kbd> newline
              </span>
            </div>
          </div>

          {/* Disclaimer */}
          <p className="text-[9px] text-muted-foreground/50 text-center mt-1.5">
            CommandCenter can make mistakes. Please verify important information.
          </p>
        </div>
      </form>

      {/* Artifact viewer modal */}
      {viewerEntry && (
        <ArtifactViewerModal sessionId={sessionId} entry={viewerEntry}
          onClose={() => setViewerEntry(null)} onDelete={() => setViewerEntry(null)} />
      )}
    </div>
  );
}

// ─── Message bubble ─────────────────────────────────────────────────────────

function MessageBubble({
  message,
  sessionId,
  onChoice,
  onFileOpen,
  onResend,
  onRetry,
}: {
  message: ChatMessage;
  sessionId: string;
  onChoice?: (choice: string) => void;
  onFileOpen?: (entry: FileEntry) => void;
  onResend?: (content: string) => void;
  onRetry?: () => void;
}) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const editRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the edit textarea + focus when entering edit mode
  useEffect(() => {
    if (editing && editRef.current) {
      const t = editRef.current;
      t.focus();
      t.style.height = "auto";
      t.style.height = `${Math.max(t.scrollHeight, 60)}px`;
    }
  }, [editing]);

  // ── Extract artifact events from custom events ──────────────────────────
  const artifactEvents: ArtifactMeta[] = (message.customEvents ?? [])
    .filter(
      (e) =>
        (e.name === "artifact_created" || e.name === "artifact_updated") &&
        e.value &&
        typeof e.value === "object",
    )
    .map((e) => {
      const v = e.value as Record<string, unknown>;
      const path = String(v.path ?? "");
      return {
        path,
        name: path.split("/").pop() ?? path,
        size: typeof v.size === "number" ? v.size : undefined,
        mimeType: typeof v.mime_type === "string" ? v.mime_type : undefined,
        sha256: typeof v.sha256 === "string" ? v.sha256 : undefined,
      } satisfies ArtifactMeta;
    });

  if (isSystem) {
    const content = message.content;
    if (content.startsWith("__ERROR__")) {
      try {
        const parsed: ParsedAgentError = JSON.parse(content.slice(9));
        return <ErrorCard parsed={parsed} />;
      } catch {
        // fall through
      }
    }
    // Context-compaction summary pill — styled distinctly so users know
    // the conversation was compressed.
    if (content.startsWith("[CONTEXT SUMMARY")) {
      const lines = content.split("\n");
      const header = lines[0];
      const body = lines.slice(2).join("\n").trim();
      return (
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-primary/80">
          <div className="flex items-center gap-1.5 font-medium mb-1">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 8h10M8 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {header}
          </div>
          {body && (
            <pre className="whitespace-pre-wrap text-[10px] text-primary/60 leading-relaxed">{body}</pre>
          )}
        </div>
      );
    }
    return (
      <div className="text-center text-xs text-muted-foreground italic py-1">
        {content}
      </div>
    );
  }

  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const handleEditSubmit = () => {
    const trimmed = editText.trim();
    if (trimmed && onResend) {
      onResend(trimmed);
    }
    setEditing(false);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleEditSubmit();
    } else if (e.key === "Escape") {
      setEditing(false);
      setEditText(message.content);
    }
  };

  const handleEditInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditText(e.target.value);
    const t = e.currentTarget;
    t.style.height = "auto";
    t.style.height = `${Math.min(Math.max(t.scrollHeight, 60), 300)}px`;
  };

  if (isUser) {
    return (
      <div className="flex justify-end group">
        {editing ? (
          /* ═══ Edit mode ═══ */
          <div className="w-full max-w-full sm:max-w-[85%]">
            <div className="rounded-2xl rounded-tr-sm border-2 border-amber-500/50 bg-secondary shadow-lg shadow-amber-500/5 overflow-hidden">
              {/* Edit header */}
              <div className="flex items-center justify-between px-4 py-2 border-b border-border/60 bg-secondary/80">
                <span className="text-[11px] text-amber-400/80 font-medium">
                  ✏️ Editing message
                </span>
                <span className="text-[10px] text-muted-foreground hidden sm:block">
                  Enter to send · Esc to cancel · Shift+Enter for new line
                </span>
              </div>

              {/* Textarea */}
              <div className="px-3 py-3">
                <textarea
                  ref={editRef}
                  value={editText}
                  onChange={handleEditInput}
                  onKeyDown={handleEditKeyDown}
                  rows={3}
                  className="w-full resize-none rounded-xl bg-card border border-border px-4 py-3 text-[16px] sm:text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-amber-500/60 transition-colors"
                  style={{ minHeight: "60px", maxHeight: "300px" }}
                />
              </div>

              {/* Action buttons */}
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/60 bg-secondary/60">
                <button
                  onClick={() => { setEditing(false); setEditText(message.content); }}
                  className="text-[12px] px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                >
                  Cancel
                </button>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">{editText.length} chars</span>
                  <button
                    onClick={handleEditSubmit}
                    disabled={!editText.trim()}
                    className="text-[12px] px-4 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold disabled:opacity-30 hover:opacity-90 tech-transition flex items-center gap-1.5"
                  >
                    <span>↑</span> Send
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ═══ Normal user bubble — compact, right-aligned, no avatar ═══ */
          <div className="max-w-[88%] sm:max-w-[78%]">
            <div
              onDoubleClick={() => { setEditText(message.content); setEditing(true); }}
              className="px-4 py-2.5 text-[13px] sm:text-sm leading-relaxed bg-primary/15 text-foreground rounded-2xl rounded-tr-md cursor-pointer select-none hover:bg-primary/20 tech-transition"
              title="Double-click to edit"
            >
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            </div>
            <div className="flex items-center justify-end gap-2 mt-1 pr-0.5 opacity-100 transition-opacity">
              {message.content.trim() && (
                <MessageActionBar
                  content={message.content}
                  messageId={message.id}
                  role="user"
                  onEdit={() => { setEditText(message.content); setEditing(true); }}
                />
              )}
              <div className="text-[10px] text-muted-foreground">{timestamp}</div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ═══ Assistant message — no bubble, renders directly ═══
  return (
    <div className="group">
      {/* Content renders directly in the chat window — no wrapper bubble.
          ThinkingContainer, code blocks, and artifact cards have their own
          visual containers. Only the timestamp and action bar are added. */}
      <MarkdownMessage
        content={message.content}
        streaming={message.streaming}
        toolEvents={message.toolEvents}
        progressLines={message.progressLines}
        isThinkingActive={message.isThinkingActive}
        reasoningBlocks={message.reasoningBlocks}
        onChoice={onChoice}
        sessionId={sessionId}
      />
      {/* Inline artifact cards */}
      {artifactEvents.length > 0 && (
        <div className="mt-3 space-y-2">
          {artifactEvents.map((a, i) => (
            <ArtifactCard
              key={`${a.path}-${i}`}
              artifact={a}
              sessionId={sessionId}
              onOpen={onFileOpen}
            />
          ))}
        </div>
      )}
      <GenerativeUIPanel
        agentState={message.agentState}
        customEvents={message.customEvents}
      />
      {!message.streaming && (
        <div className="flex items-center gap-2 mt-1.5 opacity-100 transition-opacity">
          {message.content.trim() && (
            <MessageActionBar
              content={message.content}
              messageId={message.id}
              role="assistant"
              onRetry={onRetry}
            />
          )}
          <div className="text-[10px] text-muted-foreground">{timestamp}</div>
        </div>
      )}
    </div>
  );
}
