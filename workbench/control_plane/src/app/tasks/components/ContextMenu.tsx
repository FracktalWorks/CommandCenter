/**
 * Re-export shim — the right-click menu now lives in `@/components/ContextMenu`
 * (WS-27bd item 5).
 *
 * It was declared here and /projects needed the same interaction; a second copy
 * is the defect CLAUDE.md §5 names, so it was **moved** rather than duplicated.
 * The shim exists so this app's five call sites (`TaskCard` ×2, `InboxCard`,
 * `calendar/TimeGrid`, `calendar/UnscheduledRail`) keep their import path — the
 * same shape the round-1 continuity promotions left behind for `lib/cursor`,
 * `components/QuickAdd` and `components/useFlash`.
 *
 * A shim that grows a body is a third implementation wearing a forwarding
 * file's name; `src/lib/sharedTaskUi.test.ts`'s "the shims stay shims" case is
 * the fence.
 */

export { ContextMenu, type CtxItem } from "@/components/ContextMenu";
