"use client";

/**
 * MessageActionBar — per-message actions shown under each message bubble.
 *
 * Copy is always visible. Edit (user) and thumbs (assistant) are always
 * visible on mobile, hover-revealed on desktop.
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
      console.debug("[feedback]", { messageId, vote: next });
    }
  };

  const btn =
    "text-zinc-500 hover:text-zinc-200 transition-colors px-1.5 py-0.5 rounded hover:bg-zinc-700/50 text-[11px]";

  return (
    <div className="mt-2 flex items-center gap-1 text-[11px]">
      {/* Copy — always visible, clear text label */}
      <button onClick={copy} className={btn} title="Copy" aria-label="Copy message">
        {copied ? "✓ Copied" : "Copy"}
      </button>

      {/* Edit — always visible on mobile, hover on desktop */}
      {role === "user" && onEdit && (
        <button
          onClick={onEdit}
          className={`${btn} sm:opacity-0 sm:group-hover:opacity-100`}
          title="Edit"
          aria-label="Edit message"
        >
          Edit
        </button>
      )}

      {/* Thumbs — always visible on mobile, hover on desktop */}
      {role === "assistant" && (
        <span className="sm:opacity-0 sm:group-hover:opacity-100 inline-flex items-center gap-1">
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
        </span>
      )}
    </div>
  );
}
