"use client";

/**
 * Roomed, layered, configurable agent scenes for the observability office.
 *
 * Each agent is COMPOSED from layers (room → rug → chair → outfit → hands →
 * head → face → hair → accessory → desk props → desk) driven by an
 * `AvatarConfig`, and sits in a themed ROOM (not a floating box). Look is
 * derived semantically from the agent's role (coder / sales / planner / …) with
 * per-agent variation (skin, hair colour/style) from a name hash, so a brand-new
 * agent gets a fitting avatar with zero config — and any field can be overridden
 * once backend avatar config lands.
 *
 * ── Swap seam for real (e.g. Higgsfield) art ────────────────────────────────
 * This is procedural PLACEHOLDER art. The layer order + anchor grid here is the
 * contract: to use hand-authored/AI sprites, replace each layer's rects with an
 * <image href={dataUri}/> anchored to the same coordinates (see ASSET SPEC in
 * specs/observability_e2.md). States (working/idle/error) and the animation
 * classes (.sc-*) are the only thing the page depends on.
 */

import React from "react";

// ── Types ────────────────────────────────────────────────────────────────────

export type SceneState = "working" | "idle" | "error";

export interface RoomTheme {
  wall: string; wall2: string; floor: string; floor2: string; rug: string; rug2: string;
}
export interface AvatarConfig {
  skin: string;
  hair: { style: "spiky" | "bun" | "short" | "long"; color: string };
  outfit: { type: "hoodie" | "suit" | "sweater"; color: string; color2: string };
  accessory: "glasses" | "headset" | "beanie" | null;
  deskProps: string[];              // "mug" | "plant" | "papers" | "phone" | "dual-monitor"
  room: RoomTheme;
  wallProp: "window" | "board" | "whiteboard";
  screen: string; screen2: string;
  accentA: string; accentA2: string;
  desk: string; desk2: string;
}

// ── Palettes + deterministic per-agent variation ────────────────────────────

const SKIN = ["#f2c9a0", "#e0a878", "#c68642", "#8d5524", "#ffd9b3", "#e8b48a"];
const HAIR = ["#2b2b32", "#5a3a22", "#8a5a2b", "#c9a227", "#b0b0b8", "#e8e8ee", "#6a3ea1"];
const HAIR_STYLES: AvatarConfig["hair"]["style"][] = ["spiky", "bun", "short", "long"];
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const ROOMS: Record<string, RoomTheme> = {
  dev: { wall: "#241d33", wall2: "#191426", floor: "#2b2436", floor2: "#221b30", rug: "#3a2d52", rug2: "#463765" },
  sales: { wall: "#20304a", wall2: "#182338", floor: "#8a8f99", floor2: "#767b85", rug: "#2c5c8a", rug2: "#3a70a6" },
  planning: { wall: "#26332b", wall2: "#1c2721", floor: "#b7a888", floor2: "#a3947a", rug: "#6a8f5f", rug2: "#7ba86d" },
  neutral: { wall: "#2a2f3a", wall2: "#1f242e", floor: "#5a616e", floor2: "#4b515c", rug: "#3d4a5c", rug2: "#4b5b70" },
};

/** Role signature: the room / outfit / accessory / props that read as this job. */
interface Preset {
  room: RoomTheme; wallProp: AvatarConfig["wallProp"];
  outfit: AvatarConfig["outfit"]["type"]; outfitColor: string; outfitColor2: string;
  accessory: AvatarConfig["accessory"]; deskProps: string[];
  screen: string; screen2: string; accentA: string; accentA2: string;
  desk: string; desk2: string;
}
const PRESETS: Record<string, Preset> = {
  coder: { room: ROOMS.dev, wallProp: "window", outfit: "hoodie", outfitColor: "#33507a", outfitColor2: "#26406a", accessory: "headset", deskProps: ["dual-monitor", "mug", "papers"], screen: "#7ee787", screen2: "#58d977", accentA: "#ff8f3f", accentA2: "#ffb26b", desk: "#4a3a2a", desk2: "#3a2c1e" },
  sales: { room: ROOMS.sales, wallProp: "board", outfit: "suit", outfitColor: "#2b3340", outfitColor2: "#1f2530", accessory: "headset", deskProps: ["mug", "phone", "plant"], screen: "#58a6ff", screen2: "#79b8ff", accentA: "#e0b341", accentA2: "#f0c95a", desk: "#6b4f30", desk2: "#543d24" },
  planner: { room: ROOMS.planning, wallProp: "whiteboard", outfit: "sweater", outfitColor: "#c0563f", outfitColor2: "#a5462f", accessory: "glasses", deskProps: ["papers", "plant", "mug"], screen: "#d2a8ff", screen2: "#e2c4ff", accentA: "#8b5cf6", accentA2: "#a67cf0", desk: "#7d6a52", desk2: "#63533f" },
  triage: { room: ROOMS.sales, wallProp: "window", outfit: "hoodie", outfitColor: "#2f7d5f", outfitColor2: "#256a4f", accessory: null, deskProps: ["mug", "plant"], screen: "#58a6ff", screen2: "#79b8ff", accentA: "#10b981", accentA2: "#34d399", desk: "#6b4f30", desk2: "#543d24" },
  reconciler: { room: ROOMS.dev, wallProp: "board", outfit: "sweater", outfitColor: "#4a5568", outfitColor2: "#3a4252", accessory: "glasses", deskProps: ["papers", "mug"], screen: "#58a6ff", screen2: "#79b8ff", accentA: "#ef4444", accentA2: "#ff6b6b", desk: "#4a3a2a", desk2: "#3a2c1e" },
  orchestrator: { room: ROOMS.dev, wallProp: "board", outfit: "suit", outfitColor: "#3a2f52", outfitColor2: "#2c2440", accessory: "headset", deskProps: ["dual-monitor", "mug", "papers"], screen: "#7ee787", screen2: "#8fd3ff", accentA: "#d2a8ff", accentA2: "#e2c4ff", desk: "#4a3a2a", desk2: "#3a2c1e" },
  default: { room: ROOMS.neutral, wallProp: "board", outfit: "sweater", outfitColor: "#556070", outfitColor2: "#454e5c", accessory: null, deskProps: ["mug", "papers"], screen: "#58a6ff", screen2: "#79b8ff", accentA: "#8b949e", accentA2: "#a9b1bb", desk: "#5f5142", desk2: "#4b4032" },
};

/** Map an agent name to a role preset key by keyword. */
export function roleFor(name: string): keyof typeof PRESETS {
  const n = name.toLowerCase();
  if (/(orchestr)/.test(n)) return "orchestrator";
  if (/(cod|dev|apis|engineer|build)/.test(n)) return "coder";
  if (/(sales|biz|deal|crm|zoho)/.test(n)) return "sales";
  if (/(plan|strateg|project|gtd|task)/.test(n)) return "planner";
  if (/(triage|email|inbox|mail)/.test(n)) return "triage";
  if (/(reconcil|audit|ledger|finance)/.test(n)) return "reconciler";
  return "default";
}

/** Derive a full avatar for an agent — semantic role signature + per-agent
 *  variation. Pass `override` to pin specific fields (backend config later). */
export function deriveAvatar(name: string, override?: Partial<AvatarConfig>): AvatarConfig {
  const p = PRESETS[roleFor(name)];
  const h = hash(name);
  const base: AvatarConfig = {
    skin: SKIN[h % SKIN.length],
    hair: { style: HAIR_STYLES[(h >> 6) % HAIR_STYLES.length], color: HAIR[(h >> 3) % HAIR.length] },
    outfit: { type: p.outfit, color: p.outfitColor, color2: p.outfitColor2 },
    accessory: p.accessory,
    deskProps: p.deskProps,
    room: p.room,
    wallProp: p.wallProp,
    screen: p.screen, screen2: p.screen2,
    accentA: p.accentA, accentA2: p.accentA2,
    desk: p.desk, desk2: p.desk2,
  };
  return { ...base, ...override };
}

// ── Rect helper ──────────────────────────────────────────────────────────────

const OUT = "#17131f";
// Descriptor objects (not JSX) so keys are stable index-based at render time —
// a module-global counter would break hydration + restart animations each render.
type Desc =
  | { t: "r"; x: number; y: number; w: number; h: number; f: string; cls?: string }
  | { t: "g"; cls?: string; kids: Desc[] };
function r(x: number, y: number, w: number, h: number, f: string, cls?: string): Desc {
  return { t: "r", x, y, w, h, f, cls };
}

// ── Layers ───────────────────────────────────────────────────────────────────

function room(c: AvatarConfig): Desc[] {
  const o: Desc[] = [];
  o.push(r(0, 0, 64, 34, c.room.wall), r(0, 30, 64, 4, c.room.wall2));
  if (c.wallProp === "window") {
    o.push(r(40, 6, 18, 16, "#0e1526"), r(41, 7, 16, 14, "#2a4a6b"), r(41, 7, 16, 7, "#3d668c"),
      r(48, 7, 1, 14, "#0e1526"), r(41, 14, 16, 1, "#0e1526"), r(39, 5, 20, 1, c.room.wall2), r(39, 22, 20, 1, c.room.wall2));
  } else if (c.wallProp === "board") {
    o.push(r(40, 5, 20, 15, "#1d2733"), r(41, 6, 18, 13, "#243447"),
      r(43, 8, 7, 1, "#7ee787"), r(43, 11, 11, 1, "#58a6ff"), r(43, 14, 9, 1, "#d2a8ff"));
  } else {
    o.push(r(40, 5, 20, 15, "#e8edf2"), r(42, 7, 16, 2, "#c7d0da"), r(42, 10, 10, 1, "#f59e0b"),
      r(42, 12, 13, 1, "#8b949e"), r(42, 14, 8, 1, "#8b949e"));
  }
  o.push(r(0, 34, 64, 22, c.room.floor), r(0, 34, 64, 1, OUT));
  for (let x = 8; x < 64; x += 8) o.push(r(x, 35, 1, 21, c.room.floor2));
  o.push(r(0, 44, 64, 1, c.room.floor2), r(10, 40, 44, 14, c.room.rug), r(12, 42, 40, 10, c.room.rug2));
  return o;
}

function character(c: AvatarConfig, state: SceneState): Desc[] {
  const o: Desc[] = [];
  const { skin } = c;
  const oc = c.outfit.color, oc2 = c.outfit.color2;
  // chair + torso + outfit
  o.push(r(23, 14, 18, 20, "#2b2330"), r(24, 15, 16, 10, "#3a3040"), r(24, 22, 16, 12, OUT), r(25, 23, 14, 11, oc));
  if (c.outfit.type === "suit") o.push(r(31, 23, 2, 11, "#e8edf2"), r(31, 23, 2, 4, c.accentA), r(25, 23, 3, 11, "#2b3340"), r(37, 23, 3, 11, "#2b3340"));
  if (c.outfit.type === "hoodie") o.push(r(25, 23, 14, 2, oc2), r(24, 25, 2, 6, oc2), r(38, 25, 2, 6, oc2), r(30, 23, 4, 3, oc2));
  if (c.outfit.type === "sweater") o.push(r(25, 31, 14, 1, oc2), r(25, 23, 14, 1, oc2));
  // arms + hands (typing)
  o.push(r(24, 28, 2, 6, oc), r(38, 28, 2, 6, oc), r(25, 36, 4, 2, skin, "sc-hand-l"), r(35, 36, 4, 2, skin, "sc-hand-r"));
  // neck + head + ears
  o.push(r(29, 20, 6, 3, skin), r(27, 11, 10, 10, OUT), r(28, 12, 8, 8, skin), r(27, 15, 1, 2, skin), r(36, 15, 1, 2, skin));
  // eyes + mouth
  if (state === "idle") o.push(r(29, 16, 2, 1, OUT), r(33, 16, 2, 1, OUT));
  else o.push({ t: "g", cls: "sc-eyes", kids: [r(29, 15, 2, 2, OUT), r(33, 15, 2, 2, OUT)] });
  o.push(r(30, 18, 4, 1, "#9c5b4d"));
  // hair
  const hc = c.hair.color;
  if (c.hair.style === "spiky") o.push(r(27, 9, 10, 3, hc), r(28, 7, 2, 2, hc), r(31, 6, 2, 3, hc), r(34, 7, 2, 2, hc), r(27, 11, 1, 3, hc), r(36, 11, 1, 3, hc));
  else if (c.hair.style === "bun") o.push(r(27, 10, 10, 2, hc), r(30, 7, 4, 3, hc), r(27, 11, 1, 4, hc), r(36, 11, 1, 4, hc));
  else if (c.hair.style === "short") o.push(r(27, 10, 10, 2, hc), r(28, 9, 8, 1, hc));
  else o.push(r(27, 9, 10, 3, hc), r(26, 11, 2, 7, hc), r(36, 11, 2, 7, hc));
  // accessory
  if (c.accessory === "glasses") o.push(r(28, 15, 3, 3, "#0d1117"), r(33, 15, 3, 3, "#0d1117"), r(31, 16, 2, 1, "#0d1117"), r(29, 16, 1, 1, "#8fd3ff"), r(34, 16, 1, 1, "#8fd3ff"));
  if (c.accessory === "headset") o.push(r(26, 11, 1, 6, "#2b2330"), r(25, 15, 2, 3, c.accentA), r(27, 9, 10, 1, "#2b2330"), r(26, 18, 4, 1, "#2b2330"));
  if (c.accessory === "beanie") o.push(r(27, 8, 10, 4, c.accentA), r(27, 7, 10, 1, c.accentA2), r(26, 11, 12, 1, c.accentA2));
  // sleeping Zzz
  if (state === "idle") { const g = "#8b949e"; o.push(r(38, 8, 2, 1, g), r(39, 9, 1, 1, g), r(38, 10, 2, 1, g), r(41, 5, 3, 1, g), r(42, 6, 1, 1, g), r(41, 7, 3, 1, g)); }
  return o;
}

function desk(c: AvatarConfig, state: SceneState): Desc[] {
  const o: Desc[] = [];
  const on = state !== "idle";
  const screen = state === "error" ? "#ef4444" : on ? c.screen : "#243244";
  o.push(r(20, 20, 16, 12, OUT), r(21, 21, 14, 10, "#0d1117"), r(22, 22, 12, 8, screen));
  if (on) o.push(r(22, 22, 12, 1, "#eafff0", "sc-glow"), r(22, 24, 10, 1, c.screen2, "sc-glow"));
  o.push(r(27, 32, 2, 2, OUT));
  if (c.deskProps.includes("dual-monitor")) o.push(r(36, 22, 12, 10, OUT), r(37, 23, 10, 8, "#0d1117"), r(38, 24, 8, 6, screen));
  o.push(r(6, 38, 52, 6, c.desk), r(6, 44, 52, 1, c.desk2), r(9, 44, 3, 10, c.desk2), r(52, 44, 3, 10, c.desk2));
  o.push(r(24, 37, 16, 2, "#c7d0da"), r(25, 37, 14, 1, "#8b949e"));
  if (c.deskProps.includes("mug")) o.push(r(50, 33, 5, 5, c.accentA), r(55, 34, 1, 3, c.accentA), r(51, 34, 3, 1, "#fff"), r(51, 31, 3, 2, "#cfe8ff", "sc-steam"));
  if (c.deskProps.includes("plant")) o.push(r(9, 30, 6, 4, "#2f9e5f"), r(8, 28, 3, 3, "#3fbf74"), r(12, 27, 3, 4, "#3fbf74"), r(10, 34, 4, 4, "#7d5c39"));
  if (c.deskProps.includes("papers")) o.push(r(43, 35, 7, 4, "#e8edf2"), r(44, 36, 5, 1, "#8b949e"), r(44, 37, 4, 1, "#8b949e"));
  if (c.deskProps.includes("phone")) o.push(r(16, 34, 4, 5, OUT), r(16, 34, 4, 1, c.accentA));
  return o;
}

// ── Public component ─────────────────────────────────────────────────────────

export function AgentScene({
  name, state, config, className = "",
}: {
  name: string;
  state: SceneState;
  config?: AvatarConfig;
  className?: string;
}) {
  const c = config ?? deriveAvatar(name);
  const parts = [...room(c), ...character(c, state), ...desk(c, state)];
  const rect = (d: Extract<Desc, { t: "r" }>, key: React.Key) => (
    <rect key={key} x={d.x} y={d.y} width={d.w} height={d.h} fill={d.f} className={d.cls} />
  );
  return (
    <svg viewBox="0 0 64 56" shapeRendering="crispEdges" className={`sc-scene ${state} ${className}`}
      xmlns="http://www.w3.org/2000/svg">
      {parts.map((d, i) =>
        d.t === "g"
          ? <g key={i} className={d.cls}>{d.kids.map((k, j) => rect(k as Extract<Desc, { t: "r" }>, j))}</g>
          : rect(d, i),
      )}
    </svg>
  );
}

/** Keyframes + animation classes for the scenes. Injected once by the page. */
export const SCENE_STYLE = `
.sc-scene{width:100%;height:auto;image-rendering:pixelated;display:block;border-radius:8px;overflow:hidden}
.sc-scene.idle{filter:saturate(.6) brightness(.82)}
.sc-scene.error{animation:sc-shake .45s steps(2) 3}
.sc-hand-l{transform-box:fill-box;transform-origin:center;animation:sc-t1 .5s steps(2) infinite}
.sc-hand-r{transform-box:fill-box;transform-origin:center;animation:sc-t2 .5s steps(2) infinite}
.sc-eyes{transform-box:fill-box;transform-origin:center;animation:sc-blink 4s steps(1) infinite}
.sc-glow{animation:sc-flick 1.4s steps(3) infinite}
.sc-steam{transform-box:fill-box;animation:sc-steam 3s ease-in-out infinite}
.sc-scene.idle .sc-hand-l,.sc-scene.idle .sc-hand-r,.sc-scene.idle .sc-glow,.sc-scene.idle .sc-steam,.sc-scene.idle .sc-eyes{animation:none}
@keyframes sc-t1{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}
@keyframes sc-t2{0%,100%{transform:translateY(-1px)}50%{transform:translateY(0)}}
@keyframes sc-blink{0%,94%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}
@keyframes sc-flick{0%,100%{opacity:1}50%{opacity:.72}}
@keyframes sc-steam{0%{opacity:0;transform:translateY(0)}40%{opacity:.7}100%{opacity:0;transform:translateY(-4px)}}
@keyframes sc-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-2%)}75%{transform:translateX(2%)}}
@media (prefers-reduced-motion: reduce){.sc-hand-l,.sc-hand-r,.sc-eyes,.sc-glow,.sc-steam,.sc-scene.error{animation:none}}
`;
