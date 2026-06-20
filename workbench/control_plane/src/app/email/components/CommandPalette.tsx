"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

export interface Command {
  id: string;
  label: string;
  /** Optional keyboard-shortcut hint shown on the right (e.g. "C", "R"). */
  hint?: string;
  run: () => void;
}

/**
 * Superhuman/Shortwave-style command palette. Opened with Cmd/Ctrl+K, type to
 * filter, ↑/↓ to move, Enter to run, Esc to close.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      // Focus the input once the modal has painted.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(needle));
  }, [q, commands]);

  // Keep the highlighted row in range as the filter narrows.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!open) return null;

  const run = (i: number) => {
    const c = filtered[i];
    if (c) {
      onClose();
      c.run();
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center pt-[15vh] px-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <Search size={14} className="text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(filtered.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(active);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="Type a command…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <kbd className="text-[10px] text-muted-foreground border border-border rounded px-1 flex-shrink-0">
            esc
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No matching commands
            </div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                onMouseMove={() => setActive(i)}
                onClick={() => run(i)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${
                  i === active
                    ? "bg-secondary text-foreground"
                    : "text-foreground/80 hover:bg-secondary/60"
                }`}
              >
                <span className="truncate">{c.label}</span>
                {c.hint && (
                  <kbd className="text-[10px] text-muted-foreground border border-border rounded px-1 flex-shrink-0">
                    {c.hint}
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
