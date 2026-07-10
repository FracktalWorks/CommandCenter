"use client";

/**
 * Procedural pixel-art placeholders for the observability office.
 *
 * These are GENERATED, deterministic-per-agent SVG sprites (no external assets,
 * CSP-safe, theme-agnostic, crisp). Each agent gets a unique little character at
 * a desk who works (monitor glows, gentle bob), sleeps (dimmed, Zzz), or errors
 * (red monitor, shake). A ConferenceScene shows agents collaborating at a table.
 *
 * ── Swapping in real sprites later ──────────────────────────────────────────
 * When you have hand-authored sprite art, pass `src` to <PixelWorker> (a PNG/
 * data-URI per agent+state) — it renders an <img> with the SAME animation
 * classes, so the desk/sleep/work animations keep working. Or replace
 * `workerRects()` with your own pixel map. The state → animation contract
 * (.pw.working / .pw.idle / .pw.error) is the only thing the page depends on.
 */

import React from "react";

// ── Deterministic palette per agent seed ─────────────────────────────────────
const SKIN = ["#f2c9a0", "#e0a878", "#c68642", "#8d5524", "#ffd9b3"];
const HAIR = ["#2b2b32", "#5a3a22", "#8a5a2b", "#c9a227", "#b0b0b8", "#e8e8ee", "#6a3ea1"];
const SHIRT = ["#3b82f6", "#10b981", "#8b5cf6", "#ef4444", "#f59e0b", "#14b8a6", "#ec4899", "#64748b"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function paletteFor(seed: string) {
  const h = hash(seed);
  return {
    skin: SKIN[h % SKIN.length],
    hair: HAIR[(h >> 3) % HAIR.length],
    shirt: SHIRT[(h >> 6) % SHIRT.length],
    hairStyle: (h >> 9) % 3,
  };
}

export type WorkerState = "working" | "idle" | "error";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  f: string;
}
const px = (x: number, y: number, w: number, h: number, f: string): Rect => ({ x, y, w, h, f });
const INK = "#0d1117";

/** Geometry for one character-at-a-desk, split into animatable groups. */
function workerRects(seed: string, state: WorkerState): {
  body: Rect[];
  screen: Rect[];
  zzz: Rect[];
} {
  const p = paletteFor(seed);
  const on = state === "working";
  const screenColor = state === "error" ? "#ef4444" : on ? "#7ee787" : "#243244";
  const { skin, hair, shirt, hairStyle } = p;

  const body: Rect[] = [];
  // chair back
  body.push(px(11, 9, 10, 13, "#2d333b"));
  // hair
  body.push(px(11, 4, 10, 4, hair));
  if (hairStyle === 0) body.push(px(11, 7, 1, 4, hair), px(20, 7, 1, 4, hair));
  else if (hairStyle === 1) body.push(px(10, 4, 1, 3, hair), px(21, 4, 1, 3, hair), px(12, 3, 8, 1, hair));
  else body.push(px(11, 7, 1, 2, hair), px(20, 7, 1, 2, hair), px(13, 3, 6, 1, hair));
  // head + ears
  body.push(px(12, 7, 8, 8, skin), px(11, 10, 1, 2, skin), px(20, 10, 1, 2, skin));
  // eyes
  if (state === "idle") body.push(px(14, 11, 2, 1, INK), px(17, 11, 2, 1, INK));
  else body.push(px(14, 10, 1, 2, INK), px(18, 10, 1, 2, INK));
  // mouth + neck
  body.push(px(15, 13, 2, 1, state === "idle" ? "#b06a5a" : "#8a4a3a"), px(15, 15, 2, 1, skin));
  // shirt + arms + hands
  body.push(px(10, 16, 12, 6, shirt), px(9, 17, 1, 4, shirt), px(22, 17, 1, 4, shirt));
  body.push(px(9, 20, 2, 1, skin), px(21, 20, 2, 1, skin));
  // desk + legs
  body.push(px(1, 21, 30, 4, "#8a6a45"), px(1, 25, 30, 1, "#6b4f30"), px(3, 25, 2, 4, "#5a4326"), px(27, 25, 2, 4, "#5a4326"));
  // monitor frame + stand + keyboard
  body.push(px(3, 13, 7, 7, INK), px(6, 20, 1, 1, INK), px(12, 21, 8, 1, "#30363d"));

  const screen: Rect[] = [px(4, 14, 5, 5, screenColor)];
  if (on) screen.push(px(4, 14, 5, 1, "#e6ffe9"));

  const zzz: Rect[] = [];
  if (state === "idle") {
    const g = "#8b949e";
    zzz.push(px(22, 6, 2, 1, g), px(23, 7, 1, 1, g), px(22, 8, 2, 1, g), px(25, 3, 3, 1, g), px(26, 4, 1, 1, g), px(25, 5, 3, 1, g));
  }
  return { body, screen, zzz };
}

function rects(list: Rect[]) {
  return list.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.f} />);
}

export function PixelWorker({
  seed,
  state,
  src,
  className = "",
}: {
  seed: string;
  state: WorkerState;
  /** Optional real sprite (PNG/data-URI). When set, renders an <img> instead of
   *  the generated SVG — same animation classes still apply. */
  src?: string;
  className?: string;
}) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={`${seed} ${state}`} className={`pw ${state} ${className}`} style={{ imageRendering: "pixelated", width: "100%" }} />
    );
  }
  const g = workerRects(seed, state);
  return (
    <svg viewBox="0 0 32 30" shapeRendering="crispEdges" className={`pw ${state} ${className}`} xmlns="http://www.w3.org/2000/svg">
      <g className="pw-body">{rects(g.body)}</g>
      <g className="pw-screen">{rects(g.screen)}</g>
      {g.zzz.length > 0 && <g className="pw-zzz">{rects(g.zzz)}</g>}
    </svg>
  );
}

// ── Conference table — multiple agents collaborating ────────────────────────

function head(seed: string, cx: number, cy: number, key: number) {
  const p = paletteFor(seed);
  return (
    <g key={key} className="pw-seat" style={{ ["--i" as string]: key }}>
      <rect x={cx - 3} y={cy - 4} width={6} height={3} fill={p.hair} />
      <rect x={cx - 3} y={cy - 1} width={6} height={4} fill={p.skin} />
      <rect x={cx - 2} y={cy} width={1} height={1} fill={INK} />
      <rect x={cx + 1} y={cy} width={1} height={1} fill={INK} />
    </g>
  );
}

export function ConferenceScene({ seeds }: { seeds: string[] }) {
  const top = seeds.slice(0, Math.ceil(seeds.length / 2));
  const bot = seeds.slice(Math.ceil(seeds.length / 2));
  const seatX = (i: number, n: number) => 30 + (n > 1 ? (i * 36) / (n - 1) : 18);
  return (
    <svg viewBox="0 0 96 54" shapeRendering="crispEdges" className="confsvg" xmlns="http://www.w3.org/2000/svg">
      {/* table */}
      <rect x={24} y={20} width={48} height={14} fill="#6b4f30" />
      <rect x={20} y={24} width={56} height={6} fill="#6b4f30" />
      <rect x={28} y={18} width={40} height={2} fill="#7d5c39" />
      <rect x={30} y={22} width={36} height={8} fill="#3a2c1a" />
      {top.map((sd, i) => head(sd, seatX(i, top.length), 14, i))}
      {bot.map((sd, i) => head(sd, seatX(i, bot.length), 40, i + 3))}
      {/* collaboration chatter */}
      <g className="pw-talk">
        <circle cx={46} cy={26} r={1.4} fill="#7ee787" />
        <circle cx={50} cy={26} r={1.4} fill="#58a6ff" />
        <circle cx={54} cy={26} r={1.4} fill="#d2a8ff" />
      </g>
    </svg>
  );
}

/** Keyframes + animation classes for the sprites. Injected once by the page. */
export const PIXEL_ART_STYLE = `
.pw{width:100%;height:auto;image-rendering:pixelated;overflow:visible;transform-box:view-box}
.pw.working{animation:pw-bob 1.1s steps(2) infinite}
.pw.idle{opacity:.72;filter:saturate(.6);animation:pw-breathe 3.4s ease-in-out infinite}
.pw.error{animation:pw-shake .42s steps(2) 3}
.pw-screen{transform-box:fill-box;transform-origin:center}
.pw.working .pw-screen{animation:pw-flick 1.3s steps(3) infinite}
.pw-zzz{transform-box:fill-box;transform-origin:center;animation:pw-float 2.6s ease-in-out infinite}
.pw-seat{transform-box:fill-box;transform-origin:center;animation:pw-nudge 2.2s ease-in-out infinite;animation-delay:calc(var(--i,0) * .3s)}
.pw-talk circle{animation:pw-blink 1s steps(2) infinite}
.pw-talk circle:nth-child(2){animation-delay:.15s}
.pw-talk circle:nth-child(3){animation-delay:.3s}
@keyframes pw-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3%)}}
@keyframes pw-breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(1.5%)}}
@keyframes pw-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4%)}75%{transform:translateX(4%)}}
@keyframes pw-flick{0%,100%{opacity:1}50%{opacity:.65}}
@keyframes pw-float{0%{opacity:0;transform:translate(0,0)}30%{opacity:1}100%{opacity:0;transform:translate(2px,-4px)}}
@keyframes pw-nudge{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}
@keyframes pw-blink{0%,100%{opacity:1}50%{opacity:.2}}
@media (prefers-reduced-motion: reduce){.pw,.pw-screen,.pw-zzz,.pw-seat,.pw-talk circle{animation:none}}
`;
