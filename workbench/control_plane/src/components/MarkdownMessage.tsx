"use client";

/**
 * MarkdownMessage — VS Code Copilot-style rich message renderer.
 *
 * Features:
 *  • Full GitHub-flavoured Markdown (GFM): tables, strikethrough, task lists
 *  • Syntax-highlighted code blocks (VS Code dark+ theme via react-syntax-highlighter)
 *  • Terminal blocks with macOS-style chrome (red/yellow/green dots)
 *  • One-click copy button on every code block
 *  • Clickable links (open in new tab)
 *  • Collapsible tool-call accordion blocks (mirrors VS Code's "Used tool: …")
 *  • Streaming cursor (blinking ▌) while the response is in-flight
 */

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import ThinkingContainer from "@/components/ThinkingContainer";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolEvent {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  status: "running" | "done" | "error";
  startedAt?: number;
  endedAt?: number;
  /** Set when this tool is a call_agent delegation — the target agent name. */
  subAgentName?: string;
  /** Live streaming text from the sub-agent (appended as it streams). */
  subAgentText?: string;
  /** Tool calls made by the sub-agent. */
  subAgentTools?: Array<{id: string; name: string; result?: string; status: "running" | "done" | "error"}>;
  /** True while the sub-agent is actively streaming. */
  subAgentActive?: boolean;
}

interface MarkdownMessageProps {
  content: string;
  streaming?: boolean;
  toolEvents?: ToolEvent[];
  /** Live tool-name status lines for the ThinkingContainer. */
  progressLines?: string[];
  /** True while the agent run is in progress (drives shimmer/working state). */
  isThinkingActive?: boolean;
  /** Sequential reasoning blocks — each its own timeline entry. */
  reasoningBlocks?: string[];
  /** Invoked when the user clicks an MCQ choice button (```choices block). */
  onChoice?: (choice: string) => void;
  /** Session ID for resolving relative image paths through the workspace file proxy. */
  sessionId?: string;
  /** Optional file path context for resolving relative image src in markdown (e.g. the .md file path). */
  mdFilePath?: string;
}

// ─── Media path resolver (shared with ArtifactViewerModal) ────────────────────

/**
 * Rewrite an image src found inside a markdown message so it routes through the
 * gateway file proxy.
 *
 * Rules (in priority order):
 *  1. Already a full URL (http/https/data:) → pass through unchanged
 *  2. Absolute path starting with /          → treat as workspace-relative and proxy
 *  3. Relative path                          → resolve against the mdFilePath's
 *                                             directory, then proxy
 */
function resolveMediaSrc(
  src: string,
  sessionId: string | undefined,
  mdFilePath: string | undefined,
): string {
  // Full URLs and data URIs pass through unchanged
  if (/^(https?:|data:)/i.test(src)) return src;
  // No session context → can't resolve; return as-is
  if (!sessionId) return src;

  let workspacePath: string;
  if (src.startsWith("/")) {
    // Treat absolute paths as workspace-root-relative
    workspacePath = src.replace(/^\/+/, "");
  } else if (mdFilePath) {
    // Relative: resolve against the directory containing the .md file
    const mdDir = mdFilePath.includes("/")
      ? mdFilePath.substring(0, mdFilePath.lastIndexOf("/"))
      : "";
    const parts = (mdDir ? `${mdDir}/${src}` : src).split("/");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "..") resolved.pop();
      else if (part !== ".") resolved.push(part);
    }
    workspacePath = resolved.join("/");
  } else {
    // No mdFilePath context — treat as workspace-root-relative
    workspacePath = src;
  }

  return `/api/agent/workspace/${sessionId}/file?path=${encodeURIComponent(workspacePath)}`;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TERMINAL_LANGS = new Set([
  "bash", "sh", "shell", "terminal", "console",
  "zsh", "powershell", "cmd", "fish",
]);

// ─── Copy button ─────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      className="text-[11px] text-zinc-400 hover:text-zinc-100 transition-colors px-2 py-0.5 rounded hover:bg-zinc-600/60 font-mono"
    >
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

// ─── Code block ──────────────────────────────────────────────────────────────

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const isTerminal = TERMINAL_LANGS.has(lang);

  return (
    <div className="my-4 rounded-xl overflow-hidden border border-zinc-700/60 bg-zinc-950">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/80 border-b border-zinc-700/60">
        {isTerminal ? (
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/70" />
            <span className="ml-2 text-[11px] text-zinc-500 font-mono">{lang}</span>
          </div>
        ) : (
          <span className="text-[11px] text-zinc-500 font-mono">{lang || "code"}</span>
        )}
        <CopyButton text={code} />
      </div>

      {/* Syntax-highlighted code (VS Code dark+ theme) */}
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={lang || "text"}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: 0,
          background: "transparent",
          fontSize: "0.785rem",
          padding: "1rem",
          lineHeight: "1.6",
        }}
        codeTagProps={{
          style: {
            fontFamily:
              "ui-monospace, SFMono-Regular, 'SF Mono', Consolas, 'Courier New', monospace",
          },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

// ─── MCQ choice block ───────────────────────────────────────────────────────
// Renders a ```choices fenced block as clickable buttons. The first non-list
// line (if any) is treated as the question; lines beginning with - or * are
// the selectable options.

function parseChoices(raw: string): { question: string | null; options: string[] } {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const dashed = lines.filter((l) => /^[-*]\s+/.test(l));
  if (dashed.length > 0) {
    const firstDashIdx = lines.findIndex((l) => /^[-*]\s+/.test(l));
    const question = firstDashIdx > 0 ? lines.slice(0, firstDashIdx).join(" ") : null;
    const options = dashed.map((l) => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean);
    return { question, options };
  }
  // No dashes — every line is an option.
  return { question: null, options: lines };
}

function ChoiceBlock({
  raw,
  onChoice,
}: {
  raw: string;
  onChoice?: (choice: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const { question, options } = parseChoices(raw);
  if (options.length === 0) return null;

  return (
    <div className="my-3 rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-3">
      {question && (
        <div className="text-sm font-medium text-zinc-200 mb-2.5">{question}</div>
      )}
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const isPicked = picked === opt;
          return (
            <button
              key={opt}
              disabled={picked !== null}
              onClick={() => {
                setPicked(opt);
                onChoice?.(opt);
              }}
              className={`text-left text-xs rounded-lg border px-3 py-2 transition-colors ${
                isPicked
                  ? "border-emerald-600/70 bg-emerald-900/40 text-emerald-200"
                  : picked !== null
                  ? "border-zinc-800 bg-zinc-900/40 text-zinc-600 cursor-not-allowed"
                  : "border-zinc-700 bg-zinc-800/70 text-zinc-200 hover:border-emerald-600/60 hover:bg-zinc-800"
              }`}
            >
              {isPicked && <span className="mr-1.5 text-emerald-400">✓</span>}
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────

export default function MarkdownMessage({
  content,
  streaming,
  toolEvents,
  progressLines,
  isThinkingActive,
  reasoningBlocks,
  onChoice,
  sessionId,
  mdFilePath,
}: MarkdownMessageProps) {
  const hasTools =
    (toolEvents && toolEvents.length > 0) ||
    (progressLines && progressLines.length > 0);
  const hasReasoning = !!(reasoningBlocks && reasoningBlocks.length > 0);
  // Show the ThinkingContainer for the ENTIRE active phase (not just until the
  // first token). The container disappears mid-stream if we gate on content===""
  // — the user sees "Thinking…" flash then nothing while text is still arriving.
  // After completion: keep it only if there are tools or reasoning to show.
  const showThinking = isThinkingActive || hasTools || hasReasoning;

  return (
    <div className="text-[12px] sm:text-[13px] text-zinc-200 leading-relaxed min-w-0">
      {/* Thinking container — groups the whole working phase (reasoning + tool calls + status) */}
      {showThinking && (
        <div className="mb-3">
          <ThinkingContainer
            toolEvents={toolEvents ?? []}
            progressLines={progressLines ?? []}
            reasoningBlocks={reasoningBlocks}
            isActive={!!isThinkingActive}
          />
        </div>
      )}

      {/* Markdown body */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // ── Headings ──
          h1: ({ children }) => (
            <h1 className="text-[1.1rem] font-bold text-zinc-100 mt-5 mb-3 pb-1 border-b border-zinc-700">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[1rem] font-semibold text-zinc-100 mt-4 mb-2">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[0.9rem] font-semibold text-zinc-200 mt-3 mb-1.5">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-sm font-semibold text-zinc-300 mt-2 mb-1">
              {children}
            </h4>
          ),

          // ── Paragraphs & text ──
          p: ({ children }) => (
            <p className="mb-3 last:mb-0 text-zinc-200">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-zinc-100">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic text-zinc-300">{children}</em>
          ),
          del: ({ children }) => (
            <del className="line-through text-zinc-500">{children}</del>
          ),

          // ── Lists ──
          ul: ({ children }) => (
            <ul className="mb-3 ml-5 space-y-1 list-disc list-outside marker:text-zinc-500">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 ml-5 space-y-1 list-decimal list-outside marker:text-zinc-500">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="text-zinc-300 pl-0.5">{children}</li>
          ),

          // ── Links ──
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 underline underline-offset-2 hover:text-blue-300 transition-colors break-all"
            >
              {children}
            </a>
          ),

          // ── Blockquote ──
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-zinc-600 pl-4 my-3 text-zinc-400 italic">
              {children}
            </blockquote>
          ),

          // ── Images ──
          // Rewrite src to route through the gateway workspace file proxy.
          // Full URLs (https://…) and data: URIs pass through unchanged.
          img({ src, alt, ...rest }) {
            const rawSrc = typeof src === "string" ? src : "";
            const resolvedSrc = resolveMediaSrc(rawSrc, sessionId, mdFilePath);
            // eslint-disable-next-line @next/next/no-img-element
            return (
              <img
                src={resolvedSrc}
                alt={alt ?? ""}
                {...rest}
                className="max-w-full max-h-96 rounded-lg my-3 border border-zinc-700/50 object-contain"
                loading="lazy"
              />
            );
          },

          // ── Tables (GFM) ──
          table: ({ children }) => (
            <div className="overflow-x-auto my-4 rounded-lg border border-zinc-700/60">
              <table className="w-full text-[12px] sm:text-[13px] border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-zinc-800/60">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-4 py-2 text-left text-xs font-semibold text-zinc-400 uppercase tracking-wide border-b border-zinc-700/60">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-4 py-2 text-zinc-300 border-b border-zinc-800/60 last:border-b-0">
              {children}
            </td>
          ),

          // ── HR ──
          hr: () => <hr className="my-5 border-zinc-700" />,

          // ── Code (inline + block) ──
          pre: ({ children }) => <>{children}</>,
          code({ className, children }) {
            const match = /language-(\w+)/.exec(className || "");
            const lang = match ? match[1].toLowerCase() : "";
            const codeString = String(children).replace(/\n$/, "");

            // Block code (has a language class)
            if (match) {
              // MCQ choices block — render interactive buttons instead of code.
              if (lang === "choices") {
                return <ChoiceBlock raw={codeString} onChoice={onChoice} />;
              }
              return <CodeBlock lang={lang} code={codeString} />;
            }

            // Inline code
            return (
              <code className="bg-zinc-800 text-zinc-200 rounded px-1.5 py-0.5 font-mono text-[0.82em] border border-zinc-700/50">
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>

      {/* Streaming cursor */}
      {streaming && (
        <span className="inline-block w-[2px] h-[1em] bg-zinc-300 animate-pulse ml-0.5 align-middle rounded-full" />
      )}
    </div>
  );
}
