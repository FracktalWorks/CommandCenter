"use client";

/**
 * useAgentChat — streaming chat hook for MAF / LiteLLM agents.
 *
 * Uses Server-Sent Events (SSE) so tokens and tool-call events stream to the
 * UI in real time, mirroring the VS Code Copilot experience.
 *
 * SSE event types emitted by /api/agent/chat:
 *   {"type":"delta",      "content":"..."}          — partial token
 *   {"type":"tool_start", "id":"…", "name":"…", "args":{}}
 *   {"type":"tool_end",   "id":"…", "name":"…", "result":"…", "success":bool}
 *   {"type":"done",       "run_id":"…"}
 *   {"type":"error",      "content":"…"}
 */

import { useState, useCallback, useRef, useEffect } from "react";
import type { ToolEvent } from "@/components/MarkdownMessage";

export type { ToolEvent };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /** True while the assistant is still streaming tokens. */
  streaming?: boolean;
  /** Tool-call events that happened while producing this message. */
  toolEvents?: ToolEvent[];
}

interface UseAgentChatOptions {
  agentName: string;
  threadId: string;
  initialMessages?: ChatMessage[];
  /** Copilot SDK model override — e.g. "claude-sonnet-4.5", "gpt-5.5", "auto". */
  model?: string;
  /** Routing mode: "copilot" (GitHub Copilot SDK) or "litellm" (LiteLLM proxy). */
  mode?: "copilot" | "litellm";
  /** System-level context (persistent memory / persona) injected server-side. */
  systemContext?: string;
}

interface UseAgentChatReturn {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
  stopGeneration: () => void;
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
}: UseAgentChatOptions): UseAgentChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ref so sendMessage closure always sees latest messages for history
  const messagesRef = useRef<ChatMessage[]>(initialMessages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // Ref to the active AbortController — set on each send, cleared on finish
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isLoading) return;

      const controller = new AbortController();
      abortRef.current = controller;

      const userMsg: ChatMessage = {
        id: nanoid(),
        role: "user",
        content: content.trim(),
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setError(null);

      // Create a placeholder streaming message we'll update token-by-token.
      const assistantId = nanoid();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        streaming: true,
        toolEvents: [],
      };
      setMessages((prev) => [...prev, assistantMsg]);

      try {
        const res = await fetch("/api/agent/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            agentName,
            message: userMsg.content,
            messages: [...messagesRef.current].map((m) => ({
              role: m.role,
              content: m.content,
            })),
            threadId,
            mode,
            // Always send the model field: "auto" means let the SDK pick;
            // any other value (e.g. "claude-sonnet-4.5") pins a specific model.
            model: model ?? "auto",
            // Persistent memory / persona injected as system-level context.
            context: systemContext ?? undefined,
          }),
        });

        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => `status ${res.status}`);
          throw new Error(text);
        }

        // ── Parse SSE stream ─────────────────────────────────────────────
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

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
            try {
              evt = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              continue;
            }

            switch (evt.type) {
              case "delta":
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: m.content + String(evt.content ?? "") }
                      : m
                  )
                );
                break;

              case "tool_start":
                setMessages((prev) =>
                  prev.map((m) => {
                    if (m.id !== assistantId) return m;
                    const newEvent: ToolEvent = {
                      id: String(evt.id ?? nanoid()),
                      name: String(evt.name ?? "tool"),
                      args: (evt.args as Record<string, unknown>) ?? {},
                      status: "running",
                      startedAt: Date.now(),
                    };
                    return { ...m, toolEvents: [...(m.toolEvents ?? []), newEvent] };
                  })
                );
                break;

              case "tool_end":
                setMessages((prev) =>
                  prev.map((m) => {
                    if (m.id !== assistantId) return m;
                    return {
                      ...m,
                      toolEvents: (m.toolEvents ?? []).map((t) =>
                        t.id === String(evt.id)
                          ? {
                              ...t,
                              result: String(evt.result ?? ""),
                              status: evt.success ? "done" : "error",
                              endedAt: Date.now(),
                            }
                          : t
                      ),
                    };
                  })
                );
                break;

              case "done":
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, streaming: false } : m
                  )
                );
                break;

              case "error":
                throw new Error(String(evt.content ?? "Stream error"));
            }
          }
        }

        // Ensure streaming flag is cleared even if "done" event was missing
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, streaming: false } : m
          )
        );
      } catch (err) {
        // User-initiated stop — don't show an error, just freeze the partial response.
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        if (isAbort) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, streaming: false } : m
            )
          );
          return;
        }

        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);

        // Replace the streaming placeholder with an error system message
        setMessages((prev) =>
          prev
            .filter((m) => m.id !== assistantId)
            .concat({
              id: nanoid(),
              role: "system",
              content: `Error: ${msg}`,
              timestamp: Date.now(),
            })
        );
      } finally {
        abortRef.current = null;
        setIsLoading(false);
      }
    },
    [agentName, threadId, isLoading, model, mode, systemContext]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, isLoading, error, sendMessage, clearMessages, stopGeneration };
}
