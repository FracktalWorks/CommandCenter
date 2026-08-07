"use client";

/**
 * Icon pack loading.
 *
 * Lucide is bundled with the app and always available. The Fluent and Material
 * packs are pruned Iconify collections (~70 KB each, built by
 * `scripts/build-icon-packs.mjs`) and are fetched only when a theme actually
 * asks for them — a member on the default theme never downloads either.
 *
 * Loading is a module-level side effect rather than React state because the
 * collections are global to Iconify: once registered they are available to
 * every `<Icon>` on the page, so per-component ownership would be a lie.
 * Components subscribe through `useIconPackReady` and re-render when a pack
 * lands, falling back to Lucide until then.
 */

import { useSyncExternalStore } from "react";
import { addCollection, type IconifyJSON } from "@iconify/react";
import type { IconPackId } from "./types";

type LoadState = "idle" | "loading" | "ready" | "failed";

const state: Record<IconPackId, LoadState> = {
  lucide: "ready",
  fluent: "idle",
  material: "idle",
};

const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

const loaders: Record<Exclude<IconPackId, "lucide">, () => Promise<{ default: unknown }>> = {
  fluent: () => import("./icon-data/fluent.json"),
  material: () => import("./icon-data/material.json"),
};

/**
 * Start loading a pack if it has not been started already. Safe to call on
 * every render; repeat calls for a pack already in flight are no-ops.
 */
export function ensureIconPack(pack: IconPackId): void {
  if (pack === "lucide" || state[pack] !== "idle") return;
  state[pack] = "loading";
  loaders[pack]()
    .then((mod) => {
      addCollection(mod.default as IconifyJSON);
      state[pack] = "ready";
    })
    .catch(() => {
      // A failed pack load is not fatal: `<Icon>` keeps rendering Lucide, so
      // the app stays usable with the wrong icon style rather than blank.
      state[pack] = "failed";
    })
    .finally(notify);
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/**
 * True when `pack`'s glyphs can be rendered. Always true for Lucide; for the
 * Iconify packs it flips once the collection has been registered.
 *
 * Returns false during server rendering so the markup React produces on the
 * server matches the client's first paint — the swap to themed glyphs happens
 * in a later commit, after hydration.
 */
export function useIconPackReady(pack: IconPackId): boolean {
  return useSyncExternalStore(
    subscribe,
    () => state[pack] === "ready",
    () => false,
  );
}

/** Current load state — exported for tests and diagnostics. */
export function iconPackState(pack: IconPackId): LoadState {
  return state[pack];
}
