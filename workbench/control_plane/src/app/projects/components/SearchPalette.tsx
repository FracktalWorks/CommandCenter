"use client";

/**
 * Projects · the search palette (WS-27r).
 *
 * `⌘K` from anywhere in Projects, type, arrow to a hit, Enter to open it. The
 * last row of the parity backlog: `?q=` has been on the list endpoint since
 * WS-27a with no way to reach it.
 *
 * **A palette rather than a search page**, because the question it answers is
 * *"where is that task"* — asked while doing something else, usually about
 * work in a project the person is not looking at. A page would make finding
 * something a place you navigate TO, which is one navigation more than the
 * problem has.
 *
 * All of the logic — the debounce, what to show while a request is in flight,
 * which keystrokes belong to the palette, and how to ignore a stale response —
 * is in `lib/search.ts` and tested there. Those are the rules that only break
 * under real typing speed on a real connection, which is not a thing a
 * component test reproduces.
 */

import Icon from "@/components/Icon";
import { Input } from "@/components/ui/Input";
import { useEffect, useRef, useState } from "react";

import { projectsApi } from "../lib/api";
import {
  DEBOUNCE_MS,
  type Hit,
  highlight,
  hitContext,
  isCurrent,
  moveSelection,
  paletteKey,
  paletteState,
} from "../lib/search";

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}

export function SearchPalette({ open, onClose, onOpenTask }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Read inside the async callback so a response can be checked against what
  // is in the box NOW, not against the value captured when it was sent.
  const liveQuery = useRef(query);
  liveQuery.current = query;

  // Reset on every open. A palette that reopens showing the last search is a
  // palette you have to clear before you can use it.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits(null);
    setTruncated(false);
    setError(null);
    setCursor(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length < 2) {
      setHits(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await projectsApi.search(term);
        // The out-of-order guard: "par" and "parser" are two requests with no
        // ordering guarantee, and a slow first one landing last would replace
        // the right answers with stale ones.
        if (!isCurrent(res.query, liveQuery.current)) return;
        setHits(res.rows);
        setTruncated(res.truncated);
        setError(null);
        setCursor(0);
      } catch (err) {
        if (isCurrent(term, liveQuery.current)) {
          setError(String((err as Error).message));
        }
      } finally {
        if (isCurrent(term, liveQuery.current)) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open]);

  if (!open) return null;

  const view = paletteState({ query, loading, hits, truncated, error });
  const rows = view.kind === "results" ? view.hits : [];

  function activate(taskId: string) {
    onOpenTask(taskId);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 pt-24"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search tasks"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Icon name="Search" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search every project you can see…"
            aria-label="Search tasks"
            className="border-0 focus:border-0"
            onKeyDown={(e) => {
              const action = paletteKey(e);
              if (!action) return;
              // Claimed before the browser sees them: an unhandled ArrowUp
              // moves the text caret to the start of the query, so the
              // selection and the cursor would both move on one key.
              e.preventDefault();
              if (action === "close") onClose();
              if (action === "down") setCursor((c) => moveSelection(c, 1, rows.length));
              if (action === "up") setCursor((c) => moveSelection(c, -1, rows.length));
              if (action === "open" && rows.length > 0) {
                activate(rows[moveSelection(cursor, 0, rows.length)].id);
              }
            }}
          />
          <kbd className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
            esc
          </kbd>
        </div>

        <div className="max-h-80 overflow-y-auto">
          {view.kind === "idle" ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              Type at least two characters. A number like{" "}
              <code className="text-foreground">#42</code> finds that task.
            </p>
          ) : null}
          {view.kind === "searching" || view.kind === "typing" ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">Searching…</p>
          ) : null}
          {view.kind === "empty" ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              Nothing matches “{query.trim()}”.
            </p>
          ) : null}
          {view.kind === "error" ? (
            <p className="px-3 py-4 text-xs text-destructive">{view.message}</p>
          ) : null}

          <ul>
            {rows.map((row, index) => (
              <li key={row.id}>
                <button
                  type="button"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => activate(row.id)}
                  className={`flex w-full items-baseline gap-2 px-3 py-2 text-left ${
                    index === moveSelection(cursor, 0, rows.length)
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted"
                  }`}
                >
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${
                      row.completed_at ? "line-through opacity-60" : ""
                    }`}
                  >
                    {highlight(row.title, query).map((part, i) => (
                      <span
                        key={`${row.id}:${i}`}
                        className={part.match ? "font-semibold text-primary" : ""}
                      >
                        {part.text}
                      </span>
                    ))}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {hitContext(row)}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {view.kind === "results" && view.truncated ? (
            <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              More matches than fit — add a word to narrow it.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
