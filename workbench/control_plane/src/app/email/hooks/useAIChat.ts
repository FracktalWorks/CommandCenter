"use client";

import { useCallback, useRef, useState } from "react";
import { ChatMessage } from "../lib/types";
import { streamAIChat, triggerQuickAction } from "../lib/api";

/**
 * Hook for AI-powered email chat (SSE streaming + quick actions).
 *
 * Manages message list, streaming state, and typed send/quick-action handlers.
 * Designed for use inside the AIChatPanel component.
 */
export function useAIChat(
  initialMessages: ChatMessage[],
  options?: { accountId?: string | null; emailId?: string | null }
) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isStreaming) return;

      const userMsg: ChatMessage = {
        id: Date.now().toString(),
        role: "user",
        content: text.trim(),
        timestamp: new Date(),
      };
      const updatedMessages = [...messages, userMsg];
      setMessages(updatedMessages);
      setIsStreaming(true);
      setStreamingContent("");

      const apiMessages = updatedMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      try {
        await streamAIChat(
          {
            messages: apiMessages,
            accountId: options?.accountId ?? undefined,
            emailContextId: options?.emailId ?? undefined,
          },
          (event) => {
            if (event.type === "content" && event.content) {
              setStreamingContent((prev) => prev + event.content);
            } else if (event.type === "done") {
              setStreamingContent((prev) => {
                if (prev) {
                  const assistantMsg: ChatMessage = {
                    id: (Date.now() + 1).toString(),
                    role: "assistant",
                    content: prev,
                    timestamp: new Date(),
                  };
                  setMessages((msgs) => [...msgs, assistantMsg]);
                }
                return "";
              });
              setIsStreaming(false);
            } else if (event.type === "error") {
              setMessages((msgs) => [
                ...msgs,
                {
                  id: (Date.now() + 1).toString(),
                  role: "assistant",
                  content: "Sorry, I ran into an error. Please try again.",
                  timestamp: new Date(),
                },
              ]);
              setIsStreaming(false);
              setStreamingContent("");
            }
          }
        );
      } catch {
        setMessages((msgs) => [
          ...msgs,
          {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: "Sorry, I couldn't reach the assistant. Please try again.",
            timestamp: new Date(),
          },
        ]);
        setIsStreaming(false);
        setStreamingContent("");
      }
    },
    [messages, isStreaming, options?.accountId, options?.emailId]
  );

  const runQuickAction = useCallback(
    async (label: string, actionKey: string) => {
      if (isStreaming) return;

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "user",
          content: label,
          timestamp: new Date(),
        },
      ]);
      setIsStreaming(true);

      try {
        const result = await triggerQuickAction(
          actionKey,
          options?.accountId ?? undefined,
          options?.emailId ?? undefined
        );
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: result.result || "Done!",
            timestamp: new Date(),
          },
        ]);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: "Sorry, the quick action failed. Please try again.",
            timestamp: new Date(),
          },
        ]);
      }
      setIsStreaming(false);
    },
    [isStreaming, options?.accountId, options?.emailId]
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages(initialMessages);
    setIsStreaming(false);
    setStreamingContent("");
  }, [initialMessages]);

  return {
    messages,
    isStreaming,
    streamingContent,
    sendMessage,
    runQuickAction,
    reset,
  };
}
