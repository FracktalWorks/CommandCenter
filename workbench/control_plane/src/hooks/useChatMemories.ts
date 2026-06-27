"use client";

/**
 * useChatMemories — client hook for the user's Mem0 memories.
 *
 * Both chat surfaces inject the same cross-conversation memory: the main chat
 * app (chat/page.tsx, which also renders a delete-able MemoryPanel) and the
 * email-assistant rail (EmailAssistantChat, which feeds the memory text into the
 * agent persona).  They previously each carried their own fetch + 30s poll +
 * response-shape parsing, so this centralises it.
 *
 * Fetches the CLIENT-facing /api/memory proxy (NOT @/lib/memory, which is the
 * server-side gateway client using internal tokens).  The Mem0Memory type is
 * type-only — safe to import on the client.
 */

import { useCallback, useEffect, useState } from "react";
import type { Mem0Memory } from "@/lib/memory";

export interface UseChatMemories {
  /** Normalised memory objects, most-recent first. */
  memories: Mem0Memory[];
  /** True once the first fetch has settled (success OR failure). */
  loaded: boolean;
  /** Re-fetch now (e.g. a manual "refresh memories" button). */
  refresh: () => void;
  /** Delete one memory and optimistically drop it from local state. */
  remove: (memoryId: string) => Promise<void>;
}

export function useChatMemories(
  userId: string | null | undefined,
): UseChatMemories {
  const [memories, setMemories] = useState<Mem0Memory[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    if (!userId) return;
    fetch(`/api/memory/${encodeURIComponent(userId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Mem0Memory[] | { results?: Mem0Memory[] } | null) => {
        const list = Array.isArray(data) ? data : (data?.results ?? []);
        setMemories(list);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [userId]);

  // Load on mount + whenever the user changes, then poll every 30s so
  // newly-extracted memories appear without a manual refresh.
  useEffect(() => {
    if (!userId) return;
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [userId, refresh]);

  const remove = useCallback(
    async (memoryId: string) => {
      if (!userId) return;
      await fetch(
        `/api/memory/${encodeURIComponent(userId)}/${encodeURIComponent(memoryId)}`,
        { method: "DELETE" },
      ).catch(() => {});
      setMemories((prev) => prev.filter((m) => m.id !== memoryId));
    },
    [userId],
  );

  return { memories, loaded, refresh, remove };
}
