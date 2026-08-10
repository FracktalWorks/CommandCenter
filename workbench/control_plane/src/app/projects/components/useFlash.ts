/**
 * Projects · the landing flash (WS-27y) — now the SHARED hook.
 *
 * Moved (with `flash.module.css`) to `src/components/` when /tasks adopted
 * the same post-drop announcement: one landing animation, two apps. This
 * shim keeps every existing Projects import working unchanged.
 */

export { useFlash } from "@/components/useFlash";
export type { Flash } from "@/components/useFlash";
