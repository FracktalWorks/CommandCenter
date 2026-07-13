"use client";

import React, { useEffect, useState } from "react";

import { CHARACTER_LIBRARY } from "@/app/observability/character-library.generated";

/** canonical agent name → assigned character libraryId (null = none set). */
export type AgentAvatarMap = Record<string, string | null | undefined>;

/**
 * Fetch the agent → avatar (libraryId) assignments once. Keyed by canonical
 * agent name; value is the assigned character id, or null when the agent has no
 * avatar set. Best-effort — returns {} on error (callers fall back to an icon).
 *
 * Source: GET /api/observability/avatars → { avatars: { name: { config: { libraryId } } } }
 * — the same store the Avatar picker in Agent Settings writes to.
 */
export function useAgentAvatars(): AgentAvatarMap {
  const [map, setMap] = useState<AgentAvatarMap>({});
  useEffect(() => {
    let alive = true;
    fetch("/api/observability/avatars")
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        const avatars = (data?.avatars ?? {}) as Record<
          string,
          { config?: { libraryId?: string | null } | null } | null
        >;
        const out: AgentAvatarMap = {};
        for (const [name, entry] of Object.entries(avatars)) {
          out[name] = entry?.config?.libraryId ?? null;
        }
        setMap(out);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return map;
}

/** Resolve the character id to render as, or null when no avatar is assigned. */
export function avatarCharacterId(libraryId?: string | null): string | null {
  return libraryId && CHARACTER_LIBRARY[libraryId] ? libraryId : null;
}

/**
 * Circular face + torso crop of an agent's assigned pixel-art avatar — reusable
 * anywhere the agent's icon/logo appears. Renders `fallback` (typically the
 * generic Lucide icon) when the agent has no avatar assigned.
 *
 * The source sprites are 124×124 standing figures with the head near the top,
 * so an oversized background (≈185%) positioned near the top shows only the
 * face + upper torso inside the circle; the legs fall outside the crop.
 * `focusX`/`focusY`/`zoom` are exposed so the framing can be nudged per surface.
 */
export function AgentAvatar({
  libraryId,
  size = 36,
  className = "",
  fallback = null,
  title,
  zoom = 185,
  focusX = 50,
  focusY = 16,
}: {
  libraryId?: string | null;
  size?: number;
  className?: string;
  fallback?: React.ReactNode;
  title?: string;
  /** background-size percentage — higher = tighter crop on the face. */
  zoom?: number;
  /** background-position X% (horizontal framing). */
  focusX?: number;
  /** background-position Y% (0 = top of head, higher = lower down the body). */
  focusY?: number;
}) {
  const charId = avatarCharacterId(libraryId);
  const portrait = charId ? CHARACTER_LIBRARY[charId]?.portrait : null;
  if (!portrait) return <>{fallback}</>;
  return (
    <div
      className={`shrink-0 overflow-hidden rounded-full border border-border bg-secondary ${className}`}
      style={{ width: size, height: size }}
      title={title}
      aria-label={title}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          backgroundImage: `url("${portrait}")`,
          backgroundRepeat: "no-repeat",
          backgroundSize: `${zoom}%`,
          backgroundPosition: `${focusX}% ${focusY}%`,
          imageRendering: "pixelated",
        }}
      />
    </div>
  );
}
