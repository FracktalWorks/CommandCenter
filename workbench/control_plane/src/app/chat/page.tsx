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
import { useActiveSessions } from "@/hooks/useActiveSessions";
import type { AgentEntry } from "@/app/api/agent/list/route";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";

// Agent names that receive the CommandCenter persona (general-purpose brain).
// All agents get persistent Mem0 memory — the panel shows for every agent,
// and conversations are saved to Mem0 regardless of agent type.
const PERSONA_AGENTS = new Set(["orchestrator", "default"]);

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl tech-glass-subtle"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-foreground">New session</div>
            <div className="text-xs text-muted-foreground mt-0.5">Choose an agent to chat with</div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-sm tech-transition"
          >
            ✕
          </button>
        </div>

        {/* Default — CommandCenter */}
        <div className="mb-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70 mb-1.5">
            Default
          </div>
          <button
            onClick={() => onSelect("orchestrator", "CommandCenter — AI company brain")}
            className="w-full text-left rounded-lg border border-border bg-secondary/60 px-4 py-3 hover:border-primary/40 hover:bg-secondary tech-transition"
          >
            <div className="text-sm font-medium text-foreground">CommandCenter</div>
            <div className="text-xs text-muted-foreground mt-0.5">General-purpose AI company brain</div>
          </button>
        </div>

        {/* Copilot SDK Agents — talk directly to GitHub Copilot SDK */} 
        <div className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70 mb-1.5">
            Copilot SDK agents
          </div>
          {loading ? (
            <div className="text-xs text-muted-foreground py-2 text-center">Loading agents…</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {agents.filter(a => a.agent_runtime === "github-copilot").map((a) => (
                <div key={a.name}>
                  <button
                    onClick={() => handleAgentClick(a)}
                    className="w-full text-left rounded-lg border border-border bg-secondary/40 px-4 py-3 hover:border-primary/30 hover:bg-secondary tech-transition"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                      <div className="text-sm font-medium text-foreground truncate">{a.display_name || a.name}</div>
                      <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-primary/40 bg-primary/10 text-primary whitespace-nowrap">
                          Copilot SDK
                        </span>
                        {needsSetupBadge(a) && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive border border-destructive/30 whitespace-nowrap">
                            ⚙ Setup needed
                          </span>
                        )}
                        {a.tags.slice(0, 2).map((t) => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground whitespace-nowrap">{t}</span>
                        ))}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{a.description}</div>
                  </button>
                </div>
              ))}
              {agents.filter(a => a.agent_runtime === "github-copilot").length === 0 && (
                <div className="text-xs text-muted-foreground py-1">No Copilot SDK agents registered</div>
              )}
            </div>
          )}
        </div>

        {/* MAF Agents — run through Microsoft Agent Framework */}
        <div className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70 mb-1.5">
            MAF agents
          </div>
          {loading ? (
            <div className="text-xs text-muted-foreground py-2 text-center">Loading agents…</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
              {agents.filter(a => a.agent_runtime !== "github-copilot").map((a) => (
                <div key={a.name}>
                  <button
                    onClick={() => handleAgentClick(a)}
                    className="w-full text-left rounded-lg border border-border bg-secondary/40 px-4 py-3 hover:border-primary/30 hover:bg-secondary tech-transition"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                      <div className="text-sm font-medium text-foreground truncate">{a.display_name || a.name}</div>
                      <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-accent/40 bg-accent/10 text-accent whitespace-nowrap">
                          MAF
                        </span>
                        {needsSetupBadge(a) && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive border border-destructive/30 whitespace-nowrap">
                            ⚙ Setup needed
                          </span>
                        )}
                        {a.tags.slice(0, 2).map((t) => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground whitespace-nowrap">{t}</span>
                        ))}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{a.description}</div>
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
      <div className="mt-4 rounded-md border border-border bg-card/40 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Memory
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          No memories yet. CommandCenter will learn from your conversations.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-md border border-border bg-card/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Memory ({memories.length})
        </div>
        <div className="flex items-center gap-1.5">
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="text-muted-foreground hover:text-muted-foreground transition-colors"
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
            className="text-xs text-muted-foreground hover:text-blue-400 transition-colors"
            title="Open full memory manager"
          >
            →
          </a>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
        {memories.map((m) => (
          <li key={m.id} className="group flex items-start gap-1.5">
            <span className="mt-0.5 shrink-0 text-muted-foreground">•</span>
            <span className="text-xs text-muted-foreground leading-relaxed flex-1">
              {m.memory}
            </span>
            <button
              onClick={() => onDelete(m.id)}
              className="ml-1 shrink-0 text-muted-foreground/50 hover:text-red-400 transition-colors text-xs"
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
  activeRunIds,
  onSelect,
  onNew,
  onDelete,
}: {
  sessions: ChatSession[];
  activeId: string;
  activeRunIds: Set<string>;
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
          className="mb-2 w-full rounded-md bg-secondary px-3 py-2 text-left text-sm text-foreground hover:bg-secondary transition-colors"
        >
          + New session
        </button>
        <p className="px-1 text-xs text-muted-foreground">No sessions yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={onNew}
        className="mb-2 w-full rounded-md bg-secondary px-3 py-2 text-left text-sm text-foreground hover:bg-secondary transition-colors"
      >
        + New session
      </button>

      {groups.map(([agentName, agentSessions]) => {
        const isCollapsed = collapsed.has(agentName);
        const isActiveAgent = agentSessions.some((s) => s.id === activeId);
        const count = agentSessions.length;

        return (
          <div key={agentName} className="mb-1">
            {/* Accordion header */}
            <button
              onClick={() => toggleAgent(agentName)}
              className={`w-full flex items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors ${
                isActiveAgent
                  ? "bg-secondary/60 text-foreground"
                  : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground"
              }`}
            >
              <span className="text-[10px] transition-transform duration-150" style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>
                ▼
              </span>
              <span className="flex-1 text-xs font-medium truncate">
                {agentName}
              </span>
              {/* Active run count badge */}
              {agentSessions.some((s) => activeRunIds.has(s.id)) && (
                <span className="flex items-center gap-1 text-[10px] text-emerald-400 shrink-0" title="Agent is running">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {agentSessions.filter((s) => activeRunIds.has(s.id)).length}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                {count}
              </span>
            </button>

            {/* Sessions for this agent */}
            {!isCollapsed && (
              <div className="mt-1 ml-2.5 flex flex-col gap-1 border-l border-border/60 pl-2">
                {agentSessions.map((s) => (
                  <div
                    key={s.id}
                    className={`group flex items-start justify-between rounded-md px-2.5 py-2 cursor-pointer transition-colors ${
                      s.id === activeId
                        ? "bg-secondary text-sidebar-foreground"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                    }`}
                    onClick={() => onSelect(s.id)}
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="truncate text-xs font-medium leading-snug flex items-center gap-1.5">
                        {activeRunIds.has(s.id) && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" title="Agent is generating a response" />
                        )}
                        <span className="truncate">{s.title ?? s.name}</span>
                      </div>
                      {s.lastPreview ? (
                        <div className="truncate text-[10px] leading-snug text-muted-foreground">
                          {s.lastPreview}
                        </div>
                      ) : null}
                      <div className="text-[10px] leading-snug text-muted-foreground">
                        {s.messageCount > 0 ? `${s.messageCount} msgs` : "New"}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(s.id);
                      }}
                      className="ml-2 mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-red-400 transition-colors text-[10px]"
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
  const activeRunIds = useActiveSessions();

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
  // If no sessions exist, show the agent picker — never default to any agent.
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
      // No sessions yet — show the agent picker so the user explicitly
      // chooses which agent to talk to instead of defaulting blindly.
      setShowPicker(true);
    } else {
      setSessions(existing);
      setActiveSessionId(existing[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time init
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // After initial localStorage render, fetch from Postgres and merge any sessions
  // that exist there but not in the browser (e.g. after cache clear or new device).
  // Also poll every 30s so sessions created on other devices appear in the sidebar
  // without requiring a page refresh.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const sync = async () => {
      if (cancelled) return;
      try {
        const merged = await fetchAndMergeSessionsFromDb();
        if (!cancelled) setSessions(merged);
      } catch { /* best-effort */ }
      if (!cancelled) timer = setTimeout(sync, 30000);
    };

    // Initial sync
    sync();

    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // Fetch memories from Mem0 (or return [] gracefully).
  // Polls every 30s so newly extracted memories appear without refresh.
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
    // Auto-refresh memories every 30s
    const interval = setInterval(loadMemories, 30000);
    return () => clearInterval(interval);
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
          // All sessions gone — show the agent picker instead of
          // silently defaulting to the orchestrator.
          setActiveSessionId("");
          setShowPicker(true);
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
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="text-sm font-semibold text-foreground">Conversations</div>
        <button
          onClick={closeDrawer}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground tech-transition"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="flex flex-col flex-1 overflow-y-auto p-3">
        <SessionList
          sessions={sessions}
          activeId={activeSessionId}
          activeRunIds={activeRunIds}
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
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="text-sm font-semibold text-foreground">Files</div>
        <button
          onClick={closeDrawer}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground tech-transition"
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
          className={`shrink-0 border-r border-border bg-sidebar flex flex-col overflow-hidden transition-all duration-200 ${
            sessionPanelOpen ? "w-72" : "w-10"
          }`}
        >
          <div className={`flex items-center border-b border-border ${
            sessionPanelOpen ? "justify-between px-4 py-3" : "justify-center py-3"
          }`}>
            {sessionPanelOpen && (
              <div className="text-sm font-semibold text-sidebar-foreground">Conversations</div>
            )}
            <button
              onClick={() => setSessionPanelOpen((o) => !o)}
              className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground tech-transition"
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
              <div className="text-[10px] text-muted-foreground/60 mb-3 uppercase tracking-wider font-semibold">Sessions</div>
              <SessionList
                sessions={sessions}
                activeId={activeSessionId}
                activeRunIds={activeRunIds}
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

              <div className="mt-auto pt-6 text-[10px] text-muted-foreground/50">
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
              <AgentChat
                key={activeSession.id}
                agentName={activeSession.agentName}
                sessionId={activeSession.id}
                agentDescription={
                  PERSONA_AGENTS.has(activeSession.agentName)
                    ? "General-purpose AI company brain"
                    : undefined
                }
                persona={
                  PERSONA_AGENTS.has(activeSession.agentName)
                    ? COMMANDCENTER_PERSONA
                    : undefined
                }
                memories={memories.map((m) => m.memory)}
                memoryUserId={userId}
                availableAgents={agentList.length > 0 ? agentList : undefined}
                expectedMessageCount={activeSession.messageCount}
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
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
              <div className="text-sm">Choose an agent to start chatting</div>
              <button
                onClick={handleNewSession}
                className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition"
              >
                + New session
              </button>
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
          onDelete={(entry) => {
            setViewerEntry(null);
            setArtifactUpdates((prev) => prev.filter((f) => f.path !== entry.path));
          }}
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
