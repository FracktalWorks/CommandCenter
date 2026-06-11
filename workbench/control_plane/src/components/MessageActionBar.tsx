"use client";

/**
 * MessageActionBar — per-message actions shown under each message bubble.
 *
 * Mirrors GitHub Copilot Chat's hover actions: copy, edit (user only),
 * thumbs up/down feedback (assistant only). Always visible on mobile;
 * hover-revealed on desktop.
 */

import { useState } from "react";

interface MessageActionBarProps {
  content: string;
  messageId: string;
  role: "user" | "assistant";
  onEdit?: () => void;
}

export default function MessageActionBar({
  content,
  messageId,
  role,
  onEdit,
}: MessageActionBarProps) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);

  const copy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const sendVote = (v: "up" | "down") => {
    const next = vote === v ? null : v;
    setVote(next);
    if (next) {
      // Placeholder: wire to POST /api/audit when the endpoint exists.
      console.debug("[feedback]", { messageId, vote: next });
    }
  };

  const btn =
    "text-zinc-500 hover:text-zinc-200 transition-colors px-1.5 py-0.5 rounded hover:bg-zinc-700/50 text-[11px]";

  return (
    <div className="mt-2 flex items-center gap-0.5 text-xs opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
      {/* Copy — always available on all messages */}
      <button onClick={copy} className={btn} title="Copy" aria-label="Copy message">
        {copied ? "✓ Copied" : "📋"}
      </button>

      {/* Edit — only for user messages */}
      {role === "user" && onEdit && (
        <button onClick={onEdit} className={btn} title="Edit" aria-label="Edit message">
          ✏️
        </button>
      )}

      {/* Thumbs — only for assistant messages */}
      {role === "assistant" && (
        <>
          <button
            onClick={() => sendVote("up")}
            className={`${btn} ${vote === "up" ? "text-emerald-400" : ""}`}
            title="Good response"
            aria-label="Good response"
          >
            👍
          </button>
          <button
            onClick={() => sendVote("down")}
            className={`${btn} ${vote === "down" ? "text-red-400" : ""}`}
            title="Bad response"
            aria-label="Bad response"
          >
            👎
          </button>
        </>
      )}
    </div>
  );
}
