"use client";

/**
 * ThinkingContainer — VS Code Copilot Chat-style "working" group.
 *
 * Groups the entire working phase of one assistant turn into a single
 * collapsible container with a vertical timeline connecting each step.
 *
 * Visual design mirrors VS Code's chatThinkingContentPart:
 *   • Vertical connecting line with colored dots per step
 *   • Action badges (Read, Edit, Search, Run, etc.)
 *   • Color-coded left borders for different action types
 *   • Timing info, diff-style change badges
 *   • Auto-expand during active streaming, auto-collapse on completion
 *
 * Patterns sourced from VS Code Copilot Chat UI study —
 * see ai-company-brain/spec_chat_ux.md.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolEvent } from "@/components/MarkdownMessage";

interface ThinkingContainerProps {
  toolEvents: ToolEvent[];
  progressLines: string[];
  /** Sequential reasoning blocks — each rendered as its own timeline entry. */
  reasoningBlocks?: string[];
  isActive: boolean;
}

// ─── Tool classification ────────────────────────────────────────────────────

type ActionKind = "read" | "edit" | "search" | "run" | "delegate" | "other";

function classifyTool(name: string): {
  kind: ActionKind; icon: string; label: string;
  borderClass: string; dotClass: string;
} {
  const n = name.toLowerCase();
  if (/search|grep|find|list|semantic|codebase|query|retrieve|lookup/.test(n))
    return { kind: "search", icon: "🔍", label: "Search", borderClass: "border-amber-700/50", dotClass: "bg-amber-400" };
  if (/read|get_file|problems|fetch|load|open|view|analyzing|generating/.test(n))
    return { kind: "read", icon: "📖", label: "Read", borderClass: "border-sky-700/50", dotClass: "bg-sky-400" };
  if (/edit|create|write|replace|patch|insert|update|append|fix/.test(n))
    return { kind: "edit", icon: "✏️", label: "Edit", borderClass: "border-emerald-700/50", dotClass: "bg-emerald-400" };
  if (/terminal|bash|shell|exec|run|command/.test(n))
    return { kind: "run", icon: "▸", label: "Run", borderClass: "border-violet-700/50", dotClass: "bg-violet-400" };
  if (/delegate|spawn|agent|call_agent/.test(n))
    return { kind: "delegate", icon: "🤝", label: "Delegate", borderClass: "border-rose-700/50", dotClass: "bg-rose-400" };
  return { kind: "other", icon: "⚙️", label: "Tool", borderClass: "border-zinc-700/50", dotClass: "bg-zinc-500" };
}

function formatToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatArgsLikePath(args: Record<string, unknown>): string | null {
  const path = args.path ?? args.filePath ?? args.file ?? args.file_path
    ?? args.target ?? args.destination ?? args.url ?? args.repo;
  if (typeof path === "string" && path.length > 0) {
    const parts = path.includes("/") ? path.split("/") : path.split("\\");
    const short = parts.slice(-2).join("/");
    return short.length < path.length ? `…/${short}` : short;
  }
  return null;
}

/** Pull a displayable command string from tool arguments. */
function extractCommand(args: Record<string, unknown>, toolName: string): string {
  // Direct command field (bash/shell tools)
  const cmd = args.command ?? args.cmd ?? args.fullCommandText
    ?? args.full_command_text ?? args.script ?? args.code;
  if (typeof cmd === "string" && cmd.length > 0) return cmd;
  // Reconstruct from argv-style array
  const argv = args.argv ?? args.args ?? args.arguments;
  if (Array.isArray(argv) && argv.length > 0) return argv.join(" ");
  // Last resort: show the first arg value
  const firstVal = Object.values(args).find((v) => typeof v === "string" && v.length > 0);
  if (firstVal) return String(firstVal).slice(0, 120);
  return formatToolName(toolName);
}

// ─── Shell syntax highlighting (VS Code terminal colours) ──────────────────

const POWERSHELL_KEYWORDS = new Set([
  "Select-Object", "Where-Object", "ForEach-Object", "Sort-Object",
  "Group-Object", "Measure-Object", "Write-Host", "Write-Output",
  "Get-ChildItem", "Get-Content", "Set-Content", "Invoke-WebRequest",
  "ConvertFrom-Json", "ConvertTo-Json", "ForEach-Object",
  "Start-Process", "Stop-Process", "Get-Process",
  "Test-Path", "New-Item", "Remove-Item",
  "Copy-Item", "Move-Item", "Rename-Item",
]);

/** Tokenize a shell command into syntax-highlighted spans. */
function highlightCommand(cmd: string): React.ReactNode[] {
  const parts = cmd.split(/(\||&&|\|\||;|>>|>|<|2>&1)/g);
  return parts.map((part, i) => {
    if (/^(\||&&|\|\||;|>>|>|<|2>&1)$/.test(part.trim())) {
      return <span key={i} className="text-zinc-500 mx-0.5">{part}</span>;
    }
    return <span key={i}>{tokenizeSegment(part, i === 0)}</span>;
  });
}

function tokenizeSegment(segment: string, isFirst: boolean): React.ReactNode[] {
  const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [segment];
  return tokens.map((token, j) => {
    const first = isFirst && j === 0;
    if (/^["'].*["']$/.test(token))
      return <span key={j} className="text-orange-300">{token} </span>;
    if (/^--?[a-zA-Z]/.test(token))
      return <span key={j} className="text-cyan-300">{token} </span>;
    if (/[\/\\]/.test(token) && !/^[0-9]+$/.test(token))
      return <span key={j} className="text-emerald-300">{token} </span>;
    if (/^[0-9]+(\.[0-9]+)?$/.test(token))
      return <span key={j} className="text-yellow-200">{token} </span>;
    if (first)
      return <span key={j} className="text-amber-300 font-medium">{token} </span>;
    if (POWERSHELL_KEYWORDS.has(token))
      return <span key={j} className="text-sky-300">{token} </span>;
    return <span key={j} className="text-zinc-200">{token} </span>;
  });
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
  reasoningBlocks,
  isActive,
}: ThinkingContainerProps) {
  const [expanded, setExpanded] = useState(false);
  const [workingMsg, setWorkingMsg] = useState<string>(() => pickWorkingMessage());
  const userToggledRef = useRef(false);

  const hasReasoning = !!(reasoningBlocks && reasoningBlocks.length > 0);
  const hasTools = toolEvents.length > 0;
  const hasContent = hasTools || hasReasoning;

  // Auto-expand while the agent is actively working so the user sees the
  // thought process in real time (VS Code Copilot Chat style). Expands on:
  // - First tool call or reasoning delta (content appears)
  // - Active streaming with content (user sees live progress)
  // Collapses after completion unless the user manually toggled.
  useEffect(() => {
    if (hasContent && isActive && !userToggledRef.current) {
      setExpanded(true);
    }
  }, [hasContent, isActive]);

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
    if (toolEvents.length === 0) {
      return hasReasoning ? "Has working notes" : "Finished thinking";
    }
    if (toolEvents.length === 1) {
      return `Used ${formatToolName(toolEvents[0].name)}`;
    }
    const names = Array.from(new Set(toolEvents.map((t) => formatToolName(t.name))));
    if (names.length === 1) return `Used ${names[0]} ×${toolEvents.length}`;
    return `Used ${toolEvents.length} tools`;
  }, [toolEvents, hasReasoning]);

  const hasError = toolEvents.some((t) => t.status === "error");

  // Live tail of the model's chain-of-thought — shown in the header while
  // active so the user sees the "stream of consciousness" even collapsed
  // (mirrors VS Code Copilot's live thinking snippet).
  const liveReasoningTail = useMemo(() => {
    if (!isActive || !hasReasoning) return null;
    const last = reasoningBlocks![reasoningBlocks!.length - 1].trim();
    if (!last) return null;
    return last.length > 90 ? `…${last.slice(-90)}` : last;
  }, [isActive, hasReasoning, reasoningBlocks]);

  // Title shown in the header.  A currently-running tool takes priority;
  // otherwise show the live reasoning tail, then the last known label.
  const hasRunningTool = toolEvents.some((t) => t.status === "running");
  const title = isActive
    ? (hasRunningTool && lastLabel ? `Working: ${lastLabel}` : null)
      ?? liveReasoningTail
      ?? (lastLabel ? `Working: ${lastLabel}` : "Thinking…")
    : summaryTitle;

  const totalMs = useMemo(() => {
    if (isActive || toolEvents.length === 0) return null;
    let earliest = Infinity;
    let latest = 0;
    for (const t of toolEvents) {
      if (t.startedAt !== undefined && t.startedAt < earliest) earliest = t.startedAt;
      if (t.endedAt && t.endedAt > latest) latest = t.endedAt;
    }
    if (!isFinite(earliest) || latest === 0) return null;
    return latest - earliest;
  }, [isActive, toolEvents]);

  return (
    <div className="my-2 rounded-lg border border-zinc-700/40 bg-zinc-900/30 overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <button
        onClick={() => { userToggledRef.current = true; setExpanded((o) => !o); }}
        disabled={!hasContent}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-zinc-800/40 transition-colors disabled:cursor-default"
      >
        <span className="shrink-0 flex items-center justify-center w-4">
          {isActive ? (
            <span className={`w-2 h-2 rounded-full chat-pulse-dot ${hasError ? "bg-red-400" : "bg-sky-400"}`} />
          ) : hasError ? (
            <span className="text-red-400 text-[10px]">✗</span>
          ) : (
            <span className="text-emerald-500 text-[10px]">✓</span>
          )}
        </span>
        <span className={`text-xs font-medium min-w-0 truncate ${isActive ? "chat-shimmer-text" : "text-zinc-400"}`}>
          {title}
        </span>
        {totalMs !== null && (
          <span className="shrink-0 text-[10px] text-zinc-600 font-mono">{totalMs}ms</span>
        )}
        {/* Action kind badges in header */}
        {!isActive && toolEvents.length > 0 && (
          <span className="shrink-0 flex items-center gap-1 ml-1">
            {Array.from(new Set(toolEvents.map((t) => classifyTool(t.name).kind))).map((k) => (
              <span key={k} className="text-[9px] px-1 py-0.5 rounded border border-zinc-700 text-zinc-500 font-mono uppercase">{k}</span>
            ))}
          </span>
        )}
        {hasContent && <span className="ml-auto shrink-0 text-zinc-600 text-[10px]">{expanded ? "▲" : "▼"}</span>}
      </button>

      {/* ── Body: vertical timeline ────────────────────────────────── */}
      {expanded && hasContent && (
        <div className="border-t border-zinc-700/40 chat-fade-in">
          {/* Container with NO left padding — all items position relative to this.
              Content is indented via ml-8.  Line and dots share the same x=12px axis. */}
          <div className="relative py-2.5">
            {/* Vertical line at x=12px */}
            <div className="absolute left-[12px] top-2 bottom-2 w-px bg-zinc-700/60" />

            <div className="space-y-2">
              {/* Sequential reasoning blocks — each is its own timeline entry */}
              {hasReasoning && reasoningBlocks!.map((block, bi) => {
                const isLastBlock = bi === reasoningBlocks!.length - 1;
                return (
                  <div key={bi} className="relative">
                    <div className="absolute left-[8px] top-[10px] z-10">
                      <span className={`block w-2 h-2 rounded-full ${isActive && isLastBlock ? "bg-violet-400 chat-pulse-dot" : "bg-violet-500"}`} />
                    </div>
                    <div className="ml-8 mr-3 rounded-md border-l-2 border-violet-700/30 bg-zinc-900/20 px-2.5 py-2">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[10px] opacity-60">💭</span>
                        <span className="text-[9px] font-medium text-zinc-500 uppercase tracking-widest">Working notes</span>
                        {isActive && isLastBlock && <span className="w-1.5 h-1.5 rounded-full bg-violet-400/60 chat-pulse-dot shrink-0" />}
                      </div>
                      <div className="text-[11px] text-zinc-500/80 whitespace-pre-wrap leading-relaxed italic">
                        {block}
                        {isActive && isLastBlock && <span className="inline-block w-[2px] h-[1em] bg-zinc-600 animate-pulse ml-0.5 align-middle rounded-full" />}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Tool steps as timeline items */}
              {toolEvents.map((event, i) => {
                const style = classifyTool(event.name);
                const isRunning = event.status === "running";
                const isLast = i === toolEvents.length - 1;
                const hasPath = event.args ? formatArgsLikePath(event.args) : null;
                const dur = event.endedAt && event.startedAt ? event.endedAt - event.startedAt : undefined;
                return (
                  <div key={event.id} className="relative">
                    {/* Dot centered on line at x=12px: w-2(8px) → left=12-4=8px */}
                    <div className="absolute left-[8px] top-[10px] z-10">
                      {isRunning ? (
                        <span className={`block w-2.5 h-2.5 rounded-full ${style.dotClass} chat-pulse-dot`} />
                      ) : event.status === "error" ? (
                        <span className="block w-2 h-2 rounded-full bg-red-500" />
                      ) : (
                        <span className={`block w-2 h-2 rounded-full ${style.dotClass}`} />
                      )}
                    </div>

                    {/* Step card — indented to clear the line + dot */}
                    <div className={`ml-8 mr-3 rounded-md border-l-2 ${style.borderClass} bg-zinc-900/40 px-2.5 py-1.5`}>
                      {/* Header row */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] shrink-0">{style.icon}</span>
                        <span className="text-[10px] font-semibold text-zinc-300 uppercase tracking-wide">{style.label}</span>
                        <span className="text-[10px] text-zinc-500 font-mono truncate">{formatToolName(event.name)}</span>
                        {hasPath && <span className="text-[10px] text-zinc-600 font-mono truncate ml-auto">{hasPath}</span>}
                        {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-sky-400 chat-pulse-dot shrink-0 ml-1" />}
                        {dur !== undefined && <span className="text-[9px] text-zinc-600 font-mono ml-auto shrink-0">{dur}ms</span>}
                      </div>

                      {/* Args + result */}
                      {event.args && Object.keys(event.args).length > 0 && (
                        <div className="text-[10px] text-zinc-600 font-mono mt-1">
                          {Object.entries(event.args).map(([k, v]) => (
                            <span key={k} className="inline-block mr-2">
                              <span className="text-zinc-500">{k}:</span>{" "}
                              <span className="text-zinc-400">{String(v).slice(0, 80)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {/* Terminal / shell output — VS Code-style terminal in chat */}
                      {style.kind === "run" && (event.args || event.result) ? (
                        <div className="mt-1.5 rounded-md bg-[#0c0c0c] border border-zinc-700/60 overflow-hidden">
                          {/* Title bar */}
                          <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-zinc-800 bg-zinc-900/80">
                            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56] shrink-0" />
                            <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e] shrink-0" />
                            <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f] shrink-0" />
                            <span className="text-[10px] text-zinc-500 ml-2 font-mono tracking-wide">
                              {event.args?.command
                                ? "PowerShell"
                                : formatToolName(event.name)}
                            </span>
                            {isRunning && (
                              <span className="text-[9px] text-sky-400 ml-auto animate-pulse font-mono">● running</span>
                            )}
                            {dur !== undefined && (
                              <span className="text-[9px] text-zinc-600 ml-auto font-mono">{dur}ms</span>
                            )}
                          </div>
                          {/* Terminal body */}
                          <div className="p-2.5 font-mono text-[11px] leading-relaxed">
                            {/* Command line — white prompt + syntax-highlighted command */}
                            {event.args && (
                              <div className="flex gap-2 mb-1.5">
                                <span className="text-emerald-400 shrink-0 select-none font-medium">$</span>
                                <span className="text-zinc-200 break-all font-mono text-[11px] leading-relaxed">
                                  {highlightCommand(extractCommand(event.args, event.name))}
                                </span>
                              </div>
                            )}
                            {/* Output — green text on black */}
                            {event.result && (
                              <div className="text-[#4ec9b0] whitespace-pre-wrap break-all max-h-64 overflow-y-auto leading-snug">
                                {String(event.result)}
                                {isRunning && (
                                  <span className="inline-block w-[6px] h-[14px] bg-[#4ec9b0] animate-pulse ml-0.5 align-middle" />
                                )}
                              </div>
                            )}
                            {/* Show empty prompt when waiting for output */}
                            {!event.result && isRunning && (
                              <div className="flex gap-2">
                                <span className="text-emerald-400 shrink-0 select-none">$</span>
                                <span className="inline-block w-[6px] h-[14px] bg-[#4ec9b0] animate-pulse align-middle" />
                              </div>
                            )}
                          </div>
                        </div>
                      ) : event.result && (
                        <div className="text-[10px] text-zinc-500 font-mono mt-1 truncate">
                          → {String(event.result).slice(0, 120)}
                        </div>
                      )}

                      {/* Sub-agent inline panel */}
                      {event.subAgentName && (
                        <div className="mt-1.5 rounded border border-zinc-700/60 bg-zinc-950/50 px-2 py-1.5">
                          <div className="flex items-center gap-1.5 text-[10px]">
                            <span className="text-sky-400">🤝</span>
                            <span className="text-sky-400 font-medium">{event.subAgentName}</span>
                            {event.subAgentActive && <span className="w-1.5 h-1.5 rounded-full bg-sky-400 chat-pulse-dot shrink-0" />}
                          </div>
                          {event.subAgentText && (
                            <pre className="text-zinc-400 whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed mt-1 max-h-32 overflow-y-auto">
                              {event.subAgentText}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Live working spinner */}
              {isActive && toolEvents.every((t) => t.status !== "running") && (
                <div className="relative">
                  <div className="absolute left-[8px] top-[10px] z-10">
                    <span className="block w-2.5 h-2.5 rounded-full bg-zinc-500 chat-pulse-dot" />
                  </div>
                  <div className="ml-8 mr-3 rounded-md border-l-2 border-zinc-700/50 bg-zinc-900/40 px-2.5 py-1.5">
                    <span className="text-[11px] text-zinc-500 italic">{workingMsg}…</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
