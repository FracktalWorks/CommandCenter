"use client";

/**
 * useAgentState — bidirectional shared state between agent and UI.
 *
 * Pattern borrowed from CopilotKit's useAgent hook + agent.state.
 * The agent can update state via AG-UI STATE_SNAPSHOT / STATE_DELTA events,
 * and the UI can push state to the agent via setState().
 *
 * Usage:
 *   const { state, setState, subscribe } = useAgentState(sessionId);
 *   // Read agent state
 *   const tasks = state.tasks ?? [];
 *   // Push state to agent
 *   setState({ theme: "dark" });
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// ── Global state store (per session) ───────────────────────────────────────

const _stateStore = new Map<string, Record<string, unknown>>();
const _stateListeners = new Map<string, Set<() => void>>();

function getState(sessionId: string): Record<string, unknown> {
  return _stateStore.get(sessionId) ?? {};
}

function setStateInternal(sessionId: string, state: Record<string, unknown>): void {
  _stateStore.set(sessionId, state);
  _stateListeners.get(sessionId)?.forEach((l) => l());
}

function subscribeState(sessionId: string, listener: () => void): () => void {
  if (!_stateListeners.has(sessionId)) {
    _stateListeners.set(sessionId, new Set());
  }
  _stateListeners.get(sessionId)!.add(listener);
  return () => {
    _stateListeners.get(sessionId)?.delete(listener);
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Apply a STATE_SNAPSHOT from the agent (full replace). */
export function applyStateSnapshot(
  sessionId: string,
  snapshot: Record<string, unknown>,
): void {
  setStateInternal(sessionId, snapshot);
}

/** Apply a STATE_DELTA (JSON Patch) from the agent. */
export function applyStateDelta(
  sessionId: string,
  delta: Array<{ op: string; path: string; value?: unknown }>,
): void {
  const current = { ...getState(sessionId) };
  for (const d of delta) {
    const path = d.path.replace(/^\//, "").split("/");
    if (d.op === "add" || d.op === "replace") {
      setNestedValue(current, path, d.value);
    } else if (d.op === "remove") {
      removeNestedValue(current, path);
    }
  }
  setStateInternal(sessionId, current);
}

// ── React hook ─────────────────────────────────────────────────────────────

interface UseAgentStateReturn {
  state: Record<string, unknown>;
  setState: (state: Record<string, unknown>) => void;
  /** Merge partial state (shallow merge at top level). */
  patchState: (patch: Record<string, unknown>) => void;
}

export function useAgentState(sessionId: string): UseAgentStateReturn {
  const state = useSyncExternalStore(
    (l) => subscribeState(sessionId, l),
    () => getState(sessionId),
    () => getState(sessionId),
  );

  const setState = useCallback(
    (newState: Record<string, unknown>) => {
      setStateInternal(sessionId, newState);
    },
    [sessionId],
  );

  const patchState = useCallback(
    (patch: Record<string, unknown>) => {
      const current = getState(sessionId);
      setStateInternal(sessionId, { ...current, ...patch });
    },
    [sessionId],
  );

  return { state, setState, patchState };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function setNestedValue(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!current[key] || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

function removeNestedValue(
  obj: Record<string, unknown>,
  path: string[],
): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!current[key] || typeof current[key] !== "object") return;
    current = current[key] as Record<string, unknown>;
  }
  delete current[path[path.length - 1]];
}
