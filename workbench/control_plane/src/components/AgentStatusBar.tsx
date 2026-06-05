"use client";

/**
 * AgentStatusBar — compact identity/context strip shown above the chat thread.
 *
 * Mirrors the orientation cues from VS Code Copilot (which agent is active,
 * what it can reach). Shows the active agent name, a live/idle indicator, and
 * a row of integration dots (green = configured, red = missing).
 */

import type { IntegrationStatus } from "@/app/api/integrations/status/route";

interface AgentStatusBarProps {
  agentName: string;
  integrations: IntegrationStatus[];
  isActive: boolean;
}

export default function AgentStatusBar({
  agentName,
  integrations,
  isActive,
}: AgentStatusBarProps) {
  // Show mandatory integrations first, then the rest; cap to keep the bar tidy.
  const sorted = [...integrations].sort(
    (a, b) => Number(b.mandatory) - Number(a.mandatory)
  );
  const shown = sorted.slice(0, 6);
  const overflow = sorted.length - shown.length;

  return (
    <div className="shrink-0 flex items-center gap-3 px-5 py-1.5 border-b border-zinc-800 bg-zinc-900/40 text-xs">
      {/* Active agent */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            isActive ? "bg-sky-400 chat-pulse-dot" : "bg-emerald-500"
          }`}
        />
        <span className="text-zinc-300 font-medium">{agentName}</span>
        <span className="text-zinc-600">{isActive ? "working" : "ready"}</span>
      </div>

      {/* Integration dots */}
      {shown.length > 0 && (
        <>
          <div className="w-px h-3 bg-zinc-800" />
          <div className="flex items-center gap-2 min-w-0 overflow-hidden">
            {shown.map((s) => (
              <span
                key={s.service}
                className="flex items-center gap-1 shrink-0"
                title={`${s.label ?? s.service} — ${
                  s.configured ? "connected" : "not configured"
                }${s.mandatory ? " (required)" : ""}`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    s.configured ? "bg-emerald-500" : "bg-red-500"
                  }`}
                />
                <span className="text-zinc-500 truncate max-w-[100px]">
                  {s.label ?? s.service}
                </span>
              </span>
            ))}
            {overflow > 0 && (
              <span className="text-zinc-600 shrink-0">+{overflow}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
