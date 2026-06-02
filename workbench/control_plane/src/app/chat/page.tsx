"use client";

import { useState, useEffect, useCallback } from "react";
import {
  CopilotKitProvider,
  useCopilotReadable,
  useCopilotChat,
} from "@copilotkit/react-core/v2";
import { CopilotChat } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import {
  getSessions,
  upsertSession,
  deleteSession,
  createSession,
  touchSession,
  type ChatSession,
} from "@/lib/sessions";
import type { Mem0Memory } from "@/lib/memory";

// ---------------------------------------------------------------------------
// Inner component — must live inside CopilotKitProvider to use hooks
// ---------------------------------------------------------------------------

function ChatWithMemory({
  session,
  memories,
  userId,
}: {
  session: ChatSession;
  memories: Mem0Memory[];
  userId: string;
}) {
  const { messages } = useCopilotChat();

  // Inject memories into the AI's readable context so it uses them.
  useCopilotReadable({
    description:
      "Persistent memories from past conversations with this user. Use them to provide continuity and personalise responses.",
    value:
      memories.length > 0
        ? memories.map((m) => `• ${m.memory}`).join("\n")
        : "No memories stored yet for this user.",
  });

  // Inject current session metadata.
  useCopilotReadable({
    description: "Current chat session context",
    value: `Session name: ${session.name} | Agent: ${session.agentName} | Started: ${new Date(session.createdAt).toLocaleString()}`,
  });

  // Keep session message count in sync with localStorage.
  useEffect(() => {
    if (messages.length > 0) {
      touchSession(session.id, messages.length);
    }
  }, [messages.length, session.id]);

  // Save conversation to Mem0 when component unmounts (session switch / navigate).
  useEffect(() => {
    return () => {
      if (messages.length === 0) return;
      const payload = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: typeof m.content === "string" ? m.content : "",
        }))
        .filter((m) => m.content.length > 0);
      if (payload.length === 0) return;
      // Fire-and-forget — failure is non-critical.
      fetch("/api/chat/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, messages: payload }),
        keepalive: true,
      }).catch(() => {});
    };
  }, [messages, userId]);

  return (
    <CopilotChat
      instructions={`You are Jannet, the AI operations brain for Fracktal Works. You help the team with tasks, project tracking, sales pipeline, and company intelligence. You have access to memories from past conversations — use them to provide continuity. When you take actions that modify company data, confirm before proceeding. Be concise and direct.`}
      labels={{
        title: "Jannet",
        initial:
          "Hello! I'm Jannet, your AI company brain. Ask me about projects, tasks, sales, or anything else.",
        placeholder: "Ask about tasks, projects, customers…",
      }}
      className="h-full"
    />
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
            ? "No memories yet. Jannet will learn from your conversations."
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
            <div className="truncate text-sm font-medium">{s.name}</div>
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

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [memories, setMemories] = useState<Mem0Memory[]>([]);
  const [memoriesLoaded, setMemoriesLoaded] = useState(false);

  // Load sessions from localStorage on mount.
  useEffect(() => {
    const existing = getSessions();
    if (existing.length === 0) {
      const fresh = createSession();
      upsertSession(fresh);
      setSessions([fresh]);
      setActiveSessionId(fresh.id);
    } else {
      setSessions(existing);
      setActiveSessionId(existing[0].id);
    }
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
    const s = createSession();
    upsertSession(s);
    setSessions(getSessions());
    setActiveSessionId(s.id);
  }, []);

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

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="flex h-full min-h-screen">
      {/* Left panel — sessions + memory */}
      <aside className="w-72 shrink-0 border-r border-zinc-800 bg-zinc-900/40 flex flex-col p-4 overflow-y-auto">
        <div className="mb-4">
          <div className="text-sm font-semibold text-zinc-200">Conversations</div>
          <div className="text-xs text-zinc-500 mt-0.5">
            Powered by CopilotKit + LangGraph
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

      {/* Right panel — chat */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {activeSession ? (
          /*
           * Each session gets its own CopilotKitProvider with a unique threadId.
           * This isolates the message history per session so switching sessions
           * loads the correct conversation thread.
           *
           * Upgrade path: replace `threadId` with a LangGraph checkpointer thread_id
           * when CopilotRuntime is upgraded from BuiltInAgent to LangGraphAgent.
           */
          <CopilotKitProvider
            key={activeSession.id}
            runtimeUrl="/api/copilot"
            threadId={activeSession.id}
          >
            <div className="flex flex-col h-full">
              {/* Session header */}
              <div className="shrink-0 border-b border-zinc-800 px-6 py-3 flex items-center justify-between bg-zinc-950">
                <div>
                  <div className="text-sm font-medium text-zinc-200">
                    {activeSession.name}
                  </div>
                  <div className="text-xs text-zinc-500">
                    Agent: {activeSession.agentName}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {memories.length > 0 && (
                    <span className="rounded-full bg-violet-900/40 px-2 py-0.5 text-xs text-violet-400">
                      {memories.length} memories
                    </span>
                  )}
                </div>
              </div>

              {/* Chat component */}
              <div className="flex-1 overflow-hidden">
                <ChatWithMemory
                  session={activeSession}
                  memories={memories}
                  userId={DEFAULT_USER_ID}
                />
              </div>
            </div>
          </CopilotKitProvider>
        ) : (
          <div className="flex flex-1 items-center justify-center text-zinc-600 text-sm">
            Select or create a session to start chatting.
          </div>
        )}
      </div>
    </div>
  );
}
