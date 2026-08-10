"use client";

/**
 * /tasks · the ungrouped views — Done, Someday, Archive, Engage, Priority.
 *
 * Lifted out of `ItemList` by WS-27ad, because the reason it had to move is the
 * whole ticket: the board and the grouped list had grown the shared keyboard
 * cursor, the post-drop flash and the group-context quick-add, and these lists
 * — a third of the app's surfaces — had none of them. Arrow keys did nothing
 * here while they walked rows one click away.
 *
 * Everything interactive in this file is the shared implementation:
 * `@/lib/cursor` for the cursor and its Shift-sweep, `@/components/useFlash`
 * for the landing flash, `@/components/QuickAdd` for the capture box. What
 * stays local is GTD: WHICH bucket a quick-add lands in is `lib/quickAdd`'s
 * `viewQuickAdd`, and a view that cannot honestly take one shows no box.
 */

import { QuickAdd } from "@/components/QuickAdd";
import { useFlash } from "@/components/useFlash";
import { clampCursor, stepCursor } from "@/lib/cursor";
import { useMemo, useState } from "react";

import { viewQuickAdd } from "../lib/quickAdd";
import { useTaskStore } from "../lib/taskStore";
import { GtdItem, ViewKey } from "../lib/types";
import { TaskCard } from "./TaskCard";

const NOBODY: ReadonlySet<string> = new Set();

export function FlatList({
  items,
  view,
  showPriority = false,
}: {
  items: GtdItem[];
  view: ViewKey;
  showPriority?: boolean;
}) {
  const selectMode = useTaskStore((s) => s.selectMode);
  const selectedIds = useTaskStore((s) => s.selectedIds);
  const toggleSelected = useTaskStore((s) => s.toggleSelected);
  const extendSelection = useTaskStore((s) => s.extendSelection);
  const quickAddNext = useTaskStore((s) => s.quickAddNext);
  const openFocus = useTaskStore((s) => s.openFocus);

  const [cursor, setCursor] = useState(-1);
  const [anchor, setAnchor] = useState<number | null>(null);
  const { flash, attach, scrollTo } = useFlash();

  const rows = useMemo(() => items.map((item) => item.id), [items]);
  // Clamped at READ time rather than synced by an effect: the rows shrink under
  // the cursor on every reload, and a state write per reload is exactly the
  // cascading-render pattern the lint forbids.
  const cursorAt = clampCursor(rows.length, cursor);

  const box = viewQuickAdd(view);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.defaultPrevented) return;
    if (
      (event.target as HTMLElement).closest(
        "input, textarea, select, [contenteditable=true]",
      )
    )
      return;
    const picked = selectMode ? selectedIds : NOBODY;
    const next = stepCursor(
      rows,
      { cursor: cursorAt, anchor, selection: picked },
      event.key,
      selectMode && event.shiftKey,
    );
    if (!next) return;
    event.preventDefault();
    setCursor(next.cursor);
    setAnchor(next.anchor);
    if (next.selection !== picked) extendSelection([...next.selection]);
    if (next.open) openFocus(next.open);
    if (next.cursor >= 0) scrollTo(rows[next.cursor]);
  }

  const quickAdd = async (title: string) => {
    if (!box) return;
    const id = quickAddNext(title, box.prefill);
    if (id) flash(id);
  };

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Task list — arrow keys move, Enter opens"
      className="flex-1 overflow-y-auto outline-none"
    >
      {items.map((item, index) => {
        const atCursor = cursorAt >= 0 && cursorAt === index;
        return (
          <div
            key={item.id}
            ref={attach(item.id)}
            className={atCursor ? "bg-muted/60 ring-2 ring-inset ring-ring" : ""}
          >
            {selectMode ? (
              <label className="flex cursor-pointer items-center gap-2 border-b border-border/60 pl-3 hover:bg-secondary/40">
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  onChange={(e) =>
                    toggleSelected(
                      item.id,
                      (e.nativeEvent as MouseEvent).shiftKey,
                      rows,
                    )
                  }
                  className="h-4 w-4 shrink-0 accent-primary"
                />
                <div className="pointer-events-none min-w-0 flex-1">
                  <TaskCard item={item} variant="row" />
                </div>
              </label>
            ) : (
              <TaskCard item={item} variant="row" showPriority={showPriority} />
            )}
          </div>
        );
      })}
      {/* The view's own capture box, where the view can honestly take one. */}
      {box ? (
        <div className="px-3.5 py-2">
          <QuickAdd label={box.label} onAdd={quickAdd} className="max-w-md" />
        </div>
      ) : null}
    </div>
  );
}
