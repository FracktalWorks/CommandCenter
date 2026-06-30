"use client";

import { Sparkles, Send } from "lucide-react";
import { QUICK_ACTIONS } from "../lib/mockData";

// Far-right AI assistant rail. The frame + quick actions land now; live
// streaming chat (reusing the email app's useAgentChat pattern) is wired in a
// later slice (F9).
export function AssistantRail() {
  return (
    <div className="flex h-full flex-col bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Sparkles className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Assistant</h2>
        <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase text-muted-foreground">
          soon
        </span>
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-xs text-muted-foreground">
          Your GTD coach. It clarifies the inbox, suggests the next action, runs
          the weekly review, and tracks what you&apos;re waiting on.
        </p>
        <div className="flex flex-col gap-1.5">
          {QUICK_ACTIONS.map((qa) => (
            <button
              key={qa.label}
              type="button"
              disabled
              className="tech-transition cursor-default rounded-lg border border-border bg-background/40 px-3 py-2 text-left text-[13px] text-muted-foreground"
              title="Wired in a later slice"
            >
              {qa.label}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2">
          <input
            disabled
            placeholder="Ask the assistant…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <Send className="h-4 w-4 text-muted-foreground/50" />
        </div>
      </div>
    </div>
  );
}
