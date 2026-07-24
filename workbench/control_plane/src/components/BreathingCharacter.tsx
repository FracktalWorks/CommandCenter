"use client";

/**
 * BreathingCharacter — the agent's pixel-art character, gently animated.
 *
 * Renders a character-library breathing spritesheet (same 4/9-frame loop the
 * observability office and the avatar picker use), so an agent's persona reads
 * as ALIVE wherever it appears — the new-session picker, the agent settings
 * panel, and any future identity surface. Falls back to the static portrait
 * when a character has no breathing sheet, and to `fallback` when the id
 * resolves to no character at all.
 *
 * The sprite frames carry a lot of transparent padding, so the sprite renders
 * ~1.8x the box and is clipped (overflow hidden) — the character reads much
 * bigger inside the same frame without the card growing.
 *
 * Styles are injected once into document.head (id-guarded) so any number of
 * instances share one <style>. Respects prefers-reduced-motion.
 */

import { useEffect } from "react";

import {
  CHARACTER_LIBRARY,
  type LibChar,
} from "@/app/observability/character-library.generated";

const STYLE_ID = "cc-breathing-character-style";
const STYLE_CSS = `
.cc-breathe-wrap { display:flex; align-items:center; justify-content:center; overflow:hidden; }
.cc-breathe { display:block; flex:0 0 auto; image-rendering:pixelated;
  background-repeat:no-repeat; background-position:0 0;
  background-size: calc(var(--n) * var(--w)) var(--w);
  animation: cc-breathe-play calc(var(--n) * .2s) steps(var(--n)) infinite; }
@keyframes cc-breathe-play { to { background-position-x: calc(-1 * var(--n) * var(--w)); } }
@media (prefers-reduced-motion: reduce){ .cc-breathe { animation: none; } }
`;

function ensureStyle(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLE_CSS;
  document.head.appendChild(el);
}

/** Resolve the character for an agent: its assigned library id first, then a
 *  namesake office character (every first-party agent ships one). */
export function characterForAgent(
  agentName: string,
  assignedLibraryId?: string | null,
): LibChar | null {
  if (assignedLibraryId && CHARACTER_LIBRARY[assignedLibraryId]) {
    return CHARACTER_LIBRARY[assignedLibraryId];
  }
  return CHARACTER_LIBRARY[agentName] ?? null;
}

export default function BreathingCharacter({
  libraryId,
  char,
  box,
  scale = 1.8,
  className,
  fallback = null,
}: {
  /** Character-library id (ignored when `char` is passed directly). */
  libraryId?: string | null;
  /** Pre-resolved character (e.g. from characterForAgent). */
  char?: LibChar | null;
  /** Rendered square size in px. */
  box: number;
  scale?: number;
  className?: string;
  fallback?: React.ReactNode;
}): React.ReactNode {
  useEffect(ensureStyle, []);
  const resolved: LibChar | null =
    char ?? (libraryId ? CHARACTER_LIBRARY[libraryId] ?? null : null);
  if (!resolved) return fallback;
  const sheet = resolved.breathing?.south;
  const frames = resolved.breathingFrames;
  const w = Math.round(box * scale);
  return (
    <span
      className={`cc-breathe-wrap ${className ?? ""}`}
      style={{ width: box, height: box }}
    >
      {sheet && frames ? (
        <span
          className="cc-breathe"
          style={{
            width: w,
            height: w,
            backgroundImage: `url(${sheet})`,
            "--n": frames,
            "--w": `${w}px`,
          } as React.CSSProperties}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolved.portrait}
          alt=""
          style={{ width: w, height: w, imageRendering: "pixelated" }}
        />
      )}
    </span>
  );
}
