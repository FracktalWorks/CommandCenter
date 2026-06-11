"use client";

/**
 * useActiveSessions — React hook that returns the set of session IDs
 * that currently have an active (streaming) agent run.
 *
 * Two sources of truth, merged:
 *   1. Local chatStore (isLoading flag) — instant, reactive via
 *      useSyncExternalStore.  Works for sessions in the current
 *      browser tab.
 *   2. Server-side Redis cc:active:* scan — polled every 5 seconds.
 *      Catches sessions running in background after a browser refresh
 *      or on another device.
 *
 * The returned set is the UNION of both sources.
 */

import { useSyncExternalStore, useCallback, useEffect, useState, useRef } from "react";
import { subscribeAllSessions, getActiveSessionIdsStable } from "@/lib/chatStore";

const EMPTY = new Set<string>();

export function useActiveSessions(): Set<string> {
  const subscribe = useCallback(
    (listener: () => void) => subscribeAllSessions(listener),
    [],
  );
  const getSnapshot = useCallback(() => getActiveSessionIdsStable(), []);
  // Server snapshot must be stable and not cause hydration mismatches.
  const getServerSnapshot = useCallback(() => EMPTY, []);

  const localActive = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // ── Server-side active sessions (polled) ────────────────────────────
  const [serverActiveIds, setServerActiveIds] = useState<Set<string>>(EMPTY);
  const serverCacheRef = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch("/api/chat/active-sessions", {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Array<{
          threadId: string;
          agentName: string;
          title?: string | null;
        }>;
        const ids = new Set(data.map((d) => d.threadId));
        // Only update React state if the set actually changed (avoids
        // unnecessary re-renders of every SessionList subscriber).
        const key = [...ids].sort().join(",");
        if (key !== serverCacheRef.current) {
          serverCacheRef.current = key;
          setServerActiveIds(ids);
        }
      } catch {
        // Server unreachable — keep last known server state.
      }
      if (!cancelled) {
        timer = setTimeout(poll, 5000);
      }
    };

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Merge local + server active IDs (union).
  if (localActive.size === 0 && serverActiveIds.size === 0) return EMPTY;
  if (localActive.size === 0) return serverActiveIds;
  if (serverActiveIds.size === 0) return localActive;

  // Both non-empty — compute union.  Use a stable reference when the
  // union hasn't changed to avoid infinite re-renders.
  const merged = new Set<string>();
  for (const id of localActive) merged.add(id);
  for (const id of serverActiveIds) merged.add(id);
  return merged;
}
