"use client";

/**
 * AgentChat — chat UI for LangGraph agents routed via the CommandCenter gateway.
 *
 * Used by chat/page.tsx when session.agentName is set to a named agent.
 * Missing integrations are surfaced inline — users can configure them via chat
 * or dismiss the banner and configure later in the Integrations page.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useAgentChat } from "@/hooks/useAgentChat";
import type { ChatMessage } from "@/hooks/useAgentChat";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";
import type { AgentEntry } from "@/app/api/agent/list/route";
import type { UnifiedModel } from "@/app/api/models/all/route";
import MarkdownMessage from "@/components/MarkdownMessage";
import AgentStatusBar from "@/components/AgentStatusBar";
import MessageActionBar from "@/components/MessageActionBar";

// Unified model fallback — overridden at runtime from /api/models/all.
const MODELS_FALLBACK: UnifiedModel[] = [
  { id: "auto",               label: "auto (SDK picks)",   runtime: "copilot", group: "GitHub Copilot SDK" },
  { id: "claude-sonnet-4.5",  label: "Claude Sonnet 4.5",  runtime: "copilot", group: "GitHub Copilot SDK" },
  { id: "claude-haiku-4.5",   label: "Claude Haiku 4.5",   runtime: "copilot", group: "GitHub Copilot SDK" },
  { id: "gpt-5.5",            label: "GPT 5.5",            runtime: "copilot", group: "GitHub Copilot SDK" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", runtime: "copilot", group: "GitHub Copilot SDK" },
  { id: "tier1-local-qwen3",  label: "Tier 1 — Gemini 2.5 Flash Lite (fast/triage)",  runtime: "litellm", group: "LiteLLM (tier routing)" },
  { id: "tier2-sonnet",       label: "Tier 2 — Gemini 2.5 Flash (drafting)",  runtime: "litellm", group: "LiteLLM (tier routing)" },
  { id: "tier3-opus",         label: "Tier 3 — Gemini 2.5 Flash (reasoning)", runtime: "litellm", group: "LiteLLM (tier routing)" },
];

type SendMode = "send" | "queue" | "steer";

const SEND_MODE_LABELS: Record<SendMode, string> = {
  send: "Send",
  queue: "Queue",
  steer: "Steer",
};

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
}: AgentChatProps) {
  // Active agent / model can change mid-chat (VS Code Copilot style).
  const [currentAgentName, setCurrentAgentName] = useState(agentName);
  const [currentModel, setCurrentModel] = useState("auto");
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

  // Resolve the selected model's routing runtime (copilot SDK vs LiteLLM proxy).
  const selectedModel = models.find((m) => m.id === currentModel);
  const currentRuntime = selectedModel?.runtime ?? "copilot";

  // Resolve the active agent's metadata (runtime classification, repo link, etc.)
  // NOTE: computed here (before useAgentChat) so we can override the routing mode.
  const currentAgentEntry = agents.find((a) => a.name === currentAgentName);
  const agentRuntime: string = currentAgentEntry?.agent_runtime ?? "maf";

  // GitHub Copilot SDK agents (repo-sourced) ALWAYS route through the SDK executor,
  // regardless of which model is selected in the picker. The model is forwarded as
  // a hint but the execution path must be "copilot" to reach /agent/run/stream.
  // If we allow "litellm" here the message goes direct to LiteLLM — no tools, no
  // script execution, no SDK.
  const effectiveRuntime = agentRuntime === "github-copilot" ? "copilot" : currentRuntime;

  // System context = persona + persistent memories (sent as system message).
  const systemContext = useMemo(() => {
    const parts: string[] = [];
    if (persona) parts.push(persona);
    if (memories && memories.length > 0) {
      parts.push(
        "Memories from past conversations with this user — use them for continuity:\n" +
          memories.map((m) => `• ${m}`).join("\n")
      );
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }, [persona, memories]);

  const { messages, isLoading, error, sendMessage, stopGeneration } = useAgentChat({
    agentName: currentAgentName,
    threadId: sessionId,
    model: currentModel,
    mode: effectiveRuntime,
    systemContext,
  });

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

  // Keep a live ref to messages so the unmount handler can save the latest.
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
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

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
        stopGeneration();
        enqueue(trimmed, true); // jump the queue, sent as soon as the stream stops
      } else {
        enqueue(trimmed); // queue (also the fallback for "send" while busy)
      }
    },
    [isLoading, sendMode, sendMessage, stopGeneration, enqueue]
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
    setShowAgentMenu(false);
  }, []);

  const currentModelLabel =
    models.find((m) => m.id === currentModel)?.label ?? currentModel;
  const modelGroups = Array.from(new Set(models.map((m) => m.group)));

  /** Display label + styling for an agent_runtime value. */
  function agentRuntimeMeta(rt: string): { label: string; title: string; cls: string } {
    if (rt === "github-copilot") {
      return {
        label: "GitHub Copilot SDK",
        title: "This agent runs via GitHubCopilotAgent (Microsoft Agent Framework wrapping the GitHub Copilot SDK)",
        cls: "border-sky-700/50 bg-sky-900/30 text-sky-300",
      };
    }
    if (rt === "langgraph") {
      return {
        label: "LangGraph",
        title: "Legacy LangGraph agent runner",
        cls: "border-violet-700/50 bg-violet-900/30 text-violet-300",
      };
    }
    // maf or unknown
    return {
      label: "MAF",
      title: "Microsoft Agent Framework agent (pure MAF, no Copilot SDK)",
      cls: "border-amber-700/50 bg-amber-900/30 text-amber-300",
    };
  }

  return (
    <div className="flex flex-col h-full">
      {/* Agent header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <div className="w-2 h-2 rounded-full bg-emerald-500" />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100">{currentAgentName}</span>
            {/* Agent runtime badge — shows MAF / GitHub Copilot SDK / LangGraph */}
            <span
              className={`text-[9px] px-1.5 py-0.5 rounded-full border ${agentRuntimeMeta(agentRuntime).cls}`}
              title={agentRuntimeMeta(agentRuntime).title}
            >
              {agentRuntimeMeta(agentRuntime).label}
            </span>
            {/* GitHub repo link for GitHub Copilot SDK agents */}
            {agentRuntime === "github-copilot" && currentAgentEntry?.repo_url && (
              <a
                href={currentAgentEntry.repo_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[9px] text-zinc-500 hover:text-zinc-300 transition-colors"
                title={`Source: ${currentAgentEntry.repo_name ?? currentAgentEntry.repo_url}`}
              >
                ↗ {currentAgentEntry.repo_name ?? "repo"}
              </a>
            )}
          </div>
          {agentDescription && currentAgentName === agentName && (
            <div className="text-xs text-zinc-500">{agentDescription}</div>
          )}
        </div>
        <div className="ml-auto text-xs text-zinc-600 font-mono">
          thread: {sessionId.slice(0, 8)}…
        </div>
      </div>

      {/* Agent status bar — identity + integration reachability */}
      <AgentStatusBar
        agentName={currentAgentName}
        integrations={statuses}
        isActive={isLoading}
      />

      {/* Missing integrations banner */}
      {!bannerDismissed && missingMandatory.length > 0 && (
        <div className="shrink-0 border-b border-amber-900/40 bg-amber-950/30 px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-amber-400 mb-1.5">
                {missingMandatory.length} integration{missingMandatory.length > 1 ? "s" : ""} not configured
                — this agent may have limited functionality.
              </p>
              <div className="flex flex-wrap gap-2">
                {missingMandatory.map((svc) => (
                  <button
                    key={svc.service}
                    onClick={() => handleAskAgentConfigure(svc)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-amber-800/60 bg-amber-900/30 px-3 py-1 text-xs text-amber-300 hover:bg-amber-900/60 transition-colors"
                    title={`Ask agent to help configure ${svc.label ?? svc.service}`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                    {svc.label ?? svc.service}
                    <span className="text-amber-600">+ set up</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-zinc-600">
                Click a badge to ask the agent to guide you, or{" "}
                <Link href="/integrations" className="text-zinc-400 underline hover:text-zinc-200">
                  configure in Integrations
                </Link>
                .
              </p>
            </div>
            <button
              onClick={() => setBannerDismissed(true)}
              className="shrink-0 text-zinc-600 hover:text-zinc-400 text-lg leading-none transition-colors"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Message thread */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <div className="text-zinc-400 text-sm font-medium">
              Chat with <span className="text-zinc-200">{currentAgentName}</span>
            </div>
            {agentDescription && currentAgentName === agentName && (
              <div className="text-zinc-600 text-xs max-w-xs">{agentDescription}</div>
            )}
            {missingMandatory.length > 0 ? (
              <div className="text-amber-600 text-xs mt-2 max-w-xs">
                Some integrations need setup. Click a badge above or just start chatting — the agent will guide you.
              </div>
            ) : (
              <div className="text-zinc-600 text-xs mt-2">Type a message to begin.</div>
            )}
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} onChoice={handleChoice} />
        ))}

        {error && !isLoading && (
          <div className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded-lg px-4 py-2">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* VS Code-style toolbar: model picker + agent switcher */}
      <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/60 px-4 py-2 flex items-center gap-2">
        {/* Model picker */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Model</span>
          <select
            value={currentModel}
            onChange={(e) => setCurrentModel(e.target.value)}
            disabled={isLoading}
            className="text-xs bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1 text-zinc-300 focus:outline-none focus:border-zinc-500 disabled:opacity-50 cursor-pointer max-w-[200px]"
          >
            {modelGroups.map((group) => (
              <optgroup key={group} label={group}>
                {models
                  .filter((m) => m.group === group)
                  .map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
              </optgroup>
            ))}
          </select>
          <span
            className={`text-[9px] px-1.5 py-0.5 rounded-full border ${
              currentRuntime === "litellm"
                ? "border-violet-700/50 bg-violet-900/30 text-violet-300"
                : "border-sky-700/50 bg-sky-900/30 text-sky-300"
            }`}
            title={currentRuntime === "litellm" ? "Routed via LiteLLM proxy" : "Routed via GitHub Copilot SDK"}
          >
            {currentRuntime === "litellm" ? "LiteLLM" : "Copilot"}
          </span>
        </div>

        {/* Divider */}
        <div className="w-px h-4 bg-zinc-700" />

        {/* Agent switcher */}
        <div className="relative flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Agent</span>
          <button
            onClick={() => setShowAgentMenu((v) => !v)}
            disabled={isLoading}
            className="flex items-center gap-1 text-xs bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1 text-zinc-300 hover:border-zinc-500 focus:outline-none disabled:opacity-50 transition-colors"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
            {currentAgentName}
            <span className="text-zinc-500 ml-0.5">▾</span>
          </button>
          {/* Agent runtime badge in toolbar */}
          <span
            className={`text-[9px] px-1.5 py-0.5 rounded-full border ${agentRuntimeMeta(agentRuntime).cls}`}
            title={agentRuntimeMeta(agentRuntime).title}
          >
            {agentRuntimeMeta(agentRuntime).label}
          </span>

          {/* Agent dropdown */}
          {showAgentMenu && (
            <div
              className="absolute bottom-full left-0 mb-1 w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl z-50 py-1"
              onMouseLeave={() => setShowAgentMenu(false)}
            >
              {agents.length === 0 ? (
                <div className="px-3 py-2 text-xs text-zinc-600">No agents available</div>
              ) : (
                agents.map((a) => (
                  <button
                    key={a.name}
                    onClick={() => handleSwitchAgent(a)}
                    className={`w-full text-left px-3 py-2.5 text-xs hover:bg-zinc-800 transition-colors ${
                      a.name === currentAgentName ? "text-zinc-100 bg-zinc-800/60" : "text-zinc-400"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-medium">{a.name}</span>
                      <div className="flex items-center gap-1.5 ml-auto shrink-0">
                        {/* Per-agent runtime badge in the dropdown */}
                        {(() => {
                          const rt = a.agent_runtime ?? "maf";
                          const m = agentRuntimeMeta(rt);
                          return (
                            <span
                              className={`text-[8px] px-1 py-0.5 rounded-full border ${m.cls}`}
                              title={m.title}
                            >
                              {m.label}
                            </span>
                          );
                        })()}
                        {a.name === currentAgentName && (
                          <span className="text-emerald-500 text-[10px]">✓</span>
                        )}
                      </div>
                    </div>
                    {a.description && (
                      <div className="text-zinc-600 mt-0.5 truncate">{a.description}</div>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Right side: current model label pill */}
        <div className="ml-auto">
          <span className="text-[10px] text-zinc-600 font-mono">{currentModelLabel}</span>
        </div>
      </div>

      {/* Input area */}
      <form
        onSubmit={handleSubmit}
        className="shrink-0 border-t border-zinc-800 bg-zinc-900/80 px-4 py-3"
      >
        {queuedCount > 0 && (
          <div className="mb-2 flex items-center gap-2 text-[11px] text-amber-400">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            {queuedCount} message{queuedCount > 1 ? "s" : ""} queued
            <button
              type="button"
              onClick={() => { queueRef.current = []; setQueuedCount(0); }}
              className="text-zinc-500 hover:text-zinc-300 underline"
            >
              clear
            </button>
          </div>
        )}
        <div className="flex items-end gap-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={
              isLoading
                ? `${SEND_MODE_LABELS[sendMode]} a follow-up to ${currentAgentName}…`
                : `Message ${currentAgentName}…`
            }
            className="flex-1 resize-none rounded-xl bg-zinc-800 border border-zinc-700 px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 max-h-40 overflow-y-auto"
            style={{ minHeight: "44px" }}
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = "auto";
              t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
            }}
          />

          {/* Stop button (only while generating) */}
          {isLoading && (
            <button
              type="button"
              onClick={stopGeneration}
              className="shrink-0 h-[44px] w-[44px] rounded-xl bg-red-900/60 border border-red-700/60 text-red-300 text-base flex items-center justify-center hover:bg-red-800/80 transition-colors"
              aria-label="Stop generation"
              title="Stop generation"
            >
              ■
            </button>
          )}

          {/* Send split-button: primary action + mode selector */}
          <div className="relative shrink-0 flex items-stretch">
            <button
              type="submit"
              disabled={!input.trim()}
              className="h-[44px] pl-4 pr-3 rounded-l-xl bg-zinc-100 text-zinc-900 font-semibold text-sm flex items-center gap-1.5 disabled:opacity-30 hover:bg-white transition-colors"
              aria-label={SEND_MODE_LABELS[sendMode]}
              title={`${SEND_MODE_LABELS[sendMode]} (current mode)`}
            >
              {sendMode === "send" ? "↑" : sendMode === "queue" ? "⏱" : "⤳"}
              <span className="text-xs">{SEND_MODE_LABELS[sendMode]}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowSendMenu((v) => !v)}
              className="h-[44px] px-2 rounded-r-xl bg-zinc-200 text-zinc-900 border-l border-zinc-300 hover:bg-white transition-colors text-xs"
              aria-label="Choose send mode"
              title="Choose how to send"
            >
              ▾
            </button>

            {showSendMenu && (
              <div
                className="absolute bottom-full right-0 mb-1 w-60 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl z-50 py-1"
                onMouseLeave={() => setShowSendMenu(false)}
              >
                {(["send", "queue", "steer"] as SendMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => { setSendMode(m); setShowSendMenu(false); }}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-zinc-800 transition-colors ${
                      m === sendMode ? "text-zinc-100 bg-zinc-800/60" : "text-zinc-400"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">
                        {m === "send" ? "↑ Send" : m === "queue" ? "⏱ Queue" : "⤳ Steer"}
                      </span>
                      {m === sendMode && <span className="text-emerald-500 text-[10px]">✓</span>}
                    </div>
                    <div className="text-zinc-600 mt-0.5">
                      {m === "send"
                        ? "Send now (queues if busy)"
                        : m === "queue"
                        ? "Wait for the current reply, then send"
                        : "Interrupt the current reply and send now"}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

// ─── Message bubble ─────────────────────────────────────────────────────────

function MessageBubble({
  message,
  onChoice,
}: {
  message: ChatMessage;
  onChoice?: (choice: string) => void;
}) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="text-center text-xs text-zinc-600 italic py-1">
        {message.content}
      </div>
    );
  }

  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isUser) {
    return (
      <div className="flex items-start gap-3 flex-row-reverse">
        <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold bg-zinc-600 text-zinc-200">
          U
        </div>
        <div className="max-w-[75%] px-4 py-3 text-sm leading-relaxed bg-zinc-700 text-zinc-100 rounded-2xl rounded-tr-sm">
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
          <div className="mt-1.5 text-[10px] text-zinc-400 text-right">{timestamp}</div>
        </div>
      </div>
    );
  }

  // Assistant message — full rich markdown rendering
  return (
    <div className="flex items-start gap-3 group">
      <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold bg-zinc-700 text-zinc-300">
        A
      </div>
      <div className="min-w-0 flex-1 max-w-[90%] px-4 py-3 bg-zinc-800/70 rounded-2xl rounded-tl-sm">
        <MarkdownMessage
          content={message.content}
          streaming={message.streaming}
          toolEvents={message.toolEvents}
          progressLines={message.progressLines}
          isThinkingActive={message.isThinkingActive}
          reasoning={message.reasoning}
          onChoice={onChoice}
        />
        {!message.streaming && (
          <>
            <div className="mt-2 text-[10px] text-zinc-600">{timestamp}</div>
            {message.content.trim() && (
              <MessageActionBar content={message.content} messageId={message.id} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
