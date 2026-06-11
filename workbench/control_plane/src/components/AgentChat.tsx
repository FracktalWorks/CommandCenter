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
import { parseAgentError } from "@/lib/parseAgentError";
import type { ParsedAgentError } from "@/lib/parseAgentError";
import { getMessages, saveMessages, fetchMessagesFromDb, type PersistedMessage } from "@/lib/sessions";
import { useAgentEvents } from "@/lib/agentEvents";
import { buildFrontendToolsAddendum } from "@/hooks/useFrontendTool";

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
            <p className="mt-1 text-xs text-zinc-400 leading-relaxed">{parsed.detail}</p>
          )}
          <div className="mt-2 flex items-start gap-1.5">
            <span className="text-amber-500 shrink-0 text-xs mt-0.5">→</span>
            <p className="text-xs text-amber-400/90 leading-relaxed">{parsed.suggestion}</p>
          </div>
        </div>
        <button
          onClick={handleCopy}
          title="Copy full error"
          className="shrink-0 text-[10px] px-2 py-1 rounded border border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors mt-0.5 whitespace-nowrap"
        >
          {copied ? "Copied!" : "Copy error"}
        </button>
      </div>
      {!compact && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            {expanded ? "▲ Hide full error" : "▼ Show full error"}
          </button>
          {expanded && (
            <pre className="mt-1.5 text-[10px] text-zinc-500 bg-zinc-900/60 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
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

type SendMode = "send" | "queue" | "steer";

const SEND_MODE_LABELS: Record<SendMode, string> = {
  send: "Send",
  queue: "Queue",
  steer: "Steer",
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
  useEffect(() => {
    setLastModel(currentAgentName, currentModel);
    incrementModelUsage(currentModel);
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

  const { messages, isLoading, error, sendMessage, stopGeneration, setMessages } = useAgentChat({
    agentName: currentAgentName,
    threadId: sessionId,
    model: currentModel,
    mode: effectiveRuntime,
    systemContext,
    thinkMode,
    onArtifact,
    // Load persisted messages so switching sessions restores history instantly (localStorage cache).
    initialMessages: getMessages(sessionId) as ChatMessage[],
  });

  // On mount, fetch the authoritative message history from Postgres and sync
  // the local state if Postgres has more/newer messages (e.g. after cache clear).
  useEffect(() => {
    let cancelled = false;
    fetchMessagesFromDb(sessionId).then((remote) => {
      if (cancelled || remote.length === 0) return;
      // Only update if Postgres has data that the local cache doesn't.
      const localCount = getMessages(sessionId).length;
      if (remote.length > localCount) {
        setMessages(remote as ChatMessage[]);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Persist messages to localStorage + Postgres whenever they change.
  // We skip mid-stream placeholder messages (streaming=true, content empty)
  // to avoid saving incomplete assistant turns.
  useEffect(() => {
    const settled = messages.filter((m) => !m.streaming || m.content.trim().length > 0);
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
    }));
    saveMessages(sessionId, toSave);
  }, [messages, sessionId]);

  const [input, setInput] = useState("");
  const [sendMode, setSendMode] = useState<SendMode>("send");
  const [showSendMenu, setShowSendMenu] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const queueRef = useRef<string[]>([]);
  const prevLoadingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [statuses, setStatuses] = useState<IntegrationStatus[]>(externalStatuses ?? []);
  const [viewerEntry, setViewerEntry] = useState<FileEntry | null>(null);

  // ── HITL (Human-in-the-Loop) confirmation state ────────────────────────
  const [confirmation, setConfirmation] = useState<{
    id: string; title: string; detail?: string; context?: string;
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
    },
    onRunFinalized: () => {
      // Clear any stale confirmation when a run completes
      setConfirmation((prev) => prev ? null : prev);
    },
  });

  // Keep a live ref to messages so the unmount handler can save the latest.
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Save messages on beforeunload so partial streams survive browser close.
  useEffect(() => {
    const handleUnload = () => {
      const msgs = messagesRef.current;
      const settled = msgs.filter((m) => !m.streaming || m.content.trim().length > 0);
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
      }));
      // Use sendBeacon for reliable delivery during page unload
      const payload = toSave.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        tool_events: m.toolEvents ?? [],
        progress_lines: m.progressLines ?? [],
        reasoning: m.reasoningBlocks ?? null,
        agent_state: m.agentState ?? null,
        custom_events: m.customEvents ?? [],
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
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

  // Searchable model picker state
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const filteredModels = modelSearch.trim()
    ? sortedModels.filter(
        (m) =>
          m.label.toLowerCase().includes(modelSearch.toLowerCase()) ||
          m.id.toLowerCase().includes(modelSearch.toLowerCase()) ||
          m.group.toLowerCase().includes(modelSearch.toLowerCase())
      )
    : sortedModels;
  const filteredGroups = Array.from(new Set(filteredModels.map((m) => m.group)));

  // Close model menu on outside click
  useEffect(() => {
    if (!showModelMenu) return;
    const handleOutside = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
        setModelSearch("");
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [showModelMenu]);

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

  // ── Todos (VS Code Copilot-style collapsible section) ──────────────
  const [todosExpanded, setTodosExpanded] = useState(true);
  // Derive todos from tool events in the latest assistant message
  const todos = useMemo(() => {
    const lastAsst = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAsst?.toolEvents) return [];
    return lastAsst.toolEvents.map((t) => ({
      id: t.id,
      label: t.name.replace(/_/g, " "),
      done: t.status === "done" || t.status === "error",
      error: t.status === "error",
    }));
  }, [messages]);
  const doneCount = todos.filter((t) => t.done).length;

  return (
    <div className="flex flex-col h-full">
      {/* Agent header — VS Code-style minimal bar */}
      <div className="flex items-center gap-2 px-3 sm:px-4 py-1 sm:py-1.5 border-b border-zinc-800/40 bg-zinc-900/30 shrink-0">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isLoading ? "bg-amber-400 animate-pulse" : "bg-emerald-500"}`} />
        <span className="text-[11px] font-medium text-zinc-300 truncate">{currentAgentName}</span>
        {isLoading && (
          <span className="hidden sm:inline text-[10px] text-amber-400/70 animate-pulse">thinking…</span>
        )}
        {agentRuntime === "github-copilot" && currentAgentEntry?.repo_url && (
          <a href={currentAgentEntry.repo_url} target="_blank" rel="noopener noreferrer"
            className="shrink-0 text-zinc-600 hover:text-zinc-300 transition-colors ml-auto"
            title={`Source: ${currentAgentEntry.repo_name ?? currentAgentEntry.repo_url}`}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
        )}
      </div>

      {/* Missing integrations banner (compact) */}
      {!bannerDismissed && missingMandatory.length > 0 && (
        <div className="shrink-0 border-b border-amber-800/30 bg-amber-950/20 px-3 py-1.5 flex items-center gap-2 text-[11px]">
          <span className="text-amber-400">⚡</span>
          <span className="text-amber-300/80">{missingMandatory.length} integration{missingMandatory.length > 1 ? "s" : ""} not configured</span>
          <button onClick={() => setBannerDismissed(true)} className="ml-auto text-zinc-500 hover:text-zinc-300">✕</button>
        </div>
      )}

      {/* ── Todos section (VS Code Copilot style) ────────────────────── */}
      {todos.length > 0 && (
        <div className="shrink-0 border-b border-zinc-800/40 bg-zinc-900/20">
          <button
            onClick={() => setTodosExpanded((v) => !v)}
            className="w-full flex items-center gap-2 px-3 sm:px-4 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"
              className={`transition-transform ${todosExpanded ? "rotate-0" : "-rotate-90"}`}>
              <path d="M4 6l4 4 4-4" />
            </svg>
            <span className="font-medium">Todos ({doneCount}/{todos.length})</span>
          </button>
          {todosExpanded && (
            <div className="px-3 sm:px-8 pb-1.5 space-y-0.5">
              {todos.map((t) => (
                <div key={t.id} className="flex items-center gap-2 text-[11px]">
                  <span className={t.done ? (t.error ? "text-red-400" : "text-emerald-400") : "text-zinc-600"}>
                    {t.done ? (t.error ? "✗" : "✓") : "○"}
                  </span>
                  <span className={t.done ? "text-zinc-500" : "text-zinc-300"}>{t.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Message thread */}
      <div ref={threadRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-2 space-y-3 relative scrollbar-thin">
        {/* Scroll-to-bottom floating button */}
        {showScrollBtn && (
          <button onClick={scrollToBottom}
            className="sticky bottom-3 left-1/2 -translate-x-1/2 z-10 w-8 h-8 rounded-full bg-zinc-700 border border-zinc-600 text-zinc-300 shadow-lg flex items-center justify-center hover:bg-zinc-600 hover:text-zinc-100 transition-all animate-bounce-subtle"
            aria-label="Scroll to bottom">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        )}

        <div className="max-w-3xl mx-auto">
          {/* Stream interrupted notice */}
          {!isLoading && messages.length > 0 && (() => {
            const last = messages[messages.length - 1];
            const wasInterrupted = last?.role === "assistant" && last.content && !/[.?!]\s*$/.test(last.content.trim());
            return wasInterrupted ? (
              <div className="rounded-lg border border-amber-800/30 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-400/80">
                ⚡ Stream was interrupted. Messages are saved — you can continue chatting below.
              </div>
            ) : null;
          })()}
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
              <div className="text-zinc-400 text-sm font-medium">
                Chat with <span className="text-zinc-200">{currentAgentName}</span>
              </div>
              {agentDescription && currentAgentName === agentName && (
                <div className="text-zinc-600 text-xs max-w-xs">{agentDescription}</div>
              )}
              <div className="text-zinc-600 text-xs mt-2">Type a message to begin.</div>
              <SuggestionPills
                suggestions={AGENT_SUGGESTIONS[currentAgentName] ?? DEFAULT_SUGGESTIONS}
                onPick={handleChoice}
              />
            </div>
          )}

          {messages.map((msg, i) => {
            const prevMsg = i > 0 ? messages[i - 1] : null;
            const showDateDivider = prevMsg &&
              new Date(msg.timestamp).toDateString() !== new Date(prevMsg.timestamp).toDateString();
            return (
              <div key={msg.id} className="animate-fade-in">
                {showDateDivider && (
                  <div className="flex items-center gap-3 my-4">
                    <div className="flex-1 h-px bg-zinc-800" />
                    <span className="text-[10px] text-zinc-600 font-medium shrink-0">
                      {new Date(msg.timestamp).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                    </span>
                    <div className="flex-1 h-px bg-zinc-800" />
                  </div>
                )}
                <MessageBubble message={msg} sessionId={sessionId} onChoice={handleChoice}
                  onFileOpen={(entry) => setViewerEntry(entry)}
                  onResend={(content) => { submitText(content); }} />
              </div>
            );
          })}

          {confirmation && (
            <ConfirmationCard title={confirmation.title} detail={confirmation.detail} context={confirmation.context}
              onApprove={() => { submitText(`APPROVE: ${confirmation.id}`); setConfirmation(null); }}
              onReject={() => { submitText(`REJECT: ${confirmation.id}`); setConfirmation(null); }} />
          )}

          {!isLoading && messages.length > 0 && (() => {
            const last = messages[messages.length - 1];
            if (last?.role === "assistant" && last.content.trim() && !last.streaming) {
              return (
                <div className="ml-0">
                  <SuggestionPills suggestions={AGENT_SUGGESTIONS[currentAgentName] ?? DEFAULT_SUGGESTIONS}
                    onPick={handleChoice} label="Follow up" />
                </div>
              );
            }
            return null;
          })()}

          {error && !isLoading && <ErrorCard parsed={parseAgentError(error)} />}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* ── Input area + VS Code-style bottom bar ─────────────────────── */}
      <form onSubmit={handleSubmit} className="shrink-0 border-t border-zinc-800/40 bg-zinc-900/40 px-2 sm:px-4 pt-1 pb-1.5">
        {/* Feather gradient */}
        <div className="h-5 -mt-6 mb-0.5 pointer-events-none bg-gradient-to-t from-zinc-900/40 to-transparent" />

        {queuedCount > 0 && (
          <div className="mb-1 flex items-center gap-2 text-[11px] text-amber-400">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            {queuedCount} message{queuedCount > 1 ? "s" : ""} queued
            <button type="button" onClick={() => { queueRef.current = []; setQueuedCount(0); }}
              className="text-zinc-500 hover:text-zinc-300 underline">clear</button>
          </div>
        )}

        <div className="max-w-3xl mx-auto">
          {/* Input row */}
          <div className="flex items-end gap-1.5 sm:gap-2">
            <FileUploadButton sessionId={sessionId}
              onUploadComplete={(files) => {
                const names = files.map((f) => f.name).join(", ");
                const paths = files.map((f) => `\`${f.path}\``).join(", ");
                const ctx = `📎 Uploaded ${files.length} file(s): ${names}\n\nThese files are available in the workspace at:\n${paths}\n\nYou can read them with the read_file tool. Refer to them whenever I mention the uploaded content.`;
                setInput((prev) => prev.trim() ? `${prev}\n\n${ctx}` : ctx);
                inputRef.current?.focus();
              }}
              className="shrink-0 self-center mb-0.5" />

            <div className="flex-1 relative">
              <textarea ref={inputRef} value={input}
                onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} rows={1}
                placeholder={
                  isLoading
                    ? `${SEND_MODE_LABELS[sendMode]} a follow-up to ${currentAgentName}…`
                    : `Message ${currentAgentName}…`
                }
                className="w-full resize-none rounded-lg bg-zinc-800/80 border border-zinc-700/80 px-3 py-2 text-[16px] sm:text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 max-h-32 overflow-y-auto transition-colors"
                style={{ minHeight: "40px" }}
                onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 128)}px`; }} />
            </div>

            {/* Contextual send button: idle → simple send, running → stop or follow-up */}
            {isLoading ? (
              input.trim() ? (
                /* Agent is running AND user typed a follow-up — show Send/Queue/Steer */
                <div className="relative shrink-0 flex items-stretch">
                  <button type="submit"
                    className="h-[40px] pl-3 pr-2 rounded-l-lg bg-zinc-100 text-zinc-900 font-semibold text-xs flex items-center gap-1 hover:bg-white transition-colors"
                    aria-label={SEND_MODE_LABELS[sendMode]}
                    title={`${SEND_MODE_LABELS[sendMode]} (current mode)`}>
                    {sendMode === "send" ? "↑" : sendMode === "queue" ? "⏱" : "⤳"}
                    <span className="text-[11px]">{SEND_MODE_LABELS[sendMode]}</span>
                  </button>
                  <button type="button"
                    onClick={() => setShowSendMenu((v) => !v)}
                    className="h-[40px] px-1.5 rounded-r-lg bg-zinc-200 text-zinc-900 border-l border-zinc-300 hover:bg-white transition-colors text-[10px]"
                    aria-label="Choose send mode" title="Choose how to send">
                    ▾
                  </button>
                  {showSendMenu && (
                    <div className="absolute bottom-full right-0 mb-1 w-56 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl z-50 py-1"
                      onMouseLeave={() => setShowSendMenu(false)}>
                      {(["send", "queue", "steer"] as SendMode[]).map((m) => (
                        <button key={m} type="button"
                          onClick={() => { setSendMode(m); setShowSendMenu(false); }}
                          className={`w-full text-left px-3 py-2 text-xs hover:bg-zinc-800 transition-colors ${m === sendMode ? "text-zinc-100 bg-zinc-800/60" : "text-zinc-400"}`}>
                          <div className="flex items-center justify-between">
                            <span className="font-medium">
                              {m === "send" ? "↑ Send" : m === "queue" ? "⏱ Queue" : "⤳ Steer"}
                            </span>
                            {m === sendMode && <span className="text-emerald-500 text-[10px]">✓</span>}
                          </div>
                          <div className="text-zinc-600 mt-0.5 text-[10px]">
                            {m === "send" ? "Send now (queues if busy)"
                              : m === "queue" ? "Wait for current reply, then send"
                              : "Interrupt current reply and send now"}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                /* Agent is running, no follow-up typed — just Stop */
                <button type="button" onClick={stopGeneration}
                  className="shrink-0 h-[40px] w-[40px] rounded-lg bg-red-900/50 border border-red-700/50 text-red-300 text-sm flex items-center justify-center hover:bg-red-800/70 transition-colors"
                  aria-label="Stop generation">■</button>
              )
            ) : (
              /* Agent is idle — simple Send button */
              <button type="submit" disabled={!input.trim()}
                className="shrink-0 h-[40px] w-[40px] rounded-lg bg-zinc-100 text-zinc-900 font-semibold text-sm flex items-center justify-center disabled:opacity-30 hover:bg-white transition-colors"
                aria-label="Send">↑</button>
            )}
          </div>

          {/* ── Bottom bar (VS Code Copilot style) ──────────────────────── */}
          <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-zinc-500 flex-wrap" ref={modelMenuRef}>
            {/* Agent selector */}
            <div className="relative">
              <button onClick={() => setShowAgentMenu((v) => !v)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-zinc-800 hover:text-zinc-300 transition-colors">
                <span className="w-1 h-1 rounded-full bg-emerald-500 shrink-0" />
                <span className="truncate max-w-[80px]">{currentAgentName}</span>
              </button>
              {showAgentMenu && (
                <div className="absolute bottom-full left-0 mb-1 w-64 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl z-50 py-1"
                  onMouseLeave={() => setShowAgentMenu(false)}>
                  {agents.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-zinc-600">No agents available</div>
                  ) : (
                    agents.map((a) => (
                      <button key={a.name} onClick={() => handleSwitchAgent(a)}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 transition-colors ${a.name === currentAgentName ? "text-zinc-100 bg-zinc-800/60" : "text-zinc-400"}`}>
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-medium">{a.name}</span>
                          {a.name === currentAgentName && <span className="text-emerald-500 text-[10px]">✓</span>}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <span className="text-zinc-700">|</span>

            {/* Model selector */}
            <div className="relative">
              <button onClick={() => { setShowModelMenu((v) => !v); setModelSearch(""); }}
                className="px-1.5 py-0.5 rounded hover:bg-zinc-800 hover:text-zinc-300 transition-colors truncate max-w-[140px]">
                {currentModelLabel}
              </button>
              {showModelMenu && (
                <div className="absolute bottom-full left-0 mb-1 w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl z-50 overflow-hidden">
                  <div className="p-2 border-b border-zinc-800">
                    <input autoFocus type="text" placeholder="Search models…" value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      className="w-full rounded bg-zinc-800 border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500" />
                  </div>
                  <div className="max-h-72 overflow-y-auto py-1">
                    {filteredGroups.length === 0 && (
                      <div className="px-3 py-2 text-xs text-zinc-600 italic">No models match</div>
                    )}
                    {filteredGroups.map((group) => (
                      <div key={group}>
                        <div className="px-3 pt-2 pb-1 text-[9px] text-zinc-600 uppercase tracking-wider font-semibold">{group}</div>
                        {filteredModels.filter((m) => m.group === group).map((m) => (
                          <button key={m.id}
                            onClick={() => { setCurrentModel(m.id); setShowModelMenu(false); setModelSearch(""); }}
                            className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between gap-2 ${m.id === currentModel ? "text-zinc-100 bg-zinc-800/60" : "text-zinc-400 hover:bg-zinc-800"}`}>
                            <span className="truncate">{m.label}</span>
                            {m.id === currentModel && <span className="text-emerald-500 text-[10px]">✓</span>}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <span className="text-zinc-700">|</span>

            {/* Thinking mode toggle */}
            <div className="flex items-center gap-0.5">
              {THINK_MODES.map((tm) => (
                <button key={tm.mode} type="button"
                  onClick={() => setThinkMode(tm.mode)}
                  title={tm.title}
                  className={`px-1.5 py-0.5 rounded transition-colors ${thinkMode === tm.mode ? "text-zinc-200 bg-zinc-800" : "hover:text-zinc-300 hover:bg-zinc-800/50"}`}>
                  {tm.label}
                </button>
              ))}
            </div>

            <span className="text-zinc-700 ml-auto hidden sm:inline">
              {isLoading && sendMode !== "send" && (
                <span className="mr-2 text-amber-400">{sendMode === "queue" ? "⏱ Queue" : "⤳ Steer"} mode</span>
              )}
              Enter to send · Shift+Enter for new line
            </span>
          </div>

          {/* Disclaimer */}
          <p className="text-[9px] text-zinc-600 text-center mt-1.5">
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
}: {
  message: ChatMessage;
  sessionId: string;
  onChoice?: (choice: string) => void;
  onFileOpen?: (entry: FileEntry) => void;
  onResend?: (content: string) => void;
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
    return (
      <div className="text-center text-xs text-zinc-600 italic py-1">
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
            <div className="rounded-2xl rounded-tr-sm border-2 border-amber-500/50 bg-zinc-800 shadow-lg shadow-amber-500/5 overflow-hidden">
              {/* Edit header */}
              <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-700/60 bg-zinc-800/80">
                <span className="text-[11px] text-amber-400/80 font-medium">
                  ✏️ Editing message
                </span>
                <span className="text-[10px] text-zinc-500 hidden sm:block">
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
                  className="w-full resize-none rounded-xl bg-zinc-900 border border-zinc-600 px-4 py-3 text-[16px] sm:text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/60 transition-colors"
                  style={{ minHeight: "60px", maxHeight: "300px" }}
                />
              </div>

              {/* Action buttons */}
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-zinc-700/60 bg-zinc-800/60">
                <button
                  onClick={() => { setEditing(false); setEditText(message.content); }}
                  className="text-[12px] px-3 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60 transition-colors"
                >
                  Cancel
                </button>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-500">{editText.length} chars</span>
                  <button
                    onClick={handleEditSubmit}
                    disabled={!editText.trim()}
                    className="text-[12px] px-4 py-1.5 rounded-lg bg-zinc-100 text-zinc-900 font-semibold disabled:opacity-30 hover:bg-white transition-colors flex items-center gap-1.5"
                  >
                    <span>↑</span> Send
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ═══ Normal user bubble — compact, right-aligned, no avatar ═══ */
          <div className="max-w-[90%] sm:max-w-[80%]">
            <div
              onDoubleClick={() => { setEditText(message.content); setEditing(true); }}
              className="inline-block px-3.5 py-2 text-[12px] sm:text-[13px] leading-relaxed bg-zinc-700 text-zinc-100 rounded-2xl rounded-tr-sm cursor-pointer select-none hover:bg-zinc-600/80 transition-colors"
              title="Double-click to edit"
            >
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            </div>
            <div className="flex items-center justify-end gap-2 mt-1 pr-1">
              <div className="text-[10px] text-zinc-500">{timestamp}</div>
              {message.content.trim() && (
                <MessageActionBar
                  content={message.content}
                  messageId={message.id}
                  role="user"
                  onEdit={() => { setEditText(message.content); setEditing(true); }}
                />
              )}
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
        <div className="flex items-center gap-2 mt-1.5">
          <div className="text-[10px] text-zinc-600">{timestamp}</div>
          {message.content.trim() && (
            <MessageActionBar
              content={message.content}
              messageId={message.id}
              role="assistant"
            />
          )}
        </div>
      )}
    </div>
  );
}
