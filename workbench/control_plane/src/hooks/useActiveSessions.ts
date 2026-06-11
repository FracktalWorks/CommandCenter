"use client";

/**
 * useActiveSessions — React hook that returns the set of session IDs
 * that currently have an active (streaming) agent run.
 *
 * Subscribes to the global chatStore listener so it reactively updates
 * whenever any session's isLoading toggles.
 */

import { useSyncExternalStore, useCallback } from "react";
import { subscribeAllSessions, getActiveSessionIds } from "@/lib/chatStore";

const EMPTY = new Set<string>();

export function useActiveSessions(): Set<string> {
  const subscribe = useCallback(
    (listener: () => void) => subscribeAllSessions(listener),
    [],
  );
  const getSnapshot = useCallback(() => getActiveSessionIds(), []);
  // Server snapshot must be stable and not cause hydration mismatches.
  const getServerSnapshot = useCallback(() => EMPTY, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
