"use client";

/**
 * MessageActionBar — per-message actions shown under each assistant reply.
 *
 * Mirrors GitHub Copilot Chat's hover actions: thumbs up/down feedback and a
 * copy button. Feedback is local-only for now (logged to console); wire to an
 * audit endpoint when available.
 */

import { useState } from "react";

interface MessageActionBarProps {
  content: string;
  messageId: string;
}

export default function MessageActionBar({
  content,
  messageId,
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
    "text-zinc-600 hover:text-zinc-300 transition-colors px-1.5 py-0.5 rounded hover:bg-zinc-700/40";

  return (
    <div className="mt-2 flex items-center gap-1 text-xs opacity-0 group-hover:opacity-100 transition-opacity">
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
      <button onClick={copy} className={btn} title="Copy" aria-label="Copy message">
        {copied ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );
}
