"use client";

/**
 * CC Workbench — developer chat for the CommandCenter repository.
 *
 * Uses the SAME AgentChat component + /api/agent/chat route as every other
 * agent in the Control Plane.  No separate tool loop, no separate streaming,
 * no separate session management — just a thin wrapper around the unified
 * agent chat infrastructure.
 *
 * Agent: commandcenter-dev  (GitHubCopilotAgent with full CC repo access)
 * URL:   /build/ccworkbench
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import AgentChat from "@/components/AgentChat";
import type { ArtifactEntry } from "@/hooks/useAgentChat";
import ArtifactSidebar, { type FileEntry } from "@/components/ArtifactSidebar";
import ArtifactViewerModal from "@/components/ArtifactViewerModal";
import { createSession, getSessions } from "@/lib/sessions";

const AGENT_NAME = "commandcenter-dev";

/** Stable session-id key in localStorage so returning users resume the
 *  same thread across browser restarts. */
const SESSION_STORAGE_KEY = "cc-workbench-session-id";

function getStoredSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(SESSION_STORAGE_KEY);
}

function storeSessionId(id: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SESSION_STORAGE_KEY, id);
}

export default function CCWorkbenchPage() {
  const { data: session } = useSession();
  const userId = session?.user?.email ?? "";

  // ── Stable session — reuse localStorage id or create a fresh one ──────
  const [activeSession, setActiveSession] = useState<{
    id: string;
    agentName: string;
    title?: string;
    lastPreview?: string;
    messageCount: number;
  } | null>(null);
  const resolved = useRef(false);

  useEffect(() => {
    if (resolved.current) return;
    resolved.current = true;

    const stored = getStoredSessionId();
    if (stored) {
      const existing = getSessions().find((s) => s.id === stored);
      if (existing) {
        setActiveSession(existing);
        return;
      }
    }
    // createSession handles localStorage write-through + Postgres sync.
    const fresh = createSession(AGENT_NAME);
    storeSessionId(fresh.id);
    setActiveSession(fresh);
  }, []);

  // ── Artifact sidebar ───────────────────────────────────────────────────
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [viewerFile, setViewerFile] = useState<FileEntry | null>(null);

  const handleArtifact = useCallback((entry: ArtifactEntry) => {
    const fe: FileEntry = {
      path: entry.path,
      name: entry.path.split("/").pop() ?? entry.path,
      size: entry.size ?? 0,
      modified_at: new Date().toISOString(),
      mime_type: "",
    };
    setFiles((prev) => {
      const idx = prev.findIndex((f) => f.path === fe.path);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = fe;
        return next;
      }
      return [...prev, fe];
    });
  }, []);

  // ── Session activity (auto-title + last-preview for the sidebar) ──────
  const handleActivity = useCallback(
    (info: {
      firstUserMessage?: string;
      lastPreview?: string;
      messageCount: number;
    }) => {
      setActiveSession((prev) =>
        prev
          ? {
              ...prev,
              title: info.firstUserMessage
                ? info.firstUserMessage.slice(0, 60)
                : prev.title,
              lastPreview: info.lastPreview,
              messageCount: info.messageCount,
            }
          : prev,
      );
    },
    [],
  );

  if (!activeSession) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-muted-foreground text-sm">
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Chat area ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <AgentChat
          key={activeSession.id}
          agentName={AGENT_NAME}
          sessionId={activeSession.id}
          memoryUserId={userId}
          onActivity={handleActivity}
          onArtifact={handleArtifact}
        />
      </div>

      {/* ── File browser ──────────────────────────────────────────────── */}
      <ArtifactSidebar
        files={files}
        onRefresh={async () => {
          try {
            const res = await fetch(
              `/api/agent/workspace/${activeSession.id}/files`,
            );
            if (res.ok) {
              const data = (await res.json()) as FileEntry[];
              setFiles(data);
            }
          } catch {
            /* silently ignore fetch errors */
          }
        }}
        onOpenFile={(file) => setViewerFile(file)}
        sessionId={activeSession.id}
      />

      {/* ── File viewer modal ─────────────────────────────────────────── */}
      {viewerFile && (
        <ArtifactViewerModal
          file={viewerFile}
          sessionId={activeSession.id}
          onClose={() => setViewerFile(null)}
        />
      )}
    </div>
  );
}
