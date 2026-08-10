/**
 * Projects · what an empty canvas says (S4).
 *
 * Two states, never one. The board used to draw *"Nothing to show. Clear a
 * filter, or this project has no statuses yet."* — a sentence that names both
 * possible causes and leaves the reader to work out which applies to them, and
 * the list drew a bare *"No tasks here yet."* even when a filter was hiding
 * everything. `/tasks` had this right: `NoMatchState` says the filters did it
 * and offers a way out, `EmptyState` says there is genuinely nothing.
 *
 * The predicate is `grouping.isFiltered` — the same one the toolbar's Clear
 * button and the `filtered` badge already read. A second "is anything
 * filtering?" rule here would be the third answer to one question, and the two
 * would disagree the first time a filter was added.
 *
 * Pure, and tested (`emptyState.test.ts`), because the copy IS the feature: a
 * component test could not run here (vitest is node-env, `.test.ts` only) and
 * "does this screen explain itself" is otherwise fenced by nothing.
 */

/** Which surface is empty. They differ only where they honestly differ. */
export type EmptyCanvas = "board" | "list";

export interface EmptyStateCopy {
  /**
   * Lucide name for `<EmptyState icon=…>`.
   *
   * ⚠️ **Must be a name `icon-registry.json` maps in every pack.** An unmapped
   * name silently falls back to the Lucide glyph, and one Lucide outline in a
   * screen of Material Symbols reads as a bug, not as a style. `FilterX` is
   * exactly that trap — mapped nowhere — which is why the filtered state wears
   * `SearchX` (`search-off` / `search-info`). `emptyState.test.ts` checks it.
   */
  icon: string;
  message: string;
  hint?: string;
  /**
   * True when filters are the cause — the caller offers **Clear filters**.
   * Carried rather than re-derived so the copy and the control cannot drift
   * apart: the state that blames the filters is exactly the state that undoes
   * them.
   */
  filtered: boolean;
}

export function emptyStateCopy(input: {
  canvas: EmptyCanvas;
  filtered: boolean;
  /**
   * Board only: the columns come from the project's statuses, so an unfiltered
   * board with no columns means the project has no statuses — a fact worth
   * saying, and one the list can never be in.
   */
  onStatusAxis?: boolean;
}): EmptyStateCopy {
  if (input.filtered) {
    return {
      icon: "SearchX",
      message: "No tasks match your filters.",
      hint: "Clear them to see everything here again.",
      filtered: true,
    };
  }
  if (input.canvas === "board" && input.onStatusAxis) {
    return {
      icon: "Columns3",
      message: "This project has no statuses yet.",
      hint: "Statuses are the board's columns — add one and tasks have somewhere to sit.",
      filtered: false,
    };
  }
  return {
    icon: "ClipboardList",
    message: "No tasks here yet.",
    filtered: false,
  };
}
