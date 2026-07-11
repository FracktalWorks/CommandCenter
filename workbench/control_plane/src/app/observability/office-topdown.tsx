"use client";

/**
 * Top-down RPG office — every agent is a real Pixel Lab character SEATED at a desk
 * in one shared, tiled room. Working agents play the seated typing animation; idle
 * ones dim and doze; errors flash red. Sprites come from the pre-generated library
 * (office-cast.generated.ts / public/characters-seated) — selection only, no runtime
 * generation.
 *
 * The ROOM is self-scaling: the desk grid uses `auto-fill` so it reflows to any agent
 * count AND any viewport (2 columns on a phone → 6+ on a wide desktop) with no JS.
 * The floor is a seamless Pixel Lab tile (office-env.generated.ts) that repeats to
 * fill whatever size the room grows to; props are anchored to the room's corners and
 * wall so they stay correctly placed as it expands/contracts.
 */

import React from "react";

import { Building2, Coins } from "lucide-react";

import { OFFICE_CAST } from "./office-cast.generated";
import { OFFICE_ENV } from "./office-env.generated";
import { OFFICE_OBJECTS, type Dir } from "./office-objects.generated";
import { roleFor } from "./scene";

export type OfficeState = "working" | "idle" | "error";

interface OfficeAgent {
  name: string;
  description?: string;
  status?: string;
  source?: string | null;
}

// On-screen height (px) for each object type. Sprites share a 96px canvas, so a
// fixed height would make a side-table look as big as a bookshelf; these keep the
// relative scale faithful (and generally smaller so nothing reads "zoomed in").
const OBJ_H: Record<string, number> = {
  bookshelf: 66, "bookshelf-wide": 58, "shelf-files": 58,
  couch: 54, armchair: 54, beanbag: 48, "side-table": 40,
  "plant-tall": 76, "plant-palm": 72, "plant-monstera": 64,
  "plant-small": 46, "plant-cactus": 50, "plant-hanging": 40,
  "coffee-machine": 54, "water-cooler": 58, workstation: 52,
  "printer-3d": 60, "printer-3d-large": 68, "printer-office": 46,
  "filing-cabinet": 56, whiteboard: 60,
};

// Furniture scattered around the room's BORDER band (on the darker border tiles,
// hugging the walls) so the central floor stays clear for desks. Each piece uses
// the 8-direction sprite that faces INTO the room from its wall: top wall -> south
// (front), left wall -> east (faces right), right wall -> west (faces left),
// bottom -> north / diagonals. Coords are px/%, anchored to the floor edges.
// Missing objects (not yet generated) are skipped, so this list can name any piece.
type Placed = { obj: string; dir: Dir; css: React.CSSProperties };
// Grouped into wall-hugging CLUSTERS (a library, a print/workstation corner, a
// lounge, a kitchen, and two plant groves) rather than evenly spread. Sprites are
// pre-cropped to content (crop_objects.py) so a 0-2px edge offset sits FLUSH against
// the wall. Left/right clusters use calc(%±px) so members stay a fixed distance apart
// (tight) while the cluster stays centered as the room grows.
const DECOR: Placed[] = [
  // TOP-LEFT — library nook (front-facing, flush to the top wall)
  { obj: "bookshelf", dir: "south", css: { top: 2, left: 6 } },
  { obj: "bookshelf-wide", dir: "south", css: { top: 6, left: 62 } },
  { obj: "shelf-files", dir: "south", css: { top: 4, left: 124 } },
  { obj: "whiteboard", dir: "south", css: { top: 6, left: 186 } },
  // TOP-RIGHT — 3D-print & workstation corner
  { obj: "printer-3d-large", dir: "south", css: { top: 2, right: 150 } },
  { obj: "printer-3d", dir: "south", css: { top: 4, right: 100 } },
  { obj: "workstation", dir: "south", css: { top: 4, right: 48 } },
  { obj: "plant-palm", dir: "south", css: { top: -2, right: 2 } },
  // LEFT WALL — lounge cluster (faces right), centered vertically
  { obj: "couch", dir: "east", css: { left: 0, top: "calc(45% - 46px)" } },
  { obj: "side-table", dir: "east", css: { left: 44, top: "calc(45% - 8px)" } },
  { obj: "armchair", dir: "east", css: { left: 2, top: "calc(45% + 40px)" } },
  // RIGHT WALL — kitchen / supply cluster (faces left)
  { obj: "coffee-machine", dir: "west", css: { right: 2, top: "calc(44% - 62px)" } },
  { obj: "water-cooler", dir: "west", css: { right: 6, top: "calc(44% - 14px)" } },
  { obj: "printer-office", dir: "west", css: { right: 2, top: "calc(44% + 32px)" } },
  { obj: "filing-cabinet", dir: "west", css: { right: 0, top: "calc(44% + 78px)" } },
  // BOTTOM-LEFT — chill nook + greenery
  { obj: "beanbag", dir: "north-east", css: { bottom: 2, left: 12 } },
  { obj: "plant-cactus", dir: "north", css: { bottom: 8, left: 60 } },
  { obj: "plant-monstera", dir: "north", css: { bottom: 2, left: 100 } },
  // BOTTOM-RIGHT — plant grove
  { obj: "plant-tall", dir: "north-west", css: { bottom: 0, right: 12 } },
  { obj: "plant-small", dir: "north", css: { bottom: 6, right: 50 } },
  { obj: "plant-hanging", dir: "north-east", css: { bottom: 2, right: 88 } },
];

/** Map an agent to a seated-character key: exact match wins, else its role's. */
const ROLE_TO_CHAR: Record<string, string> = {
  orchestrator: "orchestrator",
  coder: "apis-config",
  sales: "sales",
  planner: "task-manager",
  triage: "email-assistant",
  reconciler: "reconciler",
  default: "strategy",
};
export function characterFor(name: string): string {
  if (OFFICE_CAST[name]) return name;
  return ROLE_TO_CHAR[roleFor(name)] ?? "strategy";
}

// A small potted plant tucked beside a desk (front-facing sprite), used to green up
// the desk grid. Rotates through the small-plant variants so the room isn't uniform.
const DESK_PLANTS = ["plant-small", "plant-cactus", "plant-monstera", "plant-hanging"];

function Seat({
  agent,
  state,
  onOpen,
  plant,
}: {
  agent: OfficeAgent;
  state: OfficeState;
  onOpen: (name: string) => void;
  plant?: string | null;
}) {
  const key = characterFor(agent.name);
  const c = OFFICE_CAST[key];
  // Working agents play the seated TYPING animation (custom v3 — keeps the seated
  // pose). Idle/error use the static seated sprite with CSS breathe/shake. (The
  // breathing-idle TEMPLATE animates a standing skeleton, so it isn't used.)
  const playTyping = state === "working" && Boolean(c?.working && c?.workingFrames);
  return (
    <button
      onClick={() => onOpen(agent.name)}
      className={`oc-seat oc-${state}`}
      title={agent.description || agent.name}
    >
      <div className="oc-figure">
        {playTyping ? (
          <span
            className="oc-anim"
            style={{ "--sheet": `url(${c.working})`, "--n": c.workingFrames } as React.CSSProperties}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="oc-static" src={c?.seated} alt={agent.name} />
        )}
        {state === "idle" && <span className="oc-zzz">z</span>}
        {state === "working" && <span className="oc-ping" />}
        {plant && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="oc-seat-plant" src={plant} alt="" aria-hidden />
        )}
      </div>
      <div className="oc-plate">
        <span className="oc-name">{agent.name}</span>
        <span className={`oc-pill oc-${state}`}>{state === "idle" ? "sleeping" : state}</span>
      </div>
    </button>
  );
}

/**
 * A conference room that spawns dynamically when 2+ agents collaborate: a smaller
 * room sharing the office aesthetic (same floor/wall tiles), with the collaborating
 * agents seated together across a shared conference table. No loose chairs — each
 * agent brings their own seated pose, and the table crosses their fronts so it reads
 * as a real meeting. These render as separate cards below the office, not on the floor.
 */
function ConferenceRoom({
  members,
  stateFor,
  onOpen,
}: {
  members: OfficeAgent[];
  stateFor: (a: OfficeAgent) => OfficeState;
  onOpen: (name: string) => void;
}) {
  return (
    <div className="oc-cr">
      <div className="oc-cr-wall">
        <span className="oc-cr-sign">{members.map((m) => m.name).join("  +  ")}</span>
      </div>
      <div className="oc-cr-floor">
        <div className="oc-cr-seats">
          {members.map((a) => {
            const c = OFFICE_CAST[characterFor(a.name)];
            const st = stateFor(a);
            const playTyping = st === "working" && Boolean(c?.working && c?.workingFrames);
            return (
              <button
                key={a.name}
                className={`oc-cr-fig oc-${st}`}
                onClick={() => onOpen(a.name)}
                title={a.description || a.name}
              >
                {playTyping ? (
                  <span
                    className="oc-anim"
                    style={
                      {
                        "--sheet": `url(${c.working})`,
                        "--n": c.workingFrames,
                        "--w": "94px",
                      } as React.CSSProperties
                    }
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="oc-static" src={c?.seated} alt={a.name} />
                )}
              </button>
            );
          })}
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="oc-cr-table" src="/office-props/conference-table.png" alt="" aria-hidden />
      </div>
    </div>
  );
}

export function TopDownOffice({
  roster,
  hotAgents,
  todayCost,
  fmtCost,
  onOpen,
}: {
  roster: OfficeAgent[];
  hotAgents: Set<string>;
  todayCost: number;
  fmtCost: (n?: number | null) => string;
  onOpen: (name: string) => void;
}) {
  const stateOf = (a: OfficeAgent): OfficeState => {
    if (a.status === "error") return "error";
    if (a.status === "working" || hotAgents.has(a.name)) return "working";
    return "idle";
  };
  const workingCount = roster.filter((a) => stateOf(a) === "working").length;

  // Collaborations → conference rooms. When 2+ agents work concurrently they pair up
  // (~2-3 per room) and are shown meeting in a separate conference-room card instead
  // of at their desks; nothing shows when nobody is collaborating. (A real backend
  // collaboration signal can replace this heuristic later.)
  const workingAgents = roster
    .filter((a) => stateOf(a) === "working")
    .sort((a, b) => a.name.localeCompare(b.name));
  const collabs: OfficeAgent[][] = [];
  if (workingAgents.length >= 2) {
    for (let i = 0; i < workingAgents.length; i += 2) collabs.push(workingAgents.slice(i, i + 2));
    const last = collabs[collabs.length - 1];
    if (collabs.length > 1 && last.length === 1) collabs[collabs.length - 2].push(collabs.pop()![0]);
  }
  // Agents in a conference leave their desk; only the rest stay in the desk grid.
  const conferencing = new Set(collabs.flat().map((a) => a.name));
  const deskAgents = roster.filter((a) => !conferencing.has(a.name));

  // Seamless generated floor tile (repeats to fill any room size); undefined until
  // the Pixel Lab tileset is built, in which case CSS falls back to a procedural floor.
  const roomStyle = OFFICE_ENV.floor
    ? ({
        "--oc-floor": `url(${OFFICE_ENV.floor})`,
        "--oc-floor-bg": OFFICE_ENV.floorBg ?? "auto",
        ...(OFFICE_ENV.wall
          ? { "--oc-wall": `url(${OFFICE_ENV.wall})`, "--oc-wall-bg": OFFICE_ENV.wallBg ?? "auto" }
          : {}),
        ...(OFFICE_ENV.lane
          ? { "--oc-lane": `url(${OFFICE_ENV.lane})`, "--oc-lane-bg": OFFICE_ENV.laneBg ?? "auto" }
          : {}),
      } as React.CSSProperties)
    : undefined;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="oc-mono text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Building2 size={13} /> The Office · {workingCount}/{roster.length} at work
        </div>
        <div className="oc-mono text-[11px] text-emerald-500 flex items-center gap-1">
          <Coins size={12} /> Today {fmtCost(todayCost)}
        </div>
      </div>
      {roster.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-center gap-2">
          <Building2 size={30} className="text-muted-foreground/50" />
          <p className="oc-mono text-sm text-muted-foreground">No agents registered yet.</p>
        </div>
      ) : (
        <div className="oc-office" style={roomStyle}>
          <div className="oc-room">
          <div className="oc-wall">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="oc-wallboard" src="/office-props/whiteboard.png" alt="" aria-hidden />
            <span className="oc-sign">THE OFFICE</span>
          </div>
          <div className="oc-floor">
            {DECOR.map((it, i) => {
              const src = OFFICE_OBJECTS[it.obj]?.[it.dir];
              if (!src) return null;
              const wall =
                it.css.left != null && typeof it.css.top === "string"
                  ? "left"
                  : it.css.right != null && typeof it.css.top === "string"
                    ? "right"
                    : it.css.bottom != null
                      ? "bottom"
                      : "top";
              return (
                <img
                  key={`${it.obj}-${i}`}
                  className={`oc-decor oc-w-${wall}`}
                  style={{ ...it.css, height: OBJ_H[it.obj] ?? 62 }}
                  src={src}
                  alt=""
                  aria-hidden
                  // eslint-disable-next-line @next/next/no-img-element
                />
              );
            })}
            <div className="oc-grid">
              {deskAgents.map((a, i) => {
                // Green up ~every 3rd desk with a small plant (variant rotates).
                const plantKey = i % 3 === 1 ? DESK_PLANTS[(i >> 1) % DESK_PLANTS.length] : null;
                const plant = plantKey ? OFFICE_OBJECTS[plantKey]?.south ?? null : null;
                return (
                  <Seat key={a.name} agent={a} state={stateOf(a)} onOpen={onOpen} plant={plant} />
                );
              })}
            </div>
          </div>
          </div>
          {collabs.length > 0 && (
            <div className="oc-confs">
              <div className="oc-confs-head">
                <Building2 size={12} /> {collabs.length === 1 ? "Conference room" : "Conference rooms"} ·{" "}
                {collabs.length} in session
              </div>
              <div className="oc-confs-grid">
                {collabs.map((members, i) => (
                  <ConferenceRoom
                    key={members.map((m) => m.name).join("|") || `cr-${i}`}
                    members={members}
                    stateFor={stateOf}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Injected once by the page. */
export const TOPDOWN_STYLE = `
.oc-mono { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; letter-spacing:.02em; }

/* Office wrapper — carries the shared floor/wall CSS vars so both the main room and
   the conference-room cards inherit the same tileset. */
.oc-office { display:block; }

/* Outer room = the walls. Bright startup-office palette (light wood + beige). */
.oc-room {
  position:relative; border-radius:16px; overflow:hidden;
  background:linear-gradient(#efe9dd,#e6ddcd);
  border:5px solid #cbbfa4;
  box-shadow: inset 0 0 0 3px #f5f0e4, 0 10px 30px rgba(0,0,0,.28);
}
/* Top wall band — holds the mounted whiteboard + room sign. */
.oc-wall {
  position:relative; height:56px; z-index:3;
  background:
    linear-gradient(rgba(255,255,255,.22), rgba(0,0,0,.10)),
    var(--oc-wall, linear-gradient(#e7dbc2,#d7c7a6));
  background-size: cover, var(--oc-wall-bg,auto);
  background-repeat: no-repeat, repeat;
  image-rendering:pixelated;
  border-bottom:3px solid #b6a67f;
  display:flex; align-items:center; gap:14px; padding:0 18px;
  box-shadow: inset 0 -6px 12px rgba(0,0,0,.10);
}
.oc-wallboard { height:40px; image-rendering:pixelated; filter:drop-shadow(0 2px 2px rgba(0,0,0,.28)); }
.oc-sign { font-family:ui-monospace,monospace; font-size:12px; letter-spacing:.28em;
  color:#6f5f3c; text-shadow:0 1px 0 rgba(255,255,255,.5); }

/* Floor — the darker lane tile frames the whole office as a BORDER; an inset
   ::before field carries the main floor tile. */
.oc-floor {
  position:relative; padding:58px 92px 56px;
  background-color:#cbb89a;
  background-image: var(--oc-lane, none);
  background-size: var(--oc-lane-bg, auto);
  background-repeat: repeat;
  image-rendering:pixelated;
  box-shadow: inset 0 14px 26px rgba(0,0,0,.08), inset 0 -12px 22px rgba(0,0,0,.06);
}
.oc-floor::before {
  content:''; position:absolute; inset:34px; z-index:0; pointer-events:none;
  background-image: var(--oc-floor, none);
  background-size: var(--oc-floor-bg, auto);
  background-repeat: repeat; image-rendering:pixelated; border-radius:5px;
  box-shadow: inset 0 0 0 2px rgba(0,0,0,.10), 0 0 0 1px rgba(255,255,255,.10),
    inset 0 12px 22px rgba(0,0,0,.05);
}

/* Directional furniture scattered around the room's border. Each faces into the
   room via its 8-direction sprite; height comes from the inline OBJ_H map so relative
   scale stays faithful. Left/right-wall pieces are vertically centered on their %
   anchor. Anchored to the floor edges so they hold at any room size. */
.oc-decor { position:absolute; z-index:1; image-rendering:pixelated;
  filter:drop-shadow(0 4px 3px rgba(0,0,0,.30)); pointer-events:none; }
.oc-w-left, .oc-w-right { transform:translateY(-50%); }
/* small potted plant tucked beside a desk to green up the grid */
.oc-seat-plant { position:absolute; right:2px; bottom:12px; height:38px; z-index:2;
  image-rendering:pixelated; filter:drop-shadow(0 3px 2px rgba(0,0,0,.45)); }

/* Conference rooms — separate cards below the office that spawn dynamically when
   2+ agents collaborate. Each is a smaller room sharing the office tiles/walls, with
   the collaborating agents seated together across a shared table. */
.oc-confs { margin-top:18px; }
.oc-confs-head { font-family:ui-monospace,monospace; font-size:11px; letter-spacing:.04em;
  text-transform:uppercase; color:#8a7c5c; display:flex; align-items:center; gap:6px;
  margin:0 2px 8px; }
.oc-confs-grid { display:flex; flex-wrap:wrap; gap:16px; }
.oc-cr { width:min(360px, 100%); flex:1 1 300px; max-width:420px; border-radius:14px;
  overflow:hidden; border:4px solid #cbbfa4;
  box-shadow: inset 0 0 0 2px #f5f0e4, 0 8px 22px rgba(0,0,0,.24);
  background:linear-gradient(#efe9dd,#e6ddcd); }
.oc-cr-wall { position:relative; z-index:2; height:30px; display:flex; align-items:center;
  padding:0 12px;
  background: linear-gradient(rgba(255,255,255,.22), rgba(0,0,0,.10)),
    var(--oc-wall, linear-gradient(#e7dbc2,#d7c7a6));
  background-size: cover, var(--oc-wall-bg,auto); background-repeat:no-repeat, repeat;
  image-rendering:pixelated; border-bottom:3px solid #b6a67f; }
.oc-cr-sign { font-family:ui-monospace,monospace; font-size:10px; letter-spacing:.12em;
  text-transform:uppercase; color:#5f5030; text-shadow:0 1px 0 rgba(255,255,255,.5);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.oc-cr-floor { position:relative; height:150px; overflow:hidden;
  background-color:#cbb89a; background-image: var(--oc-lane, none);
  background-size: var(--oc-lane-bg, auto); background-repeat:repeat; image-rendering:pixelated; }
.oc-cr-floor::before { content:''; position:absolute; inset:10px; z-index:0; pointer-events:none;
  background-image: var(--oc-floor, none); background-size: var(--oc-floor-bg, auto);
  background-repeat:repeat; image-rendering:pixelated; border-radius:4px;
  box-shadow: inset 0 0 0 2px rgba(0,0,0,.10), inset 0 10px 18px rgba(0,0,0,.05); }
/* the agents, seated in a row and meeting */
.oc-cr-seats { position:absolute; left:0; right:0; top:16px; z-index:1;
  display:flex; justify-content:center; align-items:flex-end; gap:0; }
.oc-cr-fig { position:relative; background:none; border:none; cursor:pointer; padding:0;
  margin:0 -4px; line-height:0; }
.oc-cr-fig .oc-static { height:94px; }
.oc-cr-fig:hover { transform:translateY(-3px); transition:transform .15s; z-index:2; }
/* the shared table (cropped to content) crossing the agents' fronts so it reads as
   ONE meeting table hiding their individual desks */
.oc-cr-table { position:absolute; left:50%; bottom:12px; transform:translateX(-50%);
  z-index:2; width:min(300px, 86%); image-rendering:pixelated;
  filter:drop-shadow(0 5px 5px rgba(0,0,0,.30)); }

/* Desk grid: auto-fill => reflows to agent count AND viewport with no JS. Tighter
   cells + gap pull the agents' desks closer together. */
.oc-grid { position:relative; z-index:2;
  display:grid; grid-template-columns:repeat(auto-fill, minmax(126px, 1fr));
  gap:4px 6px; justify-items:center; }

.oc-seat { position:relative; display:flex; flex-direction:column; align-items:center;
  background:none; border:none; cursor:pointer; padding:4px 0; width:100%; }
.oc-figure { position:relative; height:128px; display:flex; align-items:flex-end; justify-content:center; }
.oc-static, .oc-anim { image-rendering:pixelated; filter:drop-shadow(0 5px 4px rgba(0,0,0,.55)); }
.oc-static { height:128px; }
/* animated sprite: the seated typing spritesheet (N frames wide) played via steps */
.oc-anim { --w:128px; display:block; width:var(--w); height:var(--w);
  background-image:var(--sheet); background-repeat:no-repeat;
  background-size:calc(var(--n) * var(--w)) var(--w); background-position:0 0;
  animation: oc-play calc(var(--n) * .12s) steps(var(--n)) infinite; }
.oc-idle .oc-static { animation: oc-breathe 3.4s ease-in-out infinite; }
.oc-working .oc-static { animation: oc-bob .8s steps(2) infinite; }
.oc-idle .oc-figure { filter:grayscale(.5) brightness(.72); }
.oc-error .oc-anim, .oc-error .oc-static { animation: oc-shake .4s steps(2) 4; }
.oc-seat:hover .oc-figure { transform:translateY(-3px); transition:transform .15s; }
.oc-zzz { position:absolute; top:2px; right:24px; color:#6b7280; font-size:13px; text-shadow:0 1px 1px rgba(255,255,255,.6); animation: oc-zf 2.6s ease-in-out infinite; z-index:3; }
.oc-ping { position:absolute; top:14px; right:26px; width:7px; height:7px; border-radius:50%; background:#58a6ff; box-shadow:0 0 8px #58a6ff; animation: oc-pl 1.2s steps(2) infinite; z-index:3; }
.oc-plate { margin-top:-4px; text-align:center; z-index:3; }
.oc-name { display:block; font-size:12px; color:#2c2a24; font-weight:700; text-shadow:0 1px 2px rgba(255,255,255,.75); max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.oc-pill { display:inline-block; margin-top:2px; font-size:9px; text-transform:uppercase; padding:1px 6px; border-radius:5px; border:1px solid; font-family:ui-monospace,monospace; background:rgba(255,255,255,.55); }
.oc-pill.oc-working { color:#a76a06; border-color:#e0a13066; }
.oc-pill.oc-idle { color:#5f6672; border-color:#5f667255; }
.oc-pill.oc-error { color:#c23b3b; border-color:#e06b6b77; }

/* Compact the room on small screens: smaller sprites, tighter grid, fewer props. */
@media (max-width:560px){
  .oc-grid { grid-template-columns:repeat(auto-fill, minmax(112px, 1fr)); gap:4px 6px; }
  .oc-figure { height:104px; }
  .oc-static { height:104px; }
  .oc-anim { --w:104px; }
  .oc-floor { padding:40px 18px 40px; }
  .oc-floor::before { inset:14px; }
  /* the side gutters collapse on mobile, so drop the left/right-wall furniture and
     shrink the rest; inline heights need !important to be capped here. */
  .oc-w-left, .oc-w-right { display:none; }
  .oc-decor { height:44px !important; }
  .oc-seat-plant { height:30px; }
  .oc-sign { display:none; }
}

@keyframes oc-play { to { background-position-x: calc(-1 * var(--n) * var(--w)); } }
@keyframes oc-bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-3px)} }
@keyframes oc-breathe { 0%,100%{transform:translateY(0) scale(1)} 50%{transform:translateY(1px) scale(.994)} }
@keyframes oc-shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-3px)} 75%{transform:translateX(3px)} }
@keyframes oc-zf { 0%{opacity:0;transform:translateY(0)} 40%{opacity:.85} 100%{opacity:0;transform:translateY(-8px)} }
@keyframes oc-pl { 0%,100%{opacity:1} 50%{opacity:.3} }
@media (prefers-reduced-motion: reduce){ .oc-anim,.oc-static,.oc-zzz,.oc-ping { animation:none !important; } }
`;
