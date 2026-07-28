import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  closeDoc,
  getState,
  hydratePanelWidth,
  openDoc,
  persistPanelWidth,
  setPanelWidth,
  subscribe,
} from "./sidePanelStore";

/** Minimal localStorage so the persistence paths are exercised in node. */
function stubStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    },
  });
  return map;
}

beforeEach(() => {
  setPanelWidth(DEFAULT_PANEL_WIDTH);
  getState().docs.forEach((d) => closeDoc(d.path));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("side panel width", () => {
  it("clamps to the bounds instead of letting the panel swallow the chat", () => {
    setPanelWidth(99_999);
    expect(getState().width).toBe(MAX_PANEL_WIDTH);
    setPanelWidth(10);
    expect(getState().width).toBe(MIN_PANEL_WIDTH);
  });

  it("ignores a non-finite width rather than rendering a broken panel", () => {
    setPanelWidth(Number.NaN);
    expect(getState().width).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("does not notify when the clamped width is unchanged", () => {
    // A drag fires pointermove every frame; once pinned at a bound, continuing
    // to drag must not re-render the panel (and the artifact iframe) per frame.
    setPanelWidth(MAX_PANEL_WIDTH);
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    setPanelWidth(MAX_PANEL_WIDTH + 200);
    setPanelWidth(MAX_PANEL_WIDTH + 900);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("notifies on a real change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    setPanelWidth(DEFAULT_PANEL_WIDTH + 40);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("returns a stable snapshot until something actually changes", () => {
    // useSyncExternalStore requires reference stability or React #185 fires.
    const before = getState();
    setPanelWidth(before.width);
    expect(getState()).toBe(before);
  });

  // Regression: openDoc built a fresh state object without spreading, so opening
  // any document silently reset a user's resized panel back to the default.
  it("survives opening and closing documents", () => {
    setPanelWidth(700);
    openDoc({ path: "outputs/a.md", sessionId: "s1" });
    expect(getState().width).toBe(700);
    openDoc({ path: "outputs/b.md", sessionId: "s1" });
    expect(getState().width).toBe(700);
    closeDoc("outputs/a.md");
    expect(getState().width).toBe(700);
  });

  it("round-trips through storage", () => {
    stubStorage();
    setPanelWidth(640);
    persistPanelWidth();
    setPanelWidth(DEFAULT_PANEL_WIDTH);
    hydratePanelWidth();
    expect(getState().width).toBe(640);
  });

  it("clamps a stored width that is out of bounds", () => {
    // e.g. saved on a wide monitor, reopened on a laptop after MAX changed.
    stubStorage({ "cc.sidePanel.width": "5000" });
    hydratePanelWidth();
    expect(getState().width).toBe(MAX_PANEL_WIDTH);
  });

  it("keeps the default when storage is empty or unreadable", () => {
    stubStorage();
    hydratePanelWidth();
    expect(getState().width).toBe(DEFAULT_PANEL_WIDTH);

    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("SecurityError"); },
        setItem: () => { throw new Error("SecurityError"); },
      },
    });
    expect(() => hydratePanelWidth()).not.toThrow();
    expect(() => persistPanelWidth()).not.toThrow();
    expect(getState().width).toBe(DEFAULT_PANEL_WIDTH);
  });
});
