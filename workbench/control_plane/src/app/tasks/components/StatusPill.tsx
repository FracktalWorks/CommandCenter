"use client";

import Icon from "@/components/Icon";
import { StatusChip } from "@/components/StatusChip";
import { useState } from "react";
import { GtdItem } from "../lib/types";
import { useCardActions } from "../lib/useCardActions";
import { stageAccent } from "../lib/stageColors";

// The task's STATUS INDICATOR — the single status control shared by the card
// (TaskCard) and the desktop list's Status column. There is no separate Done
// button; the last stage is "Done" like any other stage. The pill is coloured
// by the same stageAccent the board columns and list headers use (Done → green,
// In-progress → blue, …), so status reads the same everywhere. Click opens a
// small stage list to change it — picking the last stage marks the task done
// (see useCardActions). stopPropagation so it never opens the card/row.
//
// WS-27ad: the pill BODY is `@/components/StatusChip`, the same one /projects
// draws in its list and table cells — the classes are unchanged, they just live
// somewhere both apps can reach. What stays here is the interaction: /projects'
// status is read-only or a `<select>`, this one opens a stage menu.
export function StatusPill({ item }: { item: GtdItem }) {
  const { stages, currentStage, setStage } = useCardActions(item);
  const [open, setOpen] = useState(false);
  const accent = stageAccent(
    currentStage,
    Math.max(0, stages.indexOf(currentStage)),
    stages.length,
  );
  return (
    <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Change status"
        aria-label={`Status: ${currentStage}. Click to change.`}
        className="tech-transition inline-flex hover:brightness-95"
      >
        <StatusChip
          accent={accent}
          label={currentStage}
          trailing={<Icon name="ChevronDown" className="h-2.5 w-2.5 opacity-60" />}
        />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[150px] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl">
            {stages.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setStage(s);
                  setOpen(false);
                }}
                className="tech-transition flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-secondary"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${stageAccent(s, i, stages.length).dot}`}
                />
                <span className="min-w-0 flex-1 truncate">{s}</span>
                {s === currentStage && (
                  <Icon name="Check" className="h-3 w-3 shrink-0 text-primary" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
