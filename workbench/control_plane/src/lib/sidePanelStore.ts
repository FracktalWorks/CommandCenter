/**
 * sidePanelStore — module-level singleton for the VS Code-style side-panel
 * editor: which files are open as tabs, which tab is active, and whether the
 * panel is expanded.
 *
 * Why a module-level store (not component state): the open-tab set is shared by
 * three unrelated places — the SidePanelEditor itself, the ArtifactSidebar file
 * tree (right-click "Open in side panel"), MessageBubble inline cards ("Open
 * report"), and AgentChat (which folds the open docs into the agent's context).
 * Lifting it here keeps them all in sync and survives session-panel remounts.
 *
 * Snapshot stability (critical — see the useSyncExternalStore memory): getState()
 * MUST return the SAME reference until something actually changes, or React #185
 * (infinite render loop) fires. We mutate into a fresh object ONLY on real
 * changes and cache it; subscribers are notified only then.
 *
 * Usage (via useSyncExternalStore):
 *   const st = useSyncExternalStore(subscribe, getState, getState);
 */

export interface OpenDoc {
  /** Workspace-relative path, e.g. "outputs/reports/q3.md" — the tab identity.
   *  Generative-UI tabs use a synthetic "genui:<id>" path (no file behind it). */
  path: string;
  /** Basename for the tab label. */
  name: string;
  /** Session whose workspace this file lives in (tabs are scoped per session). */
  sessionId: string;
  /** True while the doc is actively being written by the agent (live badge). */
  live?: boolean;
  /** Tab content kind: a workspace file (default) or an agent-pushed
   *  generative-UI tree rendered natively (no filesystem round-trip). */
  kind?: "file" | "genui";
  /** The generative_ui spec for kind === "genui" tabs. */
  spec?: unknown;
}

export interface SidePanelState {
  open: boolean;
  docs: OpenDoc[];
  /** Active tab path, or null when no tab is selected / panel empty. */
  activePath: string | null;
  /** Panel width in px, set by dragging its right edge. Persisted per browser. */
  width: number;
}

/** Width bounds. Below MIN the toolbar wraps; above MAX the chat gets cramped. */
export const MIN_PANEL_WIDTH = 320;
export const MAX_PANEL_WIDTH = 1100;
export const DEFAULT_PANEL_WIDTH = 480;

const WIDTH_KEY = "cc.sidePanel.width";

// ── Module-level state ──────────────────────────────────────────────────────

// Starts at the default rather than the persisted value on purpose: this module
// is evaluated during SSR too, and seeding from localStorage here would make the
// server and client disagree on first paint. hydratePanelWidth() applies the
// stored width after mount — invisible in practice, since the panel starts
// closed.
let _state: SidePanelState = {
  open: false, docs: [], activePath: null, width: DEFAULT_PANEL_WIDTH,
};
const _listeners = new Set<() => void>();

function _emit(next: SidePanelState): void {
  _state = next;
  _listeners.forEach((l) => l());
}

export function getState(): SidePanelState {
  return _state;
}

export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

// ── Width ───────────────────────────────────────────────────────────────────

function _clampWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_PANEL_WIDTH;
  return Math.round(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, px)));
}

/**
 * Set the panel width (px), clamped to the bounds above.
 *
 * Called on every pointermove of a resize drag, so it must stay cheap and must
 * not emit when the clamped value is unchanged — otherwise dragging past a bound
 * would re-render on every frame for nothing.
 */
export function setPanelWidth(px: number): void {
  const width = _clampWidth(px);
  if (width === _state.width) return;
  _emit({ ..._state, width });
}

/** Persist the current width. Called once at the END of a drag, not per frame. */
export function persistPanelWidth(): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(_state.width));
  } catch {
    // Private mode / quota — the width just won't survive a reload.
  }
}

/** Apply the persisted width. Safe to call repeatedly; call after mount. */
export function hydratePanelWidth(): void {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    if (raw) setPanelWidth(Number(raw));
  } catch {
    // No storage access — keep the default.
  }
}

// ── Mutations ───────────────────────────────────────────────────────────────

function _basename(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Open a file in the side panel (idempotent per path+session). Focuses the tab
 * and expands the panel. When `live` is true the tab shows a streaming badge.
 * If the same path is already open, it's re-focused (and its live flag updated),
 * never duplicated.
 */
export function openDoc(doc: {
  path: string; name?: string; sessionId: string; live?: boolean;
  kind?: "file" | "genui"; spec?: unknown;
}): void {
  const existing = _state.docs.find(
    (d) => d.path === doc.path && d.sessionId === doc.sessionId,
  );
  const entry: OpenDoc = {
    path: doc.path,
    name: doc.name ?? _basename(doc.path),
    sessionId: doc.sessionId,
    live: doc.live ?? existing?.live,
    kind: doc.kind ?? existing?.kind ?? "file",
    spec: doc.spec ?? existing?.spec,
  };
  const docs = existing
    ? _state.docs.map((d) => (d === existing ? entry : d))
    : [..._state.docs, entry];
  _emit({ ..._state, open: true, docs, activePath: doc.path });
}

/**
 * Open an agent-pushed generative-UI tree as an immersive side-panel tab
 * (surface: "panel" in the emit_generative_ui spec). Same tab semantics as a
 * document — idempotent per id, focused on open — but rendered natively via
 * GenerativeUINode instead of fetching a workspace file.
 */
export function openGenUI(entry: {
  id: string; title?: string; sessionId: string; spec: unknown;
}): void {
  openDoc({
    path: `genui:${entry.id}`,
    name: entry.title || "Interactive view",
    sessionId: entry.sessionId,
    kind: "genui",
    spec: entry.spec,
  });
}

/** Mark (or clear) the live-streaming badge on an open tab. No-op if not open. */
export function setDocLive(sessionId: string, path: string, live: boolean): void {
  const idx = _state.docs.findIndex((d) => d.path === path && d.sessionId === sessionId);
  if (idx === -1) return;
  if (!!_state.docs[idx].live === live) return; // no change → stable snapshot
  const docs = _state.docs.slice();
  docs[idx] = { ...docs[idx], live };
  _emit({ ..._state, docs });
}

/** Close a tab. Picks a sensible neighbour as the new active tab. */
export function closeDoc(path: string): void {
  const idx = _state.docs.findIndex((d) => d.path === path);
  if (idx === -1) return;
  const docs = _state.docs.filter((d) => d.path !== path);
  let activePath = _state.activePath;
  if (_state.activePath === path) {
    const neighbour = docs[idx] ?? docs[idx - 1] ?? null;
    activePath = neighbour ? neighbour.path : null;
  }
  _emit({ ..._state, docs, activePath, open: docs.length > 0 ? _state.open : _state.open });
}

/** Focus an already-open tab (no-op if not open or already active). */
export function focusDoc(path: string): void {
  if (_state.activePath === path) {
    if (!_state.open) _emit({ ..._state, open: true });
    return;
  }
  if (!_state.docs.some((d) => d.path === path)) return;
  _emit({ ..._state, activePath: path, open: true });
}

/** Toggle / set the panel open state without changing tabs. */
export function setPanelOpen(open: boolean): void {
  if (_state.open === open) return;
  _emit({ ..._state, open });
}

export function togglePanel(): void {
  _emit({ ..._state, open: !_state.open });
}

/**
 * Drop every tab whose session isn't the active one. Called on session switch so
 * the panel never shows another session's documents (each session has its own
 * workspace). Returns silently when nothing changes (stable snapshot).
 */
export function pruneToSession(sessionId: string): void {
  const docs = _state.docs.filter((d) => d.sessionId === sessionId);
  if (docs.length === _state.docs.length) return;
  const activeStillOpen = docs.some((d) => d.path === _state.activePath);
  _emit({
    ..._state,
    docs,
    activePath: activeStillOpen ? _state.activePath : (docs[docs.length - 1]?.path ?? null),
  });
}

// ── Derived, stable-snapshot selector for agent context ─────────────────────
//
// AgentChat folds the open docs into the agent's system context so the agent
// knows what the user is looking at / editing. useSyncExternalStore needs a
// stable reference, so we cache the derived array keyed by a signature string.

let _ctxCache: OpenDoc[] | null = null;
let _ctxSig: string | null = null;

/** Stable list of docs open for `sessionId` (same ref until it actually changes). */
export function getOpenDocsForSession(sessionId: string): OpenDoc[] {
  const fresh = _state.docs.filter((d) => d.sessionId === sessionId);
  const sig = fresh.map((d) => d.path).join("\0");
  if (_ctxCache && _ctxSig === sig) return _ctxCache;
  _ctxCache = fresh;
  _ctxSig = sig;
  return fresh;
}
