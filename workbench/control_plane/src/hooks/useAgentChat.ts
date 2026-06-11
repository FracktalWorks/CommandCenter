"use client";

/**
 * useAgentChat — streaming chat hook backed by a module-level store (chatStore.ts).
 *
 * State (messages, isLoading, error) lives in chatStore — a singleton Map that
 * survives component unmount/remount.  SSE loops continue writing to the store
 * even after navigation away; returning to the chat page immediately reflects
 * the current stream state via useSyncExternalStore.
 *
 * Multiple concurrent sessions are supported: each threadId has its own store
 * entry and streams independently.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  getSessionState,
  setSessionState,
  subscribeSession,
} from "@/lib/chatStore";
import type { ChatMessage, ToolEvent } from "@/lib/chatStore";
import { parseAgentError } from "@/lib/parseAgentError";
import { emitAgentEvent } from "@/lib/agentEvents";
import { applyStateSnapshot, applyStateDelta } from "@/hooks/useAgentState";

// Re-export types for backward compatibility with AgentChat.tsx imports.
export type { ChatMessage, ToolEvent };

export interface ArtifactEntry {
  path: string;
  sha256?: string;
  size?: number;
}

interface UseAgentChatOptions {
  agentName: string;
  threadId: string;
  initialMessages?: ChatMessage[];
  model?: string;
  mode?: "copilot" | "litellm";
  systemContext?: string;
  /** Thinking mode: "auto" | "thinking" | "max" */
  thinkMode?: string;
  onArtifact?: (entry: ArtifactEntry) => void;
}

interface UseAgentChatReturn {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
  stopGeneration: () => void;
  /** Replace the messages array (used to hydrate from Postgres on mount). */
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

function nanoid(): string {
  return Math.random().toString(36).slice(2, 11);
}

export function useAgentChat({
  agentName,
  threadId,
  initialMessages = [],
  model,
  mode = "litellm",
  systemContext,
  thinkMode,
  onArtifact,
}: UseAgentChatOptions): UseAgentChatReturn {
  const onArtifactRef = useRef(onArtifact);
  useEffect(() => { onArtifactRef.current = onArtifact; }, [onArtifact]);

  // Keep latest values in refs so sendMessage always uses current values
  // even if its useCallback closure hasn't been recreated yet.
  const modelRef = useRef(model);
  const modeRef = useRef(mode);
  const agentNameRef = useRef(agentName);
  const systemContextRef = useRef(systemContext);
  const thinkModeRef = useRef(thinkMode);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { agentNameRef.current = agentName; }, [agentName]);
  useEffect(() => { systemContextRef.current = systemContext; }, [systemContext]);
  useEffect(() => { thinkModeRef.current = thinkMode; }, [thinkMode]);

  // Subscribe to the module-level store (survives navigation/unmount).
  const sessionState = useSyncExternalStore(
    (l) => subscribeSession(threadId, l),
    () => getSessionState(threadId),
    () => getSessionState(threadId),
  );
  const messages = sessionState.messages;
  const isLoading = sessionState.isLoading;
  const error = sessionState.error;

  // Initialise from initialMessages when store has nothing for this session.
  const initialMessagesRef = useRef(initialMessages);
  useEffect(() => { initialMessagesRef.current = initialMessages; }, [initialMessages]);
  useEffect(() => {
    const current = getSessionState(threadId);
    if (current.messages.length === 0 && initialMessagesRef.current.length > 0) {
      setSessionState(threadId, (prev) => ({
        ...prev,
        messages: initialMessagesRef.current,
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // setMessages — backward-compat for AgentChat.tsx DB hydration.
  const setMessages = useCallback(
    (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      setSessionState(threadId, (prev) => ({
        ...prev,
        messages:
          typeof updater === "function" ? updater(prev.messages) : updater,
      }));
    },
    [threadId],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || getSessionState(threadId).isLoading) return;

      const controller = new AbortController();
      const userMsg: ChatMessage = {
        id: nanoid(), role: "user", content: content.trim(), timestamp: Date.now(),
      };
      const assistantId = nanoid();
      const assistantMsg: ChatMessage = {
        id: assistantId, role: "assistant", content: "", timestamp: Date.now(),
        streaming: true, toolEvents: [], progressLines: [], isThinkingActive: true,
      };

      setSessionState(threadId, (prev) => ({
        ...prev,
        messages: [...prev.messages, userMsg, assistantMsg],
        isLoading: true, error: null, abortController: controller,
      }));

      // Emit run started event for subscribers
      emitAgentEvent("onRunStarted", { runId: assistantId });

      try {
        const history = getSessionState(threadId).messages
          .slice(0, -1)
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: m.content }));

        const res = await fetch("/api/agent/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            agentName: agentNameRef.current,
            message: userMsg.content,
            messages: history,
            threadId,
            mode: modeRef.current,
            model: modelRef.current ?? "auto",
            context: systemContextRef.current ?? undefined,
            thinkMode: thinkModeRef.current ?? "auto",
          }),
        });

        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => `status ${res.status}`);
          throw new Error(text);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Helper: update just the assistant message
        const upd = (fn: (m: ChatMessage) => ChatMessage) =>
          setSessionState(threadId, (prev) => ({
            ...prev,
            messages: prev.messages.map((m) => m.id === assistantId ? fn(m) : m),
          }));

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") continue;
            let evt: Record<string, unknown>;
            try { evt = JSON.parse(raw) as Record<string, unknown>; } catch (_e) { continue; }



            switch (evt.type) {
              case "delta": {
                const deltaText = String(evt.content ?? "");
                upd((m) => ({
                  ...m,
                  content: m.content + deltaText,
                  // Show brief live snippet in the ThinkingContainer header
                  // so the user sees activity, but do NOT dump into reasoning.
                  // Reasoning is reserved for actual model chain-of-thought
                  // tokens (THINKING_TEXT_MESSAGE_CONTENT / ASSISTANT_REASONING_DELTA).
                  progressLines: [
                    ...(m.progressLines ?? []).filter((l) => !l.startsWith("↳ ")),
                    `↳ ${deltaText.slice(0, 80)}`,
                  ].slice(-3),
                }));
                break;
              }
              case "progress":
                upd((m) => ({ ...m, progressLines: [...(m.progressLines ?? []), String(evt.name ?? "Working")] }));
                break;
              case "reasoning":
                upd((m) => {
                  const chunk = String(evt.content ?? "");
                  if (!chunk) return m;
                  const blocks = m.reasoningBlocks ?? [];
                  // Append to the last block if it ends mid-sentence,
                  // otherwise start a new block for a clean cascade.
                  if (blocks.length > 0 && !/[.?!]\s*$/.test(blocks[blocks.length - 1])) {
                    return {
                      ...m,
                      reasoningBlocks: [
                        ...blocks.slice(0, -1),
                        blocks[blocks.length - 1] + chunk,
                      ],
                    };
                  }
                  return {
                    ...m,
                    reasoningBlocks: [...blocks, chunk],
                  };
                });
                break;
              case "tool_start": {
                const toolId = String(evt.id ?? nanoid());
                const isDelegate = String(evt.name ?? "").toLowerCase().includes("call_agent");
                const newEvent: ToolEvent = {
                  id: toolId, name: String(evt.name ?? "tool"),
                  args: (evt.args as Record<string, unknown>) ?? {}, status: "running",
                  startedAt: Date.now(), ...(isDelegate ? { subAgentActive: true } : {}),
                };
                upd((m) => ({ ...m, toolEvents: [...(m.toolEvents ?? []), newEvent] }));
                break;
              }
              case "tool_end":
                upd((m) => ({
                  ...m,
                  toolEvents: (m.toolEvents ?? []).map((t) =>
                    t.id === String(evt.id)
                      ? {
                          ...t,
                          args: evt.args && Object.keys(evt.args as object).length > 0
                            ? (evt.args as Record<string, unknown>) : t.args,
                          result: String(evt.result ?? ""),
                          status: evt.success ? "done" : "error",
                          endedAt: Date.now(), subAgentActive: false,
                        }
                      : t
                  ),
                }));
                break;
              case "tool_partial":
                // Streaming partial output (terminal stdout, tool progress).
                // Accumulate without marking the tool as complete.
                upd((m) => ({
                  ...m,
                  toolEvents: (m.toolEvents ?? []).map((t) =>
                    t.id === String(evt.id)
                      ? { ...t, result: (t.result ?? "") + String(evt.result ?? "") }
                      : t
                  ),
                }));
                break;
              case "sub_agent_delta": {
                const tgtAgent = String(evt.agentName ?? "");
                setSessionState(threadId, (prev) => ({
                  ...prev,
                  messages: prev.messages.map((m) => {
                    if (m.id !== assistantId) return m;
                    const evts = m.toolEvents ?? [];
                    const idx = [...evts].reverse().findIndex(
                      (t) => t.subAgentActive && (t.name.toLowerCase().includes("call_agent") || t.subAgentName)
                    );
                    if (idx === -1) return m;
                    const ri = evts.length - 1 - idx;
                    return {
                      ...m, toolEvents: evts.map((t, i) => i === ri
                        ? { ...t, subAgentName: t.subAgentName ?? tgtAgent, subAgentText: (t.subAgentText ?? "") + String(evt.delta ?? "") }
                        : t),
                    };
                  }),
                }));
                break;
              }
              case "sub_agent_tool_start": {
                const tgtAgent2 = String(evt.agentName ?? "");
                const stId = String(evt.id ?? nanoid());
                setSessionState(threadId, (prev) => ({
                  ...prev,
                  messages: prev.messages.map((m) => {
                    if (m.id !== assistantId) return m;
                    const evts = m.toolEvents ?? [];
                    const idx = [...evts].reverse().findIndex(
                      (t) => t.subAgentActive && (t.name.toLowerCase().includes("call_agent") || t.subAgentName)
                    );
                    if (idx === -1) return m;
                    const ri = evts.length - 1 - idx;
                    return {
                      ...m, toolEvents: evts.map((t, i) => i === ri
                        ? { ...t, subAgentName: t.subAgentName ?? tgtAgent2, subAgentTools: [...(t.subAgentTools ?? []), { id: stId, name: String(evt.name ?? "tool"), status: "running" as const }] }
                        : t),
                    };
                  }),
                }));
                break;
              }
              case "sub_agent_tool_end": {
                const stId2 = String(evt.id ?? "");
                setSessionState(threadId, (prev) => ({
                  ...prev,
                  messages: prev.messages.map((m) => {
                    if (m.id !== assistantId) return m;
                    return {
                      ...m, toolEvents: (m.toolEvents ?? []).map((t) => !t.subAgentTools ? t : {
                        ...t, subAgentTools: t.subAgentTools.map((st) =>
                          st.id === stId2 ? { ...st, result: String(evt.result ?? ""), status: evt.success ? "done" as const : "error" as const } : st
                        ),
                      }),
                    };
                  }),
                }));
                break;
              }
              case "sub_agent_error": {
                setSessionState(threadId, (prev) => ({
                  ...prev,
                  messages: prev.messages.map((m) => {
                    if (m.id !== assistantId) return m;
                    const evts = m.toolEvents ?? [];
                    const idx = [...evts].reverse().findIndex((t) => t.subAgentActive);
                    if (idx === -1) return m;
                    const ri = evts.length - 1 - idx;
                    return {
                      ...m, toolEvents: evts.map((t, i) => i === ri
                        ? { ...t, subAgentActive: false, status: "error" as const, result: String(evt.error ?? "Sub-agent error") }
                        : t),
                    };
                  }),
                }));
                break;
              }
              case "done":
                upd((m) => ({ ...m, streaming: false, isThinkingActive: false }));
                emitAgentEvent("onRunFinalized", { runId: String(evt.run_id ?? "") });
                break;
              case "state":
                upd((m) => ({ ...m, agentState: (evt.snapshot as Record<string, unknown>) ?? {} }));
                applyStateSnapshot(threadId, (evt.snapshot as Record<string, unknown>) ?? {});
                emitAgentEvent("onStateChanged", { state: evt.snapshot as Record<string, unknown> });
                break;
              case "state_delta":
                applyStateDelta(threadId, (evt.delta as Array<{ op: string; path: string; value?: unknown }>) ?? []);
                emitAgentEvent("onStateChanged", { stateDelta: evt.delta });
                break;
              case "custom": {
                const evtName = String(evt.name ?? "");
                emitAgentEvent("onCustomEvent", { name: evtName, value: evt.value ?? evt.data });
                if ((evtName === "artifact_created" || evtName === "artifact_updated") && onArtifactRef.current) {
                  const data = (evt.value ?? evt.data) as Record<string, unknown> | undefined;
                  onArtifactRef.current({
                    path: String(data?.path ?? ""),
                    sha256: data?.sha256 ? String(data.sha256) : undefined,
                    size: data?.size != null ? Number(data.size) : undefined,
                  });
                }
                upd((m) => ({ ...m, customEvents: [...(m.customEvents ?? []), { name: evtName, value: evt.value ?? evt.data }] }));
                break;
              }
              case "error":
                throw new Error(String(evt.content ?? "Stream error"));
            }
          }
        }

        // Ensure streaming flag is cleared even if "done" was missing.
        upd((m) => ({ ...m, streaming: false, isThinkingActive: false }));
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        if (isAbort) {
          setSessionState(threadId, (prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantId ? { ...m, streaming: false, isThinkingActive: false } : m
            ),
          }));
          return;
        }
        const rawMsg = err instanceof Error ? err.message : String(err);
        const parsed = parseAgentError(rawMsg);
        emitAgentEvent("onError", { error: rawMsg });
        setSessionState(threadId, (prev) => ({
          ...prev,
          error: rawMsg,
          messages: prev.messages
            .filter((m) => m.id !== assistantId)
            .concat({
              id: nanoid(),
              role: "system",
              content: `__ERROR__${JSON.stringify(parsed)}`,
              timestamp: Date.now(),
            }),
        }));
      } finally {
        setSessionState(threadId, (prev) => ({ ...prev, isLoading: false, abortController: null }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentName, threadId, model, mode, systemContext],
  );

  const clearMessages = useCallback(() => {
    setSessionState(threadId, (prev) => ({ ...prev, messages: [], error: null }));
  }, [threadId]);

  const stopGeneration = useCallback(() => {
    const current = getSessionState(threadId);
    current.abortController?.abort();
    setSessionState(threadId, (prev) => ({ ...prev, abortController: null }));
  }, [threadId]);

  // ── Reconnection & cross-device polling ─────────────────────────────
  // Two-tier polling (always runs, even while a stream appears active):
  //   1. Fast poll (2s): when the last assistant message looks incomplete
  //      (stream was interrupted by tab close / refresh / browser quit).
  //   2. Slow poll (30s): always runs, picks up messages from other devices
  //      without requiring a session switch.
  //
  // We poll even when isLoading because the browser may have aborted the
  // SSE fetch on refresh/navigation, leaving the chatStore in a stale
  // loading state.  The backend continues running regardless, so polling
  // lets us recover the persisted messages.
  useEffect(() => {
    const last = messages[messages.length - 1];
    const lastIncomplete =
      last?.role === "assistant" &&
      last.content &&
      (last.streaming || !/[.?!]\s*$/.test(last.content.trim()));

    // If the store says we're loading but no abortController is present,
    // the stream was lost (browser refresh / tab close).  Clear the stale
    // loading flag so polling can take over immediately.
    if (isLoading) {
      const current = getSessionState(threadId);
      if (!current.abortController) {
        // Stale loading flag from a lost connection — clear it.
        setSessionState(threadId, (prev) => ({ ...prev, isLoading: false }));
      }
      // Regardless, still poll so we don't miss messages.
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout>;

    // Track the last known message count so we only update on change
    let lastKnownCount = messages.length;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(
          `/api/chat/sessions/${threadId}/messages`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) return;
        const remote = await res.json() as Array<{
          id: string; role: string; content: string;
          timestamp: number; tool_events?: unknown[];
          progress_lines?: string[]; reasoning?: string[] | null;
          agent_state?: Record<string, unknown> | null;
          custom_events?: unknown[];
        }>;
        if (!Array.isArray(remote) || remote.length === 0) return;

        // Only update if remote has MORE messages than we currently have
        if (remote.length <= lastKnownCount) {
          // Still schedule next poll if needed
          const remoteLast = remote[remote.length - 1];
          const stillIncomplete =
            remoteLast?.role === "assistant" &&
            remoteLast.content &&
            !/[.?!]\s*$/.test(remoteLast.content.trim());

          if (!cancelled) {
            const interval = stillIncomplete ? 3000 : 30000;
            pollTimer = setTimeout(poll, interval);
          }
          return;
        }

        // Map remote format to ChatMessage
        const remoteMsgs: ChatMessage[] = remote.map((r) => ({
          id: r.id,
          role: r.role as "user" | "assistant" | "system",
          content: r.content ?? "",
          timestamp: r.timestamp ?? Date.now(),
          toolEvents: (r.tool_events as ToolEvent[]) ?? [],
          progressLines: r.progress_lines ?? [],
          reasoningBlocks: Array.isArray(r.reasoning)
            ? r.reasoning.filter((x): x is string => typeof x === "string")
            : undefined,
          agentState: r.agent_state ?? undefined,
          customEvents: (r.custom_events as Array<{ name: string; value: unknown }>) ?? [],
        }));

        // Merge: keep local non-streaming messages, replace with remote
        // for any assistant messages that were streaming (now complete on server).
        // The backend persists assistant messages with id=`assistant-${threadId}`,
        // which differs from the local nanoid().  We match by role+content prefix
        // to avoid duplicates when recovering from a lost SSE stream.
        const localIds = new Set(messages.map((m) => m.id));
        const localStreamingContent = messages
          .filter((m) => m.role === "assistant" && m.streaming)
          .map((m) => m.content);
        const newMsgs = remoteMsgs.filter((m) => {
          if (localIds.has(m.id)) return false;
          // Skip remote assistant messages whose content is a prefix of
          // a local streaming message (we already have that partial text).
          if (m.role === "assistant" && m.content) {
            for (const sc of localStreamingContent) {
              if (sc && (sc.startsWith(m.content) || m.content.startsWith(sc))) return false;
            }
          }
          return true;
        });

        if (newMsgs.length > 0) {
          lastKnownCount = remote.length;
          setSessionState(threadId, (prev) => ({
            ...prev,
            messages: [
              ...prev.messages.filter((m) => m.role !== "assistant" || !m.streaming),
              ...newMsgs,
            ],
          }));
        }

        // Determine next poll interval
        const updatedLast = remoteMsgs[remoteMsgs.length - 1];
        const stillIncomplete =
          updatedLast?.role === "assistant" &&
          updatedLast.content &&
          !/[.?!]\s*$/.test(updatedLast.content.trim());

        if (!cancelled) {
          const interval = stillIncomplete ? 3000 : 30000;
          pollTimer = setTimeout(poll, interval);
        }
      } catch {
        if (!cancelled) pollTimer = setTimeout(poll, 10000);
      }
    };

    // Start polling: fast if incomplete or recovering from lost stream,
    // slow otherwise.
    const stillRecovering = isLoading; // active stream or stale loading flag
    const initialInterval = (lastIncomplete || stillRecovering) ? 2000 : 30000;
    pollTimer = setTimeout(poll, initialInterval);

    return () => { cancelled = true; clearTimeout(pollTimer); };
  }, [threadId, messages, isLoading]);

  return { messages, isLoading, error, sendMessage, clearMessages, stopGeneration, setMessages };
}
