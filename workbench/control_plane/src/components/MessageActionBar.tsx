"use client";

/**
 * MessageActionBar — per-message actions shown inline with the timestamp
 * underneath each message bubble. Visibility is controlled by the parent
 * (hover-revealed on desktop).
 *
 * Copy | Edit (user only) | 👍 👎 (assistant only)
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
    "text-muted-foreground hover:text-foreground tech-transition px-1 py-0.5 rounded hover:bg-secondary text-[10px]";

  return (
    <>
      {/* Copy — always visible */}
      <button onClick={copy} className={btn} title="Copy" aria-label="Copy message">
        {copied ? "✓ Copied" : "Copy"}
      </button>

      {/* Edit — always visible (user messages only) */}
      {role === "user" && onEdit && (
        <button
          onClick={onEdit}
          className={btn}
          title="Edit"
          aria-label="Edit message"
        >
          Edit
        </button>
      )}

      {/* Thumbs — always visible (assistant messages only) */}
      {role === "assistant" && (
        <>
          <button
            onClick={() => sendVote("up")}
            className={`${btn} ${vote === "up" ? "text-success" : ""}`}
            title="Good response"
            aria-label="Good response"
          >
            👍
          </button>
          <button
            onClick={() => sendVote("down")}
            className={`${btn} ${vote === "down" ? "text-destructive" : ""}`}
            title="Bad response"
            aria-label="Bad response"
          >
            👎
          </button>
        </>
      )}
    </>
  );
}
