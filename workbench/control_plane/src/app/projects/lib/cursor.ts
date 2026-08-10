/**
 * Projects · the keyboard cursor (WS-27y) — now the SHARED implementation.
 *
 * The logic (and its tests) moved to `src/lib/cursor.ts` when /tasks adopted
 * the same cursor: one transition function, two apps. This shim keeps every
 * existing Projects import working unchanged.
 *
 * Note: `stepCursor`'s shift-sweep used to call `selection.range` directly;
 * the shared module carries its own copy of that eight-line index walk (same
 * contract, pinned by the same tests) because a shared lib must not import
 * app code. `selection.range` remains the Projects selection model's own API.
 */

export { NO_CURSOR, clampCursor, stepCursor } from "@/lib/cursor";
export type { CursorNext, CursorState } from "@/lib/cursor";
