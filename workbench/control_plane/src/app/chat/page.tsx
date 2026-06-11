"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
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
import type { ArtifactEntry } from "@/hooks/useAgentChat";
import ArtifactSidebar, { type FileEntry } from "@/components/ArtifactSidebar";
import ArtifactViewerModal from "@/components/ArtifactViewerModal";
import FileUploadButton from "@/components/FileUploadButton";
import { useViewMode } from "@/components/ViewModeProvider";
import { useMobileDrawer } from "@/components/AppShell";
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

        {/* Copilot SDK Agents — talk directly to GitHub Copilot SDK */} 
        <div className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-600 mb-1.5">
            Copilot SDK agents
          </div>
          {loading ? (
            <div className="text-xs text-zinc-600 py-2 text-center">Loading agents…</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {agents.filter(a => a.agent_runtime === "github-copilot").map((a) => (
                <div key={a.name}>
                  <button
                    onClick={() => handleAgentClick(a)}
                    className="w-full text-left rounded-lg border border-zinc-700/60 bg-zinc-800/40 px-4 py-3 hover:border-zinc-500 hover:bg-zinc-800 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium text-zinc-100">{a.name}</div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-sky-700/50 bg-sky-900/30 text-sky-300">
                          Copilot SDK
                        </span>
                        {needsSetupBadge(a) && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-900/40 text-orange-400 border border-orange-700/50">
                            ⚙ Setup needed
                          </span>
                        )}
                        {a.tags.slice(0, 2).map((t) => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">{t}</span>
                        ))}
                      </div>
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">{a.description}</div>
                  </button>
                </div>
              ))}
              {agents.filter(a => a.agent_runtime === "github-copilot").length === 0 && (
                <div className="text-xs text-zinc-600 py-1">No Copilot SDK agents registered</div>
              )}
            </div>
          )}
        </div>

        {/* MAF Agents — run through Microsoft Agent Framework */}
        <div className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-600 mb-1.5">
            MAF agents
          </div>
          {loading ? (
            <div className="text-xs text-zinc-600 py-2 text-center">Loading agents…</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
              {agents.filter(a => a.agent_runtime !== "github-copilot").map((a) => (
                <div key={a.name}>
                  <button
                    onClick={() => handleAgentClick(a)}
                    className="w-full text-left rounded-lg border border-zinc-700/60 bg-zinc-800/40 px-4 py-3 hover:border-zinc-500 hover:bg-zinc-800 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium text-zinc-100">{a.name}</div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-amber-700/40 bg-amber-900/20 text-amber-400">
                          MAF
                        </span>
                        {needsSetupBadge(a) && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-900/40 text-orange-400 border border-orange-700/50">
                            ⚙ Setup needed
                          </span>
                        )}
                        {a.tags.slice(0, 2).map((t) => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">{t}</span>
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
  onDelete,
  onRefresh,
}: {
  memories: Mem0Memory[];
  userId: string;
  onDelete: (id: string) => void;
  onRefresh?: () => void;
}) {
  if (memories.length === 0) {
    return (
      <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Memory
        </div>
        <p className="mt-1.5 text-xs text-zinc-600">
          No memories yet. CommandCenter will learn from your conversations.
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
        <div className="flex items-center gap-1.5">
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="text-zinc-600 hover:text-zinc-400 transition-colors"
              title="Refresh memories"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M14 8A6 6 0 1 1 8 2" />
                <path d="M14 2v4h-4" />
              </svg>
            </button>
          )}
          <a
            href="/memory"
            className="text-xs text-zinc-600 hover:text-blue-400 transition-colors"
            title="Open full memory manager"
          >
            →
          </a>
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
// Session list — grouped by agent with accordion sections
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
  // Group sessions by agentName
  const groups = useMemo(() => {
    const map = new Map<string, ChatSession[]>();
    for (const s of sessions) {
      const list = map.get(s.agentName) ?? [];
      list.push(s);
      map.set(s.agentName, list);
    }
    // Sort groups: active agent first, then alphabetically
    const entries = Array.from(map.entries());
    const activeAgent = sessions.find((s) => s.id === activeId)?.agentName;
    entries.sort(([a], [b]) => {
      if (a === activeAgent) return -1;
      if (b === activeAgent) return 1;
      return a.localeCompare(b);
    });
    return entries;
  }, [sessions, activeId]);

  // Track which accordion sections are expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Auto-expand the active agent's group, collapse others on activeId change.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const activeAgent = sessions.find((s) => s.id === activeId)?.agentName;
    if (activeAgent) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(activeAgent);
        return next;
      });
    }
  }, [activeId, sessions]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const toggleAgent = (agent: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  };

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <button
          onClick={onNew}
          className="mb-2 w-full rounded-md bg-zinc-800 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
        >
          + New session
        </button>
        <p className="px-1 text-xs text-zinc-600">No sessions yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <button
        onClick={onNew}
        className="mb-1 w-full rounded-md bg-zinc-800 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
      >
        + New session
      </button>

      {groups.map(([agentName, agentSessions]) => {
        const isCollapsed = collapsed.has(agentName);
        const isActiveAgent = agentSessions.some((s) => s.id === activeId);
        const count = agentSessions.length;

        return (
          <div key={agentName} className="mb-0.5">
            {/* Accordion header */}
            <button
              onClick={() => toggleAgent(agentName)}
              className={`w-full flex items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors ${
                isActiveAgent
                  ? "bg-zinc-800/60 text-zinc-200"
                  : "text-zinc-500 hover:bg-zinc-800/40 hover:text-zinc-300"
              }`}
            >
              <span className="text-[10px] transition-transform duration-150" style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>
                ▼
              </span>
              <span className="flex-1 text-xs font-medium truncate">
                {agentName}
              </span>
              <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">
                {count}
              </span>
            </button>

            {/* Sessions for this agent */}
            {!isCollapsed && (
              <div className="ml-2 border-l border-zinc-800/60 pl-2">
                {agentSessions.map((s) => (
                  <div
                    key={s.id}
                    className={`group flex items-start justify-between rounded-md px-2 py-1.5 cursor-pointer transition-colors ${
                      s.id === activeId
                        ? "bg-zinc-800 text-white"
                        : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"
                    }`}
                    onClick={() => onSelect(s.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">
                        {s.title ?? s.name}
                      </div>
                      {s.lastPreview ? (
                        <div className="truncate text-[10px] text-zinc-500">
                          {s.lastPreview}
                        </div>
                      ) : null}
                      <div className="text-[10px] text-zinc-600">
                        {s.messageCount > 0 ? `${s.messageCount} msgs` : "New"}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(s.id);
                      }}
                      className="ml-1 shrink-0 text-zinc-600 hover:text-red-400 transition-colors text-[10px]"
                      title="Delete session"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

function ChatPageInner() {
  const searchParams = useSearchParams();
  const { data: nextAuthSession } = useSession();
  const userId: string = nextAuthSession?.user?.email ?? "dev@fracktal.in";

  const { isMobile } = useViewMode();
  const { open: openDrawer, close: closeDrawer } = useMobileDrawer();

  // Refs to hold drawer content (defined later in render).
  const conversationsRef = useRef<React.ReactNode>(null);
  const filesRef = useRef<React.ReactNode>(null);

  // Listen for bottom-nav tab events from AppShell MobileBottomNav.
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail;
      if (tab === "chats" && conversationsRef.current) {
        openDrawer(conversationsRef.current);
      } else if (tab === "files" && filesRef.current) {
        openDrawer(filesRef.current);
      }
    };
    window.addEventListener("cc-mobile-nav", handler);
    return () => window.removeEventListener("cc-mobile-nav", handler);
  }, [openDrawer]);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [memories, setMemories] = useState<Mem0Memory[]>([]);
  const [memoriesLoaded, setMemoriesLoaded] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  // Desktop: collapsible side panel.  Mobile: drawer-based (never a sidebar).
  const [sessionPanelOpen, setSessionPanelOpen] = useState(true);
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [viewerEntry, setViewerEntry] = useState<FileEntry | null>(null);
  const [artifactUpdates, setArtifactUpdates] = useState<FileEntry[]>([]);

  // On mobile the side panels start collapsed so the chat fills the screen;
  // they open as overlay drawers on demand.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isMobile) {
      setSessionPanelOpen(false);
      setArtifactPanelOpen(false);
    } else {
      setSessionPanelOpen(true);
    }
  }, [isMobile]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const agentParam = searchParams?.get("agent");
    const existing = getSessions();
    if (agentParam) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time init
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // After initial localStorage render, fetch from Postgres and merge any sessions
  // that exist there but not in the browser (e.g. after cache clear or new device).
  useEffect(() => {
    fetchAndMergeSessionsFromDb().then((merged) => {
      setSessions(merged);
    }).catch(() => {});
  }, []);

  // Fetch memories from Mem0 (or return [] gracefully).
  const loadMemories = useCallback(() => {
    fetch(`/api/memory/${encodeURIComponent(userId)}`)
      .then((r) => r.json())
      .then((data: Mem0Memory[] | { results?: Mem0Memory[] }) => {
        const list = Array.isArray(data) ? data : (data.results ?? []);
        setMemories(list);
        setMemoriesLoaded(true);
      })
      .catch(() => setMemoriesLoaded(true));
  }, [userId]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  const handleNewSession = useCallback(() => {
    setShowPicker(true);
  }, []);

  const handleSelectAgent = useCallback(
    (agentName: string) => {
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
    await fetch(
      `/api/memory/${encodeURIComponent(userId)}/${encodeURIComponent(memoryId)}`,
      { method: "DELETE" }
    );
    setMemories((prev) => prev.filter((m) => m.id !== memoryId));
  }, [userId]);

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

  // ── Mobile: drawer content builders ────────────────────────────────────
  const conversationsContent = (
    <>
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="text-sm font-semibold text-zinc-200">Conversations</div>
        <button
          onClick={closeDrawer}
          className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="flex flex-col flex-1 overflow-y-auto p-3">
        <button
          onClick={() => { handleNewSession(); closeDrawer(); }}
          className="mb-3 w-full rounded-lg bg-zinc-800 px-3 py-2.5 text-left text-sm font-medium text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          + New chat
        </button>
        <SessionList
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={(id) => { handleSelectSession(id); closeDrawer(); }}
          onNew={() => { handleNewSession(); closeDrawer(); }}
          onDelete={handleDeleteSession}
        />
        {memoriesLoaded && (
          <MemoryPanel
            memories={memories}
            userId={userId}
            onDelete={handleDeleteMemory}
            onRefresh={loadMemories}
          />
        )}
      </div>
    </>
  );

  const filesContent = (
    <>
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="text-sm font-semibold text-zinc-200">Files</div>
        <button
          onClick={closeDrawer}
          className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {/* Upload drop zone at top of files drawer */}
        <div className="px-3 pt-3 pb-2">
          <FileUploadButton
            sessionId={activeSessionId}
            dropZone
            onUploadComplete={(files) => {
              setArtifactUpdates((prev) => [
                ...prev,
                ...files.map((f) => ({ ...f, is_dir: false })),
              ]);
            }}
          />
        </div>
        <ArtifactSidebar
          sessionId={activeSessionId}
          open
          fullWidth
          onToggle={closeDrawer}
          onFileOpen={(entry) => {
            setViewerEntry(entry);
            closeDrawer();
          }}
          artifactUpdates={artifactUpdates}
        />
      </div>
    </>
  );

  // Sync refs after render (avoid refs-during-render lint error).
  useEffect(() => {
    conversationsRef.current = conversationsContent;
    filesRef.current = filesContent;
  });

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="relative flex h-full overflow-hidden">
      {/* Agent picker modal */}
      {showPicker && (
        <AgentPickerModal
          onSelect={handleSelectAgent}
          onClose={() => setShowPicker(false)}
        />
      )}

      {/* ── Desktop: sessions sidebar ─────────────────────────────────── */}
      {!isMobile && (
        <aside
          className={`shrink-0 border-r border-zinc-800 bg-zinc-900/40 flex flex-col overflow-hidden transition-all duration-200 ${
            sessionPanelOpen ? "w-72" : "w-10"
          }`}
        >
          <div className={`flex items-center border-b border-zinc-800 ${
            sessionPanelOpen ? "justify-between px-4 py-3" : "justify-center py-3"
          }`}>
            {sessionPanelOpen && (
              <div className="text-sm font-semibold text-zinc-200">Conversations</div>
            )}
            <button
              onClick={() => setSessionPanelOpen((o) => !o)}
              className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
              title={sessionPanelOpen ? "Collapse conversations" : "Expand conversations"}
            >
              {sessionPanelOpen ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M10 3L5 8l5 5" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M6 3l5 5-5 5" />
                </svg>
              )}
            </button>
          </div>

          {sessionPanelOpen && (
            <div className="flex flex-col flex-1 p-4 overflow-y-auto">
              <div className="text-xs text-zinc-500 mb-3">Copilot SDK + LiteLLM</div>
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
                  userId={userId}
                  onDelete={handleDeleteMemory}
                  onRefresh={loadMemories}
                />
              )}

              <div className="mt-auto pt-6 text-xs text-zinc-600">
                Memory persists to Mem0 · Sessions in localStorage
              </div>
            </div>
          )}
        </aside>
      )}

      {/* ── Chat area ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-w-0">
        <div className="flex flex-1 flex-col overflow-hidden min-w-0">

          {activeSession ? (
            MEMORY_AGENTS.has(activeSession.agentName) ? (
              <AgentChat
                key={activeSession.id}
                agentName={activeSession.agentName}
                sessionId={activeSession.id}
                agentDescription="General-purpose AI company brain"
                persona={COMMANDCENTER_PERSONA}
                memories={memories.map((m) => m.memory)}
                memoryUserId={userId}
                availableAgents={agentList.length > 0 ? agentList : undefined}
                onActivity={(info) => handleActivity(activeSession.id, info)}
                onArtifact={(entry: ArtifactEntry) => {
                  setArtifactUpdates((prev) => [
                    ...prev,
                    {
                      path: entry.path,
                      name: entry.path.split("/").pop() ?? entry.path,
                      size: entry.size ?? 0,
                      modified_at: new Date().toISOString(),
                      mime_type: "",
                    } satisfies FileEntry,
                  ]);
                }}
              />
            ) : (
              <AgentChat
                key={activeSession.id}
                agentName={activeSession.agentName}
                sessionId={activeSession.id}
                availableAgents={agentList.length > 0 ? agentList : undefined}
                onActivity={(info) => handleActivity(activeSession.id, info)}
                onArtifact={(entry: ArtifactEntry) => {
                  setArtifactUpdates((prev) => [
                    ...prev,
                    {
                      path: entry.path,
                      name: entry.path.split("/").pop() ?? entry.path,
                      size: entry.size ?? 0,
                      modified_at: new Date().toISOString(),
                      mime_type: "",
                    } satisfies FileEntry,
                  ]);
                }}
              />
            )
          ) : (
            <div className="flex flex-1 items-center justify-center text-zinc-600 text-sm">
              Select or create a session to start chatting.
            </div>
          )}
        </div>

        {/* Desktop: Artifact sidebar */}
        {!isMobile && (
          <ArtifactSidebar
            sessionId={activeSessionId}
            open={artifactPanelOpen}
            onToggle={() => setArtifactPanelOpen((o) => !o)}
            onFileOpen={(entry) => {
              setViewerEntry(entry);
              setArtifactPanelOpen(true);
            }}
            artifactUpdates={artifactUpdates}
          />
        )}
      </div>

      {/* File viewer modal (shared) */}
      {viewerEntry && (
        <ArtifactViewerModal
          sessionId={activeSessionId}
          entry={viewerEntry}
          onClose={() => setViewerEntry(null)}
        />
      )}
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
