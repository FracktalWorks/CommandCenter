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
import { activeContextSlice, isCompactionCheckpoint } from "@/lib/tokenCount";
import { emitAgentEvent } from "@/lib/agentEvents";
import { applyStateSnapshot, applyStateDelta } from "@/hooks/useAgentState";

// Re-export types for backward compatibility with AgentChat.tsx imports.
export type { ChatMessage, ToolEvent };

// HITL control events drive the inline ElicitationCard / ConfirmationCard — they
// are interaction signals, not data to display in the generic "Interactive view"
// AG-UI panel.  Keep them out of message.customEvents so they don't render twice
// (and linger after the user answers).
const HITL_CONTROL_EVENTS = new Set([
  "elicitation_requested",
  "user_input_requested",
  "confirmation_requested",
]);

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
  /** True while polling is actively recovering a stream that was interrupted
   *  by a page refresh. The UI shows a "Reconnecting…" indicator. */
  recovering: boolean;
  /** Agent run status for the UI: "idle" | "running" | "recovering" | "unknown".
   *  Lets the user know if execution is stored, stuck, or ongoing. */
  runStatus: "idle" | "running" | "recovering" | "unknown";
}

function nanoid(): string {
  return Math.random().toString(36).slice(2, 11);
}

/**
 * Fold pre-tool narration into the reasoning blocks and compute the timeline
 * cutoff for a starting tool (VS Code-style interleaved thinking).
 *
 * Blocks with index < cutoff render BEFORE the tool in the timeline;
 * reasoning that streams in afterwards lands at index >= cutoff and renders
 * AFTER it.  An empty sentinel block is appended when needed so later
 * reasoning never merges into a pre-tool block.
 */
function foldForToolStart(
  blocks: string[] | undefined,
  narration: string,
): { blocks: string[]; cutoff: number } {
  const folded = narration ? [...(blocks ?? []), narration] : [...(blocks ?? [])];
  if (folded.length === 0) return { blocks: folded, cutoff: 0 };
  if (!folded[folded.length - 1].trim()) {
    // Trailing empty sentinel from a previous tool — future reasoning merges
    // into it, so it must sit after this tool too.
    return { blocks: folded, cutoff: folded.length - 1 };
  }
  // Seal the current block so later reasoning starts a NEW block after the tool.
  return { blocks: [...folded, ""], cutoff: folded.length };
}

/**
 * Un-fold the trailing narration block back into the visible answer.
 *
 * `foldForToolStart` moves answer text into the thinking timeline at every
 * tool_start, on the assumption that only text emitted AFTER the last tool call
 * is the real answer.  That assumption breaks when a turn ENDS on a tool call
 * (save_memory, manage_todo_list, write_artifact, a trailing verification
 * command, …): the genuine answer was the last folded block and `content` ends
 * up empty — the answer "disappears" into the consciousness stream.
 *
 * This restores it: promote reasoningBlocks[foldedAnswerIdx] back to `content`
 * and blank that block (kept as an empty sentinel so each tool's
 * reasoningCutoff index stays aligned — empty blocks are skipped at render).
 * No-op when answer text already followed the last tool call (content non-empty)
 * or nothing was folded (foldedAnswerIdx < 0).  Keep in sync with the inline
 * mirror in app/api/agent/chat/route.ts (translateAndPersistStream).
 */
function unfoldTrailingAnswer(
  content: string,
  reasoningBlocks: string[] | undefined,
  foldedAnswerIdx: number,
): { content: string; reasoningBlocks: string[] | undefined } {
  if (content.trim() || foldedAnswerIdx < 0) return { content, reasoningBlocks };
  const blocks = reasoningBlocks ?? [];
  const candidate = blocks[foldedAnswerIdx];
  if (!candidate || !candidate.trim()) return { content, reasoningBlocks };
  return {
    content: candidate,
    reasoningBlocks: blocks.map((b, i) => (i === foldedAnswerIdx ? "" : b)),
  };
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
      emitAgentEvent("onRunStarted", { runId: assistantId, threadId });

      try {
        // Build the history sent to the model from the ACTIVE context window
        // (everything from the most recent compaction checkpoint onward), so a
        // compacted conversation sends [summary + recent turns] instead of the
        // whole transcript — matching Claude Code / Copilot CLI.  The checkpoint
        // summary (a system message) is kept; other system messages are dropped.
        const prior = getSessionState(threadId).messages.slice(0, -1);
        const active = activeContextSlice(prior);
        const history = active
          .filter((m, idx) => m.role !== "system" || (idx === 0 && isCompactionCheckpoint(m)))
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
            // Pass the assistant message ID so the server-side proxy persists
            // content to the SAME row the frontend renders.  Without this the
            // proxy used a constant id (assistant-<threadId>) that overwrote
            // every turn and never correlated with the frontend's nanoid —
            // breaking refresh recovery.
            assistantMessageId: assistantId,
          }),
        });

        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => `status ${res.status}`);
          throw new Error(text);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // Index of the most recently folded answer block (text that streamed as
        // the visible answer but was moved into the timeline at a tool_start).
        // Restored as `content` at run end if no further answer text followed
        // the last tool call.  -1 = nothing to un-fold.  See unfoldTrailingAnswer.
        let foldedAnswerIdx = -1;

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

            // Track the last SSE event ID for reconnection support.
            if (evt._stream_id) {
              setSessionState(threadId, (prev) => ({
                ...prev,
                lastEventId: String(evt._stream_id),
              }));
            }


            switch (evt.type) {
              case "delta": {
                const deltaText = String(evt.content ?? "");
                // New visible answer text → any earlier narration fold was
                // genuine narration, not the answer.  Drop the un-fold candidate.
                foldedAnswerIdx = -1;
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
              case "todos":
                upd((m) => ({
                  ...m,
                  todos: Array.isArray(evt.todos)
                    ? (evt.todos as { id: string; title: string; status: string }[])
                    : m.todos,
                }));
                break;
              case "reasoning":
                upd((m) => {
                  const chunk = String(evt.content ?? "");
                  if (!chunk) return m;
                  const blocks = m.reasoningBlocks ?? [];
                  // Verbose token streams: append to the current block and
                  // only start a new one at paragraph breaks (\n\n) — the
                  // same grouping VS Code Copilot uses for thinking text.
                  if (blocks.length === 0) {
                    return { ...m, reasoningBlocks: [chunk] };
                  }
                  const last = blocks[blocks.length - 1] + chunk;
                  const parts = last.split(/\n{2,}/);
                  return {
                    ...m,
                    reasoningBlocks: [
                      ...blocks.slice(0, -1),
                      ...parts.filter((p, i) => p.trim() || i === parts.length - 1),
                    ],
                  };
                });
                break;
              case "tool_start": {
                const toolId = String(evt.id ?? nanoid());
                const isDelegate = String(evt.name ?? "").toLowerCase().includes("call_agent");
                upd((m) => {
                  // VS Code-style narration fold: text emitted BEFORE a tool
                  // call is the model narrating its plan ("Let me check…"),
                  // not the final answer.  Move it into the thinking
                  // timeline; only text after the LAST tool call remains as
                  // the visible answer.
                  const narration = m.content.trim();
                  const { blocks, cutoff } = foldForToolStart(m.reasoningBlocks, narration);
                  // The just-folded answer text sits at cutoff-1 (foldForToolStart
                  // appends narration then an empty sentinel).  Remember it so the
                  // run-end handler can restore it if no further answer follows.
                  if (narration) foldedAnswerIdx = cutoff - 1;
                  const newEvent: ToolEvent = {
                    id: toolId, name: String(evt.name ?? "tool"),
                    args: (evt.args as Record<string, unknown>) ?? {}, status: "running",
                    startedAt: Date.now(), reasoningCutoff: cutoff,
                    ...(isDelegate ? { subAgentActive: true } : {}),
                  };
                  return {
                    ...m,
                    content: narration ? "" : m.content,
                    reasoningBlocks: blocks,
                    toolEvents: [...(m.toolEvents ?? []), newEvent],
                  };
                });
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
                upd((m) => {
                  const u = unfoldTrailingAnswer(m.content, m.reasoningBlocks, foldedAnswerIdx);
                  return { ...m, content: u.content, reasoningBlocks: u.reasoningBlocks, streaming: false, isThinkingActive: false };
                });
                emitAgentEvent("onRunFinalized", { runId: String(evt.run_id ?? ""), threadId });
                break;
              case "state":
                upd((m) => ({ ...m, agentState: (evt.snapshot as Record<string, unknown>) ?? {} }));
                applyStateSnapshot(threadId, (evt.snapshot as Record<string, unknown>) ?? {});
                emitAgentEvent("onStateChanged", { state: evt.snapshot as Record<string, unknown>, threadId });
                break;
              case "state_delta":
                applyStateDelta(threadId, (evt.delta as Array<{ op: string; path: string; value?: unknown }>) ?? []);
                emitAgentEvent("onStateChanged", { stateDelta: evt.delta, threadId });
                break;
              case "custom": {
                const evtName = String(evt.name ?? "");
                emitAgentEvent("onCustomEvent", { name: evtName, value: evt.value ?? evt.data, threadId });
                if ((evtName === "artifact_created" || evtName === "artifact_updated") && onArtifactRef.current) {
                  const data = (evt.value ?? evt.data) as Record<string, unknown> | undefined;
                  onArtifactRef.current({
                    path: String(data?.path ?? ""),
                    sha256: data?.sha256 ? String(data.sha256) : undefined,
                    size: data?.size != null ? Number(data.size) : undefined,
                  });
                }
                // HITL control events (ask_questions / ask_user / confirm) are
                // rendered by the inline ElicitationCard — they are NOT data to
                // display.  Storing them in customEvents made them surface in the
                // generic "Interactive view" AG-UI panel too, a duplicate that
                // never cleared after the user answered.  Skip persisting them;
                // the asking already shows in the thinking stream as a tool call.
                if (!HITL_CONTROL_EVENTS.has(evtName)) {
                  upd((m) => ({ ...m, customEvents: [...(m.customEvents ?? []), { name: evtName, value: evt.value ?? evt.data }] }));
                }
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
        // Browser-disconnect errors: the user refreshed, navigated away, or
        // the network dropped.  Don't surface these as agent errors — the
        // backend continues running and polling will recover the output.
        //
        // IMPORTANT: Only match browser-level network errors (TypeError /
        // DOMException).  Backend SSE error events (plain Error thrown by our
        // own code from "case 'error':" in the reader loop) MUST pass through
        // so the user sees them.  Otherwise legitimate backend failures like
        // "Load failed" (Copilot SDK model load error) get swallowed.
        const rawErr = err instanceof Error ? err.message : String(err);
        const lc = rawErr.toLowerCase();
        const isBrowserNetworkError =
          err instanceof TypeError || err instanceof DOMException;
        const isDisconnect =
          isBrowserNetworkError && (
            err instanceof DOMException && err.name === "AbortError" ||
            lc.includes("failed to fetch") ||
            lc.includes("fetch") ||
            lc.includes("network") ||
            lc.includes("load failed") ||
            lc.includes("aborted") ||
            lc.includes("bodystreambuffer") ||
            lc.includes("err_network") ||
            lc.includes("connection")
          );
        if (isDisconnect) {
          // Mark assistant as no longer streaming but keep the partial content.
          // The polling effect will pick up the completed message from Postgres.
          setSessionState(threadId, (prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantId ? { ...m, streaming: false, isThinkingActive: false } : m
            ),
          }));
          // Don't clear isLoading — let the polling effect handle recovery.
          return;
        }
        const rawMsg = rawErr;
        const parsed = parseAgentError(rawMsg);
        emitAgentEvent("onError", { error: rawMsg, threadId });
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

  // ── Recover after refresh / reconnect ──────────────────────────────
  // On mount, reconnect to a live agent run when EITHER:
  //   a) the last local message looks interrupted (mid-stream refresh), OR
  //   b) the server says an agent is still running for this thread
  //      (covers refresh-during-thinking, where the empty assistant
  //      placeholder was never persisted so no local evidence exists).
  // If the reconnect endpoint is unavailable or the stream has expired,
  // we fall back to the existing Postgres polling recovery path.
  useEffect(() => {
    const abortCtrl = new AbortController();
    let reconnected = false;
    let cancelled = false;

    (async () => {
      const state = getSessionState(threadId);
      const last = state.messages[state.messages.length - 1];
      const localInterrupted = Boolean(
        last?.role === "assistant" && (
          last.streaming ||
          (last.content && !/[.?!]\s*$/.test(last.content.trim()))
        )
      );

      // Server truth: is an agent actually running for this thread?
      let serverActive = false;
      try {
        const r = await fetch("/api/chat/active-sessions", { signal: abortCtrl.signal });
        if (r.ok) {
          const arr = (await r.json()) as { threadId?: string }[];
          serverActive = Array.isArray(arr) && arr.some((s) => s.threadId === threadId);
        }
      } catch { /* server unreachable — rely on local heuristic */ }

      // Surface the agent's run status so the UI can show a meaningful
      // indicator — not just a generic "Reconnecting…" spinner.
      if (!cancelled) {
        setSessionState(threadId, (prev) => ({
          ...prev,
          runStatus: serverActive ? "running" : localInterrupted ? "recovering" : "idle",
        }));
      }

      if (cancelled) return;
      if (!localInterrupted && !serverActive) return;

      // ── Non-active interruption: let polling recover from Postgres ──
      // If the server is not actively running (agent finished) but the
      // last local message looks interrupted (e.g. ends mid-code-block
      // without terminal punctuation), DON'T try to reconnect — it would
      // reset the perfectly-valid local content and leave an empty
      // placeholder while waiting for a Redis stream that already expired.
      // Just set recovering=true so the polling loop fetches the settled
      // content from Postgres at 1.5s intervals.
      if (!serverActive) {
        if (localInterrupted && !cancelled) {
          setSessionState(threadId, (prev) => ({
            ...prev,
            recovering: true,
            runStatus: "recovering",
          }));
        }
        return;
      }

      // ── Surface loading state so the stop button appears ──────────
      // When an agent is still running on the server, the user needs a
      // way to abort it.  Store the abort controller so stopGeneration()
      // can tear down the reconnect SSE + polling.
      setSessionState(threadId, (prev) => ({
        ...prev,
        isLoading: true,
        abortController: abortCtrl,
      }));

      // Ensure there's an assistant message to stream the replay into.
      let lastId: string;
      let lastContent: string;
      if (localInterrupted && last) {
        lastId = last.id;
        lastContent = last.content || "";
        // Clear stale streaming flags and show "Reconnecting…".
        setSessionState(threadId, (prev) => ({
          ...prev,
          error: null,
          recovering: true,
          runStatus: "recovering",
          isLoading: true,
          abortController: abortCtrl,
          messages: prev.messages.map((m) =>
            m.id === lastId ? { ...m, streaming: false, isThinkingActive: false } : m
          ),
        }));
      } else {
        // Agent is running but no assistant message survived the refresh
        // (it was an empty thinking placeholder) — create a fresh one.
        lastId = nanoid();
        lastContent = "";
        const placeholder: ChatMessage = {
          id: lastId, role: "assistant", content: "", timestamp: Date.now(),
          streaming: true, toolEvents: [], progressLines: [], isThinkingActive: true,
        };
        setSessionState(threadId, (prev) => ({
          ...prev,
          error: null,
          recovering: true,
          runStatus: "running",
          isLoading: true,
          abortController: abortCtrl,
          messages: [...prev.messages, placeholder],
        }));
      }

      // ── Attempt live SSE reconnection ────────────────────────────────
      try {
        const curState = getSessionState(threadId);
        const res = await fetch("/api/agent/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortCtrl.signal,
          body: JSON.stringify({
            agentName: agentNameRef.current,
            message: lastContent || "(reconnect)",
            messages: activeContextSlice(curState.messages)
              .filter((m, idx) => m.role !== "system" || (idx === 0 && isCompactionCheckpoint(m)))
              .map((m) => ({ role: m.role, content: m.content })),
            threadId,
            mode: modeRef.current,
            model: modelRef.current ?? "auto",
            context: systemContextRef.current ?? undefined,
            thinkMode: thinkModeRef.current ?? "auto",
            assistantMessageId: lastId,
            lastEventId: curState.lastEventId ?? undefined,
            reconnect: true,
          }),
        });

        if (!res.ok || !res.body) { return; }  // Fall back to polling.

        // ── Reset the interrupted message before replay ─────────────────
        // The reconnect replays ALL events from the Redis stream (since
        // lastEventId is null — initial SSE frames don't carry stream IDs).
        // If we don't clear the existing partial content, replayed deltas
        // get appended on top of what's already there, doubling text,
        // reasoning blocks, and tool events.
        setSessionState(threadId, (prev) => ({
          ...prev,
          messages: prev.messages.map((m) =>
            m.id === lastId
              ? {
                  ...m,
                  content: "",
                  toolEvents: [],
                  reasoningBlocks: [],
                  progressLines: [],
                  isThinkingActive: true,
                  streaming: true,
                }
              : m
          ),
        }));

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // Un-fold candidate for the replayed stream (mirror of the live loop).
        let foldedAnswerIdx = -1;

        // Update helper: applies changes ONLY to the specific message we're
        // replaying into (matched by lastId).  Previous messages — even those
        // without terminal punctuation — must never be modified by replayed
        // delta events; only the reset target message should accumulate content.
        const updLast = (fn: (m: ChatMessage) => ChatMessage) =>
          setSessionState(threadId, (prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === lastId ? fn(m) : m
            ),
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
            try { evt = JSON.parse(raw); } catch { continue; }

            // Track stream ID for future reconnections.
            if (evt._stream_id) {
              setSessionState(threadId, (prev) => ({
                ...prev,
                lastEventId: String(evt._stream_id),
              }));
            }

            switch (evt.type) {
              case "delta":
                foldedAnswerIdx = -1;
                updLast((m) => ({
                  ...m,
                  content: m.content + String(evt.content ?? ""),
                  streaming: true,
                }));
                break;
              case "reasoning":
                updLast((m) => {
                  const chunk = String(evt.content ?? "");
                  if (!chunk) return m;
                  const blocks = m.reasoningBlocks ?? [];
                  // Paragraph-break grouping (\n\n) — keep in sync with the
                  // live loop and route.ts translator.
                  if (blocks.length === 0) {
                    return { ...m, reasoningBlocks: [chunk] };
                  }
                  const merged = blocks[blocks.length - 1] + chunk;
                  const parts = merged.split(/\n{2,}/);
                  return {
                    ...m,
                    reasoningBlocks: [
                      ...blocks.slice(0, -1),
                      ...parts.filter((p, i) => p.trim() || i === parts.length - 1),
                    ],
                  };
                });
                break;
              case "progress":
                updLast((m) => ({
                  ...m,
                  progressLines: [...(m.progressLines ?? []), String(evt.name ?? "Working")],
                }));
                break;
              case "tool_start": {
                const toolId = String(evt.id ?? nanoid());
                updLast((m) => {
                  const narration = m.content.trim();
                  const { blocks, cutoff } = foldForToolStart(m.reasoningBlocks, narration);
                  if (narration) foldedAnswerIdx = cutoff - 1;
                  return {
                    ...m,
                    content: narration ? "" : m.content,
                    reasoningBlocks: blocks,
                    toolEvents: [...(m.toolEvents ?? []), {
                      id: toolId, name: String(evt.name ?? "tool"),
                      args: (evt.args as Record<string, unknown>) ?? {},
                      status: "running" as const, startedAt: Date.now(),
                      reasoningCutoff: cutoff,
                    }],
                  };
                });
                break;
              }
              case "tool_end":
                updLast((m) => {
                  const newStatus: ToolEvent["status"] = evt.success ? "done" : "error";
                  return {
                    ...m,
                    toolEvents: (m.toolEvents ?? []).map((t) =>
                      t.id === String(evt.id)
                        ? { ...t, result: String(evt.result ?? ""), status: newStatus, endedAt: Date.now() }
                        : t
                    ),
                  };
                });
                break;
              case "tool_partial":
                // Live terminal/tool output streaming into the running tool row.
                updLast((m) => ({
                  ...m,
                  toolEvents: (m.toolEvents ?? []).map((t) =>
                    t.id === String(evt.id)
                      ? { ...t, result: (t.result ?? "") + String(evt.result ?? "") }
                      : t
                  ),
                }));
                break;
              case "custom": {
                // Mirror the live loop so a HITL question pending when the page
                // was refreshed re-shows its card on reconnect (the "restored
                // question session" path).  HITL control events drive the
                // ElicitationCard via the subscriber and are NOT stored as
                // displayable customEvents (no duplicate "Interactive view").
                const evtName = String(evt.name ?? "");
                emitAgentEvent("onCustomEvent", { name: evtName, value: evt.value ?? evt.data, threadId });
                if ((evtName === "artifact_created" || evtName === "artifact_updated") && onArtifactRef.current) {
                  const data = (evt.value ?? evt.data) as Record<string, unknown> | undefined;
                  onArtifactRef.current({
                    path: String(data?.path ?? ""),
                    sha256: data?.sha256 ? String(data.sha256) : undefined,
                    size: data?.size != null ? Number(data.size) : undefined,
                  });
                }
                if (!HITL_CONTROL_EVENTS.has(evtName)) {
                  updLast((m) => ({ ...m, customEvents: [...(m.customEvents ?? []), { name: evtName, value: evt.value ?? evt.data }] }));
                }
                break;
              }
              case "done": {
                reconnected = true;
                // Restore a trailing answer folded into the timeline (turn ended
                // on a tool call) before measuring recovered content below.
                updLast((m) => {
                  const u = unfoldTrailingAnswer(m.content, m.reasoningBlocks, foldedAnswerIdx);
                  return { ...m, content: u.content, reasoningBlocks: u.reasoningBlocks };
                });
                // Check if we actually recovered content.  When the Redis
                // stream has expired, the reconnect endpoint returns only a
                // synthetic RUN_FINISHED with no prior delta/tool events —
                // the recovered message will be empty.  In that case keep
                // recovering=true so the polling effect fills in content
                // from Postgres.
                const cur = getSessionState(threadId);
                const recoveredMsg = cur.messages.find((m) => m.id === lastId);
                const hasRecoveredContent =
                  (recoveredMsg?.content?.trim() ?? "") ||
                  (recoveredMsg?.toolEvents?.length ?? 0) > 0 ||
                  (recoveredMsg?.reasoningBlocks?.length ?? 0) > 0;
                updLast((m) => ({ ...m, streaming: false, isThinkingActive: false }));
                setSessionState(threadId, (prev) => ({
                  ...prev,
                  recovering: hasRecoveredContent ? false : prev.recovering,
                  runStatus: hasRecoveredContent ? "idle" : "recovering",
                  isLoading: hasRecoveredContent ? false : prev.isLoading,
                  abortController: hasRecoveredContent ? null : prev.abortController,
                }));
                break;
              }
              case "error":
                // The agent emitted an error during its run (e.g. Copilot
                // SDK "Load failed" during model warmup).  Don't abort the
                // entire reconnection — the agent may have recovered and
                // produced output afterward.  The error will be surfaced
                // alongside the recovered content.
                updLast((m) => ({
                  ...m,
                  customEvents: [
                    ...(m.customEvents ?? []),
                    { name: "agent_error", value: evt.content ?? evt.message ?? "Agent error" },
                  ],
                }));
                break;
            }
          }
        }

        // If we got here without a "done" event, the stream ended cleanly.
        if (!reconnected) {
          const cur2 = getSessionState(threadId);
          const recoveredMsg2 = cur2.messages.find((m) => m.id === lastId);
          const hasContent =
            (recoveredMsg2?.content?.trim() ?? "") ||
            (recoveredMsg2?.toolEvents?.length ?? 0) > 0 ||
            (recoveredMsg2?.reasoningBlocks?.length ?? 0) > 0;
          updLast((m) => ({ ...m, streaming: false, isThinkingActive: false }));
          setSessionState(threadId, (prev) => ({
            ...prev,
            recovering: hasContent ? false : prev.recovering,
            runStatus: hasContent ? "idle" : "recovering",
            isLoading: hasContent ? false : prev.isLoading,
            abortController: hasContent ? null : prev.abortController,
          }));
        }
      } catch {
        // Reconnect failed (network error, timeout, etc.) — polling handles it.
        // Clear loading state so the stop button doesn't linger.
        if (!cancelled) {
          setSessionState(threadId, (prev) => ({
            ...prev,
            isLoading: false,
            abortController: null,
          }));
        }
      } finally {
        // If we never reconnected, make sure recovering is set for polling.
        if (!reconnected && !cancelled) {
          setSessionState(threadId, (prev) =>
            prev.recovering
              ? prev
              : { ...prev, recovering: true, runStatus: "recovering" }
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      abortCtrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const stopGeneration = useCallback(() => {
    const current = getSessionState(threadId);
    // 1. Abort the local SSE fetch (stops the browser reading the stream).
    current.abortController?.abort();
    // 2. Tell the backend to ACTUALLY cancel the run.  Without this the agent
    //    keeps executing detached server-side (burning tokens, writing files)
    //    because it's decoupled from the HTTP response lifecycle.  Fire-and-
    //    forget — the UI shouldn't block on it.
    void fetch("/api/agent/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId }),
      keepalive: true,
    }).catch(() => {});
    // 3. Immediately clear loading/recovering state so the UI reflects idle
    //    (don't wait for the next polling tick to clear the stale flag).
    setSessionState(threadId, (prev) => ({
      ...prev,
      abortController: null,
      isLoading: false,
      recovering: false,
      runStatus: "idle",
    }));
  }, [threadId]);

  // ── Reconnection & cross-device polling ─────────────────────────────
  // Three-tier polling (always runs, even while a stream appears active):
  //   1. Recovery poll (1.5s): when recovering=true (stream was interrupted
  //      by refresh and we're actively pulling content from Postgres).
  //   2. Fast poll (3s): when the last assistant message looks incomplete
  //      (no terminal punctuation) but we're not in recovery mode.
  //   3. Slow poll (30s): always runs, picks up messages from other devices
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

    // Recovery timeout: set when recovering is first detected, cleared when done.
    let recoveryStartedAt = 0;

    const poll = async () => {
      if (cancelled) return;
      try {
        // Poll only the most recent window — polling exists to pick up the
        // latest assistant message growing / new turns, never to backfill old
        // history (that's loadOlderHistory's job).  The content-aware merge
        // below only updates/appends by id, so older loaded messages are kept.
        const res = await fetch(
          `/api/chat/sessions/${threadId}/messages?limit=50`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) return;
        const remote = await res.json() as Array<{
          id: string; role: string; content: string;
          timestamp: number; tool_events?: unknown[];
          progress_lines?: string[]; reasoning?: string | null;
          agent_state?: Record<string, unknown> | null;
          custom_events?: unknown[];
        }>;
        if (!Array.isArray(remote) || remote.length === 0) return;

        // Map remote format to ChatMessage.  Drop stale __ERROR__ system
        // messages persisted by older builds — transient errors must never
        // resurface via polling.
        const remoteMsgs: ChatMessage[] = remote
          .filter((r) => !(r.role === "system" && (r.content ?? "").startsWith("__ERROR__")))
          .map((r) => ({
          id: r.id,
          role: r.role as "user" | "assistant" | "system",
          content: r.content ?? "",
          timestamp: r.timestamp ?? Date.now(),
          toolEvents: (r.tool_events as ToolEvent[]) ?? [],
          progressLines: r.progress_lines ?? [],
          // Split WITHOUT dropping empty segments — block indices must stay
          // aligned with each tool's reasoningCutoff (empty sentinels are
          // skipped at render time instead).
          reasoningBlocks: (typeof r.reasoning === "string" && r.reasoning)
            ? r.reasoning.split("\n---\n")
            : undefined,
          agentState: r.agent_state ?? undefined,
          // Restore the todo list from agent_state (where it was persisted
          // by persistAssistantMessage).  Mirrors the mapping in
          // sessions.ts fetchMessagesFromDb so the Todos panel survives
          // polling recovery after a page refresh mid-stream.
          todos: (
            (r.agent_state as Record<string, unknown> | null)
              ?.todos as { id: string; title: string; status: string }[] | undefined
          ),
          customEvents: (r.custom_events as Array<{ name: string; value: unknown }>) ?? [],
        }));

        // Content-aware merge.  Handles two recovery cases:
        //   (a) New messages appended on the server (count grew).
        //   (b) The same assistant message got LONGER content while we were
        //       away (refresh recovery) — count is unchanged but content grew.
        const cur = getSessionState(threadId);
        // Skip merge entirely if we're actively streaming locally (live SSE
        // is authoritative — avoid clobbering it with slightly-stale polls).
        if (cur.abortController) {
          pollTimer = setTimeout(poll, 3000);
          return;
        }

        const localById = new Map(cur.messages.map((m) => [m.id, m]));
        let changed = false;

        // Find the longest local assistant content (to detect server growth
        // even when ids differ, e.g. local nanoid vs server assistant-<tid>).
        const localAssistantContents = cur.messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.content);

        const merged: ChatMessage[] = [...cur.messages];

        for (const rm of remoteMsgs) {
          const localMatch = localById.get(rm.id);
          if (localMatch) {
            // Same id — update if the server has more content/tool events/reasoning.
            if (
              rm.content.length > localMatch.content.length ||
              (rm.toolEvents?.length ?? 0) > (localMatch.toolEvents?.length ?? 0) ||
              (rm.reasoningBlocks?.length ?? 0) > (localMatch.reasoningBlocks?.length ?? 0)
            ) {
              const idx = merged.findIndex((m) => m.id === rm.id);
              if (idx >= 0) {
                merged[idx] = { ...localMatch, ...rm, streaming: false };
                changed = true;
              }
            }
            continue;
          }

          // No id match.  If this is an assistant message whose content is a
          // superset of a local partial assistant message, replace that local
          // partial (refresh recovery — server has the fuller version).
          if (rm.role === "assistant" && rm.content) {
            const supersedesIdx = merged.findIndex(
              (m) =>
                m.role === "assistant" &&
                m.content &&
                rm.content.startsWith(m.content) &&
                rm.content.length >= m.content.length,
            );
            if (supersedesIdx >= 0) {
              merged[supersedesIdx] = { ...rm, streaming: false };
              changed = true;
              continue;
            }
            // Skip if identical content already present anywhere.
            if (localAssistantContents.includes(rm.content)) continue;
          }

          // Genuinely new message.
          merged.push(rm);
          changed = true;
        }

        if (changed) {
          lastKnownCount = merged.length;
          setSessionState(threadId, (prev) => ({
            ...prev,
            // Clear loading once we've recovered settled content.
            isLoading: prev.abortController ? prev.isLoading : false,
            messages: merged,
          }));
        }

        // Determine next poll interval and whether to clear recovering.
        const updatedLast = remoteMsgs[remoteMsgs.length - 1];
        const stillIncomplete =
          updatedLast?.role === "assistant" &&
          updatedLast.content &&
          !/[.?!]\s*$/.test(updatedLast.content.trim());

        // Clear recovering if the server message looks settled (ends with
        // punctuation) or we've been in recovery for >45s.
        const curRecovering = getSessionState(threadId).recovering;
        if (curRecovering) {
          // Track when recovery first started.
          if (!recoveryStartedAt) recoveryStartedAt = Date.now();
          const recoveryAge = Date.now() - recoveryStartedAt;
          if (!stillIncomplete || recoveryAge > 45000) {
            setSessionState(threadId, (prev) => ({ ...prev, recovering: false, runStatus: "idle" }));
            recoveryStartedAt = 0;
          }
        } else {
          recoveryStartedAt = 0;
        }

        if (!cancelled) {
          // Recovery mode: fast 1.5s polling. Incomplete: 3s. Settled: 30s.
          const curStillRecovering = getSessionState(threadId).recovering;
          const interval = curStillRecovering ? 1500 : stillIncomplete ? 3000 : 30000;
          pollTimer = setTimeout(poll, interval);
        }
      } catch {
        if (!cancelled) pollTimer = setTimeout(poll, 10000);
      }
    };

    // Start polling: always fast initially (2s) when there are messages,
    // let the poll function dynamically adjust based on recovering/incomplete state.
    const hasMessages = messages.length > 0;
    const initialInterval = hasMessages ? 2000 : 30000;
    pollTimer = setTimeout(poll, initialInterval);

    return () => { cancelled = true; clearTimeout(pollTimer); };
  }, [threadId, messages, isLoading]);

  const recovering = getSessionState(threadId).recovering;
  const runStatus = getSessionState(threadId).runStatus;

  return { messages, isLoading, error, sendMessage, clearMessages, stopGeneration, setMessages, recovering, runStatus };
}
