"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  getSessions,
  upsertSession,
  deleteSession,
  createSession,
  enrichSession,
  fetchAndMergeSessionsFromDb,
  type ChatSession,
} from "@/lib/sessions";
import type { Mem0Memory } from "@/lib/memory";
import AgentChat from "@/components/AgentChat";
import type { AgentEntry } from "@/app/api/agent/list/route";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";

// Default agent names that carry persistent Mem0 memory + the CommandCenter persona.
const MEMORY_AGENTS = new Set(["orchestrator", "default"]);

// CommandCenter persona injected as system context for the default agent.
const COMMANDCENTER_PERSONA =
  "You are CommandCenter, the AI operations brain for Fracktal Works. You help the team " +
  "with tasks, project tracking, the sales pipeline, and company intelligence. You have " +
  "access to memories from past conversations — use them for continuity. When you take " +
  "actions that modify company data, confirm before proceeding. Be concise and direct.";

// ---------------------------------------------------------------------------
// Agent picker modal — shown on "+ New session"
// ---------------------------------------------------------------------------

function AgentPickerModal({
  onSelect,
  onClose,
}: {
  onSelect: (agentName: string, description?: string, agentEntry?: AgentEntry) => void;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Integration statuses fetched in background to show "needs setup" badges
  const [allStatuses, setAllStatuses] = useState<IntegrationStatus[]>([]);

  useEffect(() => {
    fetch("/api/agent/list")
      .then((r) => r.json())
      .then((data: AgentEntry[]) => setAgents(data))
      .catch(() => {})
      .finally(() => setLoading(false));
    // Fetch integration statuses in background for badges
    fetch("/api/integrations/status")
      .then((r) => r.json())
      .then((data: IntegrationStatus[]) => setAllStatuses(data))
      .catch(() => {});
  }, []);

  /** True when all mandatory integrations for this agent are already configured. */
  function isReady(agent: AgentEntry): boolean {
    if (!agent.integrations?.length) return true;
    if (!allStatuses.length) return true; // not loaded yet — optimistic
    return agent.integrations.every((svc) => {
      const s = allStatuses.find((st) => st.service === svc);
      return !s || s.configured;
    });
  }

  const handleAgentClick = (agent: AgentEntry) => {
    // Always allow — missing integrations are surfaced as a banner inside the
    // chat window so users can configure them conversationally.
    onSelect(agent.name, agent.description, agent);
  };

  const needsSetupBadge = (agent: AgentEntry) =>
    allStatuses.length > 0 && !isReady(agent);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-zinc-100">New session</div>
            <div className="text-xs text-zinc-500 mt-0.5">Choose an agent to chat with</div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Default — CommandCenter */}
        <div className="mb-2">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-600 mb-1.5">
            Default
          </div>
          <button
            onClick={() => onSelect("orchestrator", "CommandCenter — AI company brain")}
            className="w-full text-left rounded-lg border border-zinc-700 bg-zinc-800/60 px-4 py-3 hover:border-zinc-500 hover:bg-zinc-800 transition-colors"
          >
            <div className="text-sm font-medium text-zinc-100">CommandCenter</div>
            <div className="text-xs text-zinc-500 mt-0.5">General-purpose AI company brain</div>
          </button>
        </div>

        {/* MAF Agents */}
        <div className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-600 mb-1.5">
            MAF agents
          </div>
          {loading ? (
            <div className="text-xs text-zinc-600 py-2 text-center">Loading agents…</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
              {agents.map((a) => (
                <div key={a.name}>
                  <button
                    onClick={() => handleAgentClick(a)}
                    className="w-full text-left rounded-lg border border-zinc-700/60 bg-zinc-800/40 px-4 py-3 hover:border-zinc-500 hover:bg-zinc-800 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium text-zinc-100">{a.name}</div>
                      <div className="flex items-center gap-1.5">
                        {/* Agent runtime badge in picker */}
                        {a.agent_runtime === "github-copilot" ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-sky-700/50 bg-sky-900/30 text-sky-300">
                            Copilot SDK
                          </span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-amber-700/40 bg-amber-900/20 text-amber-400">
                            MAF
                          </span>
                        )}
                        {needsSetupBadge(a) && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-900/40 text-orange-400 border border-orange-700/50">
                            ⚙ Setup needed
                          </span>
                        )}
                        {a.tags.slice(0, 2).map((t) => (
                          <span
                            key={t}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">{a.description}</div>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory panel shown in the left sidebar
// ---------------------------------------------------------------------------

function MemoryPanel({
  memories,
  userId,
  onDelete,
}: {
  memories: Mem0Memory[];
  userId: string;
  onDelete: (id: string) => void;
}) {
  const configured = process.env.NEXT_PUBLIC_MEM0_CONFIGURED === "true";

  if (memories.length === 0) {
    return (
      <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Memory
        </div>
        <p className="mt-1.5 text-xs text-zinc-600">
          {configured
            ? "No memories yet. CommandCenter will learn from your conversations."
            : "Mem0 not configured. Set MEM0_API_URL to enable persistent memory."}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Memory ({memories.length})
        </div>
      </div>
      <ul className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
        {memories.map((m) => (
          <li key={m.id} className="group flex items-start gap-1.5">
            <span className="mt-0.5 shrink-0 text-zinc-600">•</span>
            <span className="text-xs text-zinc-400 leading-relaxed flex-1">
              {m.memory}
            </span>
            <button
              onClick={() => onDelete(m.id)}
              className="ml-1 shrink-0 text-zinc-700 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity text-xs"
              title="Delete memory"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session list in the left sidebar
// ---------------------------------------------------------------------------

function SessionList({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  sessions: ChatSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={onNew}
        className="mb-2 w-full rounded-md bg-zinc-800 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
      >
        + New session
      </button>
      {sessions.length === 0 && (
        <p className="px-1 text-xs text-zinc-600">No sessions yet.</p>
      )}
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`group flex items-start justify-between rounded-md px-3 py-2 cursor-pointer transition-colors ${
            s.id === activeId
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"
          }`}
          onClick={() => onSelect(s.id)}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{s.title ?? s.name}</div>
            {s.lastPreview ? (
              <div className="truncate text-xs text-zinc-500">{s.lastPreview}</div>
            ) : null}
            <div className="text-xs text-zinc-600">
              {s.messageCount > 0 ? `${s.messageCount} msgs · ` : ""}
              {s.agentName}
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(s.id);
            }}
            className="ml-2 shrink-0 text-zinc-700 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity text-xs"
            title="Delete session"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

const DEFAULT_USER_ID = "default"; // Replace with session.user.id once SSO is wired

function ChatPageInner() {
  const searchParams = useSearchParams();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [memories, setMemories] = useState<Mem0Memory[]>([]);
  const [memoriesLoaded, setMemoriesLoaded] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  // Fetch agents once at page level so AgentChat knows agent_runtime before first render.
  const [agentList, setAgentList] = useState<AgentEntry[]>([]);
  useEffect(() => {
    fetch("/api/agent/list")
      .then((r) => r.json())
      .then((data: AgentEntry[]) => { if (Array.isArray(data)) setAgentList(data); })
      .catch(() => {});
  }, []);

  // Load sessions from localStorage on mount.
  // If ?agent=<name> is in the URL, immediately open a new session for that agent.
  useEffect(() => {
    const agentParam = searchParams?.get("agent");
    const existing = getSessions();
    if (agentParam) {
      // Find an existing session for this agent or create a fresh one.
      const existing2 = getSessions();
      const match = existing2.find((s) => s.agentName === agentParam);
      if (match) {
        setSessions(getSessions());
        setActiveSessionId(match.id);
      } else {
        const fresh = createSession(agentParam);
        upsertSession(fresh);
        setSessions(getSessions());
        setActiveSessionId(fresh.id);
      }
    } else if (existing.length === 0) {
      const fresh = createSession();
      upsertSession(fresh);
      setSessions([fresh]);
      setActiveSessionId(fresh.id);
    } else {
      setSessions(existing);
      setActiveSessionId(existing[0].id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After initial localStorage render, fetch from Postgres and merge any sessions
  // that exist there but not in the browser (e.g. after cache clear or new device).
  useEffect(() => {
    fetchAndMergeSessionsFromDb().then((merged) => {
      setSessions(merged);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch memories from Mem0 (or return [] gracefully).
  useEffect(() => {
    fetch(`/api/chat/memories?userId=${DEFAULT_USER_ID}`)
      .then((r) => r.json())
      .then((data: Mem0Memory[]) => {
        setMemories(Array.isArray(data) ? data : []);
        setMemoriesLoaded(true);
      })
      .catch(() => setMemoriesLoaded(true));
  }, []);

  const handleNewSession = useCallback(() => {
    setShowPicker(true);
  }, []);

  const handleSelectAgent = useCallback(
    (agentName: string, _description?: string, _agentEntry?: AgentEntry) => {
      setShowPicker(false);
      const s = createSession(agentName);
      upsertSession(s);
      setSessions(getSessions());
      setActiveSessionId(s.id);
    },
    []
  );

  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id);
  }, []);

  const handleDeleteSession = useCallback(
    (id: string) => {
      deleteSession(id);
      const remaining = getSessions();
      setSessions(remaining);
      if (id === activeSessionId) {
        if (remaining.length > 0) {
          setActiveSessionId(remaining[0].id);
        } else {
          const fresh = createSession();
          upsertSession(fresh);
          setSessions([fresh]);
          setActiveSessionId(fresh.id);
        }
      }
    },
    [activeSessionId]
  );

  const handleDeleteMemory = useCallback(async (memoryId: string) => {
    await fetch(`/api/chat/memories?id=${memoryId}`, { method: "DELETE" });
    setMemories((prev) => prev.filter((m) => m.id !== memoryId));
  }, []);

  // Enrich the active session (auto-title + last-turn preview) as the chat runs.
  const handleActivity = useCallback(
    (
      id: string,
      info: { firstUserMessage?: string; lastPreview?: string; messageCount: number },
    ) => {
      enrichSession(id, info);
      setSessions(getSessions());
    },
    [],
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="flex h-full min-h-screen">
      {/* Agent picker modal */}
      {showPicker && (
        <AgentPickerModal
          onSelect={handleSelectAgent}
          onClose={() => setShowPicker(false)}
        />
      )}

      {/* Left panel — sessions + memory */}
      <aside className="w-72 shrink-0 border-r border-zinc-800 bg-zinc-900/40 flex flex-col p-4 overflow-y-auto">
        <div className="mb-4">
          <div className="text-sm font-semibold text-zinc-200">Conversations</div>
          <div className="text-xs text-zinc-500 mt-0.5">
            Unified chat · Copilot SDK + LiteLLM
          </div>
        </div>

        <SessionList
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={handleSelectSession}
          onNew={handleNewSession}
          onDelete={handleDeleteSession}
        />

        {memoriesLoaded && (
          <MemoryPanel
            memories={memories}
            userId={DEFAULT_USER_ID}
            onDelete={handleDeleteMemory}
          />
        )}

        <div className="mt-auto pt-6 text-xs text-zinc-600">
          Memory persists to Mem0 · Sessions in localStorage
        </div>
      </aside>

      {/* Right panel — chat (unified AgentChat for every session) */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {activeSession ? (
          MEMORY_AGENTS.has(activeSession.agentName) ? (
            /*
             * Default CommandCenter session — same unified AgentChat UI, with the
             * CommandCenter persona + persistent Mem0 memory injected as context
             * and the conversation saved back to Mem0 on unmount.
             */
            <AgentChat
              key={activeSession.id}
              agentName={activeSession.agentName}
              sessionId={activeSession.id}
              agentDescription="General-purpose AI company brain"
              persona={COMMANDCENTER_PERSONA}
              memories={memories.map((m) => m.memory)}
              memoryUserId={DEFAULT_USER_ID}
              availableAgents={agentList.length > 0 ? agentList : undefined}
              onActivity={(info) => handleActivity(activeSession.id, info)}
            />
          ) : (
            /*
             * Named agent session — identical AgentChat UI without memory injection.
             * Messages route: AgentChat → /api/agent/chat → gateway (Copilot SDK / LiteLLM).
             */
            <AgentChat
              key={activeSession.id}
              agentName={activeSession.agentName}
              sessionId={activeSession.id}
              availableAgents={agentList.length > 0 ? agentList : undefined}
              onActivity={(info) => handleActivity(activeSession.id, info)}
            />
          )
        ) : (
          <div className="flex flex-1 items-center justify-center text-zinc-600 text-sm">
            Select or create a session to start chatting.
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatPageInner />
    </Suspense>
  );
}
