"use client";

/**
 * TodoPanel — VS Code Copilot Chat-style "Todos (n/m)" panel.
 *
 * Pinned above the chat input. Mirrors VS Code's chatTodoListWidget:
 *   • Collapsible header with completion count
 *   • Check circles: ✓ done (green), ◐ in-progress (blue pulse), ○ pending
 *   • Auto-expands while the run is active, collapses when all done
 */

import { useEffect, useMemo, useRef, useState } from "react";

export interface TodoItem {
  id: string;
  title: string;
  status: string; // pending | in_progress | done | completed | cancelled
}

function isDone(s: string): boolean {
  return s === "done" || s === "completed";
}

function isActive(s: string): boolean {
  return s === "in_progress" || s === "in-progress" || s === "active";
}

export default function TodoPanel({
  todos,
  running,
}: {
  todos: TodoItem[];
  running: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const userToggledRef = useRef(false);

  const doneCount = useMemo(
    () => todos.filter((t) => isDone(t.status)).length,
    [todos],
  );
  const allDone = todos.length > 0 && doneCount === todos.length;

  // Auto-collapse shortly after everything completes (unless user toggled).
  useEffect(() => {
    if (userToggledRef.current) return;
    if (allDone && !running) {
      const t = setTimeout(() => setExpanded(false), 1500);
      return () => clearTimeout(t);
    }
    setExpanded(true);
  }, [allDone, running]);

  if (todos.length === 0) return null;

  return (
    <div className="max-w-3xl mx-auto mb-2 rounded-lg border border-zinc-700/50 bg-zinc-900/70 overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => { userToggledRef.current = true; setExpanded((o) => !o); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800/40 transition-colors"
      >
        <span className="text-[10px] text-zinc-500 transition-transform duration-150"
          style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}>
          ▼
        </span>
        <span className="text-xs font-semibold text-zinc-300">
          Todos ({doneCount}/{todos.length})
        </span>
        {running && !allDone && (
          <span className="w-1.5 h-1.5 rounded-full bg-sky-400 chat-pulse-dot shrink-0" />
        )}
      </button>

      {/* Items */}
      {expanded && (
        <ul className="px-3 pb-2 space-y-1 max-h-48 overflow-y-auto">
          {todos.map((t) => {
            const done = isDone(t.status);
            const active = isActive(t.status);
            return (
              <li key={t.id} className="flex items-center gap-2.5 text-xs leading-snug">
                <span className="shrink-0 flex items-center justify-center w-4 h-4">
                  {done ? (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="7" stroke="#34d399" strokeWidth="1.3" />
                      <path d="M5 8.2l2 2 4-4.4" stroke="#34d399" strokeWidth="1.4"
                        strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : active ? (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                      className="chat-pulse-dot">
                      <circle cx="8" cy="8" r="7" stroke="#38bdf8" strokeWidth="1.3" />
                      <circle cx="8" cy="8" r="3" fill="#38bdf8" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="7" stroke="#52525b" strokeWidth="1.3" />
                    </svg>
                  )}
                </span>
                <span className={
                  done
                    ? "text-zinc-500"
                    : active
                    ? "text-zinc-100 font-medium"
                    : "text-zinc-400"
                }>
                  {t.title}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
