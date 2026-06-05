"use client";

/**
 * ThinkingContainer — VS Code Copilot-style "working" group.
 *
 * Replaces the per-tool accordion. Groups the entire working phase of one
 * assistant turn into a single collapsible container:
 *
 *   • While active:  shimmer title "Thinking…" → "Working: <tool label>",
 *                    a pulsing filled-circle indicator, and (when expanded)
 *                    a list of tool rows with rotating working messages.
 *   • On complete:   green ✓, a past-tense summary title, auto-collapse.
 *
 * Patterns copied from VS Code's chatThinkingContentPart.ts — see
 * ai-company-brain/spec_chat_ux.md for the full study.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolEvent } from "@/components/MarkdownMessage";

interface ThinkingContainerProps {
  toolEvents: ToolEvent[];
  /** Live tool-name lines emitted before each tool result (progress events). */
  progressLines: string[];
  /** True while the agent run is in progress. */
  isActive: boolean;
}

// ─── Tool icon mapping (mirrors VS Code getToolInvocationIcon) ───────────────

function getToolIcon(toolName: string): string {
  const n = toolName.toLowerCase();
  if (/search|grep|find|list|semantic|codebase|query|retrieve|lookup/.test(n)) return "🔍";
  if (/read|get_file|problems|fetch|load/.test(n)) return "📖";
  if (/edit|create|write|replace|patch|insert|update|append/.test(n)) return "✏️";
  if (/terminal|bash|shell|exec|run|command/.test(n)) return "▸";
  if (/mail|email|send|message|draft|notify/.test(n)) return "✉️";
  if (/delegate|spawn|agent/.test(n)) return "🤝";
  return "⚙️";
}

function formatToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Rotating working messages (mirrors VS Code's working-message pool) ──────

const WORKING_MESSAGES = [
  "Working on it",
  "Thinking it through",
  "Processing",
  "Crunching the details",
  "Pulling the data",
  "Putting it together",
];

const FUN_MESSAGES = [
  "Bribing the hamster",
  "Reticulating splines",
  "Untangling the spaghetti",
  "Summoning Clippy",
  "Mining diamonds",
];

function pickWorkingMessage(): string {
  // ~1-in-12 chance of an easter-egg message (VS Code uses 1-in-100).
  if (Math.floor(Math.random() * 12) === 0) {
    return FUN_MESSAGES[Math.floor(Math.random() * FUN_MESSAGES.length)];
  }
  return WORKING_MESSAGES[Math.floor(Math.random() * WORKING_MESSAGES.length)];
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ThinkingContainer({
  toolEvents,
  progressLines,
  isActive,
}: ThinkingContainerProps) {
  const [expanded, setExpanded] = useState(false);
  const [workingMsg, setWorkingMsg] = useState<string>(() => pickWorkingMessage());
  const userToggledRef = useRef(false);

  // Rotate the working message every few seconds while active.
  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => setWorkingMsg(pickWorkingMessage()), 3000);
    return () => clearInterval(t);
  }, [isActive]);

  // Auto-collapse shortly after completion (unless the user manually expanded).
  useEffect(() => {
    if (isActive) return;
    if (userToggledRef.current) return;
    const t = setTimeout(() => setExpanded(false), 300);
    return () => clearTimeout(t);
  }, [isActive]);

  // Derive the current/last tool label for the title.
  const lastLabel = useMemo(() => {
    if (toolEvents.length > 0) {
      return formatToolName(toolEvents[toolEvents.length - 1].name);
    }
    if (progressLines.length > 0) {
      return formatToolName(progressLines[progressLines.length - 1]);
    }
    return null;
  }, [toolEvents, progressLines]);

  // Final summary title once complete.
  const summaryTitle = useMemo(() => {
    if (toolEvents.length === 0) return "Finished thinking";
    if (toolEvents.length === 1) {
      return `Used ${formatToolName(toolEvents[0].name)}`;
    }
    const names = Array.from(new Set(toolEvents.map((t) => formatToolName(t.name))));
    if (names.length === 1) return `Used ${names[0]} ×${toolEvents.length}`;
    return `Used ${toolEvents.length} tools`;
  }, [toolEvents]);

  const hasError = toolEvents.some((t) => t.status === "error");
  const hasContent = toolEvents.length > 0;

  // Title shown in the header.
  const title = isActive
    ? lastLabel
      ? `Working: ${lastLabel}`
      : "Thinking…"
    : summaryTitle;

  const totalMs = useMemo(() => {
    if (isActive || toolEvents.length === 0) return null;
    let earliest = Infinity;
    let latest = 0;
    for (const t of toolEvents) {
      if (t.startedAt < earliest) earliest = t.startedAt;
      if (t.endedAt && t.endedAt > latest) latest = t.endedAt;
    }
    if (!isFinite(earliest) || latest === 0) return null;
    return latest - earliest;
  }, [isActive, toolEvents]);

  return (
    <div className="my-2 rounded-lg border border-zinc-700/40 bg-zinc-900/40 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => {
          userToggledRef.current = true;
          setExpanded((o) => !o);
        }}
        disabled={!hasContent}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-zinc-800/40 transition-colors disabled:cursor-default"
      >
        {/* Status indicator */}
        <span className="shrink-0 flex items-center justify-center w-4">
          {isActive ? (
            <span
              className={`w-2 h-2 rounded-full chat-pulse-dot ${
                hasError ? "bg-red-400" : "bg-sky-400"
              }`}
            />
          ) : hasError ? (
            <span className="text-red-400 text-xs">✗</span>
          ) : (
            <span className="text-emerald-500 text-xs">✓</span>
          )}
        </span>

        {/* Title — shimmer while active */}
        <span
          className={`text-xs font-medium min-w-0 truncate ${
            isActive ? "chat-shimmer-text" : "text-zinc-400"
          }`}
        >
          {title}
        </span>

        {totalMs !== null && (
          <span className="shrink-0 text-[10px] text-zinc-600 font-mono">
            {totalMs}ms
          </span>
        )}

        {/* Chevron */}
        {hasContent && (
          <span className="ml-auto shrink-0 text-zinc-600 text-[10px]">
            {expanded ? "▲" : "▼"}
          </span>
        )}
      </button>

      {/* Body — tool rows */}
      {expanded && hasContent && (
        <div className="border-t border-zinc-700/40 px-2 py-2 space-y-1 chat-fade-in">
          {toolEvents.map((e) => (
            <ToolRow key={e.id} event={e} />
          ))}

          {/* Live working spinner row while active */}
          {isActive && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-zinc-500">
              <span className="w-2 h-2 rounded-full bg-sky-400 chat-pulse-dot shrink-0" />
              <span className="italic">{workingMsg}…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Single tool row ─────────────────────────────────────────────────────────

function ToolRow({ event }: { event: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const durationMs =
    event.endedAt && event.startedAt ? event.endedAt - event.startedAt : null;

  const statusIcon =
    event.status === "running" ? (
      <span className="w-2.5 h-2.5 rounded-full border-2 border-zinc-600 border-t-sky-400 animate-spin inline-block" />
    ) : event.status === "done" ? (
      <span className="text-emerald-500 text-[11px]">✓</span>
    ) : (
      <span className="text-red-400 text-[11px]">✗</span>
    );

  const hasDetails =
    (event.args && Object.keys(event.args).length > 0) || !!event.result;

  return (
    <div className="rounded-md bg-zinc-900/60 overflow-hidden">
      <button
        onClick={() => hasDetails && setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-zinc-800/50 transition-colors text-[11px]"
      >
        <span className="shrink-0 w-4 flex items-center justify-center">
          {statusIcon}
        </span>
        <span className="shrink-0">{getToolIcon(event.name)}</span>
        <span className="text-zinc-300 font-medium shrink-0">
          {formatToolName(event.name)}
        </span>
        {event.args && Object.keys(event.args).length > 0 && (
          <span className="text-zinc-500 truncate min-w-0">
            {formatArgs(event.args)}
          </span>
        )}
        {durationMs !== null && (
          <span className="ml-auto shrink-0 text-zinc-600 font-mono">
            {durationMs}ms
          </span>
        )}
        {hasDetails && (
          <span className="shrink-0 text-zinc-600 text-[9px] ml-1">
            {open ? "▲" : "▼"}
          </span>
        )}
      </button>

      {open && hasDetails && (
        <div className="border-t border-zinc-800 px-3 py-2 space-y-2 chat-fade-in">
          {event.args && Object.keys(event.args).length > 0 && (
            <div>
              <div className="text-[9px] text-zinc-600 uppercase tracking-widest mb-1 font-medium">
                Input
              </div>
              <pre className="text-zinc-400 whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed">
                {JSON.stringify(event.args, null, 2)}
              </pre>
            </div>
          )}
          {event.result && (
            <div>
              <div className="text-[9px] text-zinc-600 uppercase tracking-widest mb-1 font-medium">
                Output
              </div>
              <pre className="text-zinc-400 whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed max-h-48 overflow-y-auto">
                {event.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const first = args[keys[0]];
  const val = typeof first === "string" ? first : JSON.stringify(first);
  return val.length > 60 ? val.slice(0, 60) + "…" : val;
}
