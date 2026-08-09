/**
 * Projects · board and ordering maths.
 *
 * Spec: `project-docs/specs/project_management_app.md` §3.10, §5 · D-PM-5.
 *
 * Pure functions only, so the arithmetic that decides where a dragged card
 * lands is testable without a DOM. Everything here is the client half of the
 * per-view ordering decision: positions are floats in `pm_view_task_positions`,
 * there is no rank column on the task, and one drop writes exactly one row.
 */

export interface PositionedTask {
  id: string;
  /** The task's position in THIS view, or null when it has never been dragged. */
  view_position?: number | null;
  view_group_key?: string | null;
  created_at?: string | null;
}

/**
 * The ceiling for a fractional index.
 *
 * `Number.MAX_SAFE_INTEGER` (Paca's choice, and its reason): appending is
 * `(prev + MAX) / 2` and prepending is `next / 2`, so a position can never
 * reach zero and never overflow — negative positions and overflow are
 * impossible by construction rather than by validation.
 */
export const POSITION_MAX = Number.MAX_SAFE_INTEGER;

/**
 * The position for a card dropped between `prev` and `next`.
 *
 * Halving the gap means one write per drag and no renumbering of neighbours.
 * ~52 halvings exhaust a float's precision, which is far past any real board,
 * so renormalisation is deliberately not implemented — the same call Paca
 * documented and left alone.
 */
export function positionBetween(
  prev: number | null | undefined,
  next: number | null | undefined
): number {
  const before = typeof prev === "number" ? prev : null;
  const after = typeof next === "number" ? next : null;
  if (before === null && after === null) return POSITION_MAX / 2;
  if (before === null) return (after as number) / 2;
  if (after === null) return (before + POSITION_MAX) / 2;
  return (before + after) / 2;
}

/**
 * Order tasks for a view: positioned first by position, then the rest by age.
 *
 * Unpositioned tasks sort to the BOTTOM rather than the top. A newly created
 * task appearing at the top of a hand-arranged column would look like the board
 * had reordered itself.
 */
export function sortForView<T extends PositionedTask>(tasks: readonly T[]): T[] {
  const positioned = tasks.filter((t) => typeof t.view_position === "number");
  const rest = tasks.filter((t) => typeof t.view_position !== "number");
  positioned.sort((a, b) => (a.view_position as number) - (b.view_position as number));
  rest.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  return [...positioned, ...rest];
}

export interface PositionWrite {
  task_id: string;
  position: number;
  group_key?: string | null;
}

/**
 * The rows one drop must write.
 *
 * Normally exactly one. The exception is the first drag into a group nobody has
 * ordered yet: the neighbours have no positions to interpolate between, so the
 * whole group is **materialised** in the same request. Doing it lazily — or as
 * N requests — is how a hand-arranged order half-applies and then looks random.
 */
export function planDrop<T extends PositionedTask>(
  ordered: readonly T[],
  taskId: string,
  toIndex: number,
  groupKey?: string | null
): PositionWrite[] {
  const others = ordered.filter((t) => t.id !== taskId);
  const index = Math.max(0, Math.min(toIndex, others.length));

  const needsMaterialising = others.some(
    (t) => typeof t.view_position !== "number"
  );
  if (needsMaterialising) {
    const finalOrder = [
      ...others.slice(0, index).map((t) => t.id),
      taskId,
      ...others.slice(index).map((t) => t.id),
    ];
    const step = POSITION_MAX / (finalOrder.length + 1);
    return finalOrder.map((id, i) => ({
      task_id: id,
      position: step * (i + 1),
      group_key: groupKey ?? null,
    }));
  }

  return [
    {
      task_id: taskId,
      position: positionBetween(
        others[index - 1]?.view_position ?? null,
        others[index]?.view_position ?? null
      ),
      group_key: groupKey ?? null,
    },
  ];
}

/**
 * Where a saved view is positioned (WS-27k).
 *
 * Above the two views `tree.py` seeds on every project — "All tasks" at 100 and
 * "Board" at 200 — because the server returns views ordered by position, and
 * `orderBearingView` takes the first board it sees. A view saved below 200
 * would quietly become the one every drag writes its order into.
 */
export const SAVED_VIEW_POSITION = 300;

/**
 * The view whose `pm_view_task_positions` rows the board's drags write.
 *
 * There is no `is_default` column, so "the board" is the first `board` view the
 * server returned — and the server orders by position, which is why saved views
 * sit above the seeded one. Naming this once matters because two places need
 * the same answer: the drag handler writes to it, and the delete button must
 * refuse it. Deleting it CASCADEs every hand-arranged position on the project,
 * which is exactly the silent loss `delete_view` warns about.
 */
export function orderBearingView<T extends { view_type: string }>(
  views: readonly T[]
): T | null {
  return views.find((view) => view.view_type === "board") ?? null;
}

/**
 * The field patch a cross-column drag implies.
 *
 * Board columns come from the view's `column_by`, so dropping a card into a
 * column sets **whatever field the view groups by** — not `status` specifically.
 * Hard-coding status is what makes a board that can only ever group by status.
 */
export function buildColumnDropUpdate(
  columnBy: string | null | undefined,
  groupKey: string | null
): Record<string, string | null> | null {
  switch (columnBy) {
    case "status":
      return { status_id: groupKey };
    case "type":
      return { type_id: groupKey };
    case "project":
      return { project_id: groupKey };
    default:
      // An unknown grouping is not an error — the drop still reorders within
      // the column; it simply patches no field.
      return null;
  }
}
