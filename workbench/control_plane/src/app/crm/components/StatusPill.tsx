"use client";

/**
 * The status pill — a lane badge that is also the way to move a record.
 *
 * One control, because a read-only badge next to a separate "change stage"
 * menu is two places to look for the same fact. Moving from here issues the
 * same PATCH the kanban drag does (lib/board.ts::moveRequest).
 */

import Icon from "@/components/Icon";
import { useState } from "react";
import { statusTone } from "../lib/board";
import type { Status } from "../lib/types";

export default function StatusPill({
  status,
  statuses,
  onChange,
  disabled = false,
}: {
  status: Status | null;
  statuses: Status[];
  onChange?: (statusId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const readOnly = disabled || !onChange || statuses.length === 0;

  const label = status?.name ?? "No status";
  const tone = status ? statusTone(status) : "bg-muted-foreground";

  if (readOnly) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/40 px-2.5 py-1 text-xs text-foreground">
        <span className={`w-1.5 h-1.5 rounded-full ${tone}`} />
        {label}
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/40 px-2.5 py-1 text-xs text-foreground hover:border-primary/40 tech-transition"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${tone}`} />
        {label}
        <Icon name="ChevronDown" className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-50 mt-1 w-52 rounded-xl border border-border bg-card p-1 shadow-lg">
            {[...statuses]
              .sort((a, b) => a.position - b.position)
              .map((option) => (
                <button
                  key={option.id}
                  onClick={() => {
                    setOpen(false);
                    if (option.id !== status?.id) onChange(option.id);
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs tech-transition ${
                    option.id === status?.id
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${statusTone(option)}`}
                  />
                  <span className="flex-1 truncate">{option.name}</span>
                  {/* The stage's default probability beside its name: moving a
                      deal here is what makes it inherit that number, and the
                      forecast changes the moment it does (§5.1). */}
                  {option.probability !== null &&
                  option.probability !== undefined ? (
                    <span className="text-[10px] tabular-nums opacity-60">
                      {option.probability}%
                    </span>
                  ) : null}
                  {option.type === "won" || option.type === "lost" ? (
                    <span className="text-[10px] uppercase opacity-60">
                      {option.type}
                    </span>
                  ) : null}
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
