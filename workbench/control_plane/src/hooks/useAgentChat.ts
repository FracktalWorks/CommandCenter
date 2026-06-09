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
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { agentNameRef.current = agentName; }, [agentName]);
  useEffect(() => { systemContextRef.current = systemContext; }, [systemContext]);

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
                break;
              case "state":
                upd((m) => ({ ...m, agentState: (evt.snapshot as Record<string, unknown>) ?? {} }));
                break;
              case "custom": {
                const evtName = String(evt.name ?? "");
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

  return { messages, isLoading, error, sendMessage, clearMessages, stopGeneration, setMessages };
}
