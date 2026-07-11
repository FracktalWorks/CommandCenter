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
  bookshelf: 64, "bookshelf-wide": 58, "shelf-files": 56,
  couch: 54, armchair: 54, beanbag: 46, "side-table": 40,
  "plant-tall": 74, "plant-palm": 70, "plant-monstera": 62,
  "plant-small": 44, "plant-cactus": 48, "plant-hanging": 40,
  "coffee-machine": 52, "water-cooler": 58, workstation: 50,
  "printer-3d": 58, "printer-3d-large": 66, "printer-office": 46,
  "filing-cabinet": 56, whiteboard: 58,
  // equipment-on-a-surface + back-wall fixtures
  "desk-computer": 58, "table-plant": 54, "counter-coffee": 62,
  "wall-clock": 40, "tv-screen": 42, "notice-board": 44, blackboard: 44,
};

// Furniture is grouped into wall-hugging CLUSTERS, each rendered as a flex box so its
// members auto-space with a fixed gap (no manual overlap math) and sit on a common
// baseline. Sprites are pre-cropped to content (crop_objects.py) so the flex box sits
// FLUSH against its wall. Top/bottom clusters are horizontal rows; left/right clusters
// are vertical columns centered on the wall. Each item faces sensibly for its wall:
// top -> south (front), left -> east (faces right), right -> west (faces left), round
// tables use south (a round table reads the same from any side, front is cleanest),
// bottom -> north / diagonals. Missing objects (not yet generated) are skipped.
type ClItem = { obj: string; dir: Dir };
type Cluster = { id: string; cls: string; items: ClItem[] };
const CLUSTERS: Cluster[] = [
  // TOP-LEFT — library
  {
    id: "library",
    cls: "oc-cl-tl",
    items: [
      { obj: "bookshelf", dir: "south" },
      { obj: "bookshelf-wide", dir: "south" },
      { obj: "shelf-files", dir: "south" },
    ],
  },
  // TOP-RIGHT — 3D-print & workstation corner (computer sits ON a desk)
  {
    id: "printlab",
    cls: "oc-cl-tr",
    items: [
      { obj: "desk-computer", dir: "south" },
      { obj: "printer-3d", dir: "south" },
      { obj: "printer-3d-large", dir: "south" },
    ],
  },
  // LEFT WALL — lounge (couch + round coffee table + armchair)
  {
    id: "lounge",
    cls: "oc-cl-lm",
    items: [
      { obj: "couch", dir: "east" },
      { obj: "side-table", dir: "south" },
      { obj: "armchair", dir: "east" },
    ],
  },
  // RIGHT WALL — kitchen / supply (coffee machine sits ON a counter)
  {
    id: "kitchen",
    cls: "oc-cl-rm",
    items: [
      { obj: "counter-coffee", dir: "south" },
      { obj: "water-cooler", dir: "west" },
      { obj: "printer-office", dir: "west" },
      { obj: "filing-cabinet", dir: "west" },
    ],
  },
  // BOTTOM-LEFT — chill nook + greenery (plant sits ON a table)
  {
    id: "grove-l",
    cls: "oc-cl-bl",
    items: [
      { obj: "beanbag", dir: "north-east" },
      { obj: "plant-cactus", dir: "north" },
      { obj: "table-plant", dir: "south" },
      { obj: "plant-monstera", dir: "north" },
    ],
  },
  // BOTTOM-RIGHT — plant grove
  {
    id: "grove-r",
    cls: "oc-cl-br",
    items: [
      { obj: "plant-tall", dir: "north-west" },
      { obj: "plant-palm", dir: "north" },
      { obj: "plant-small", dir: "north" },
      { obj: "plant-hanging", dir: "north-east" },
    ],
  },
];

// Back-wall mounted fixtures (front-facing), laid along the top wall band.
const WALL_FIXTURES: ClItem[] = [
  { obj: "blackboard", dir: "south" },
  { obj: "notice-board", dir: "south" },
  { obj: "tv-screen", dir: "south" },
  { obj: "wall-clock", dir: "south" },
];
// A couple of fixtures mounted on the conference-room wall too.
const CR_FIXTURES = ["tv-screen", "wall-clock"];

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
        <div className="oc-cr-fix">
          {CR_FIXTURES.map((obj) => {
            const src = OFFICE_OBJECTS[obj]?.south;
            if (!src) return null;
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={obj} className={`oc-cr-fiximg oc-fix-${obj}`} src={src} alt="" aria-hidden />
            );
          })}
        </div>
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
  // Agents are not mutually exclusive: every agent always keeps its desk in the office
  // AND also appears in a conference room while collaborating (multiple instances).

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
            <span className="oc-sign">THE OFFICE</span>
            <div className="oc-wall-fix">
              {WALL_FIXTURES.map((it) => {
                const src = OFFICE_OBJECTS[it.obj]?.[it.dir];
                if (!src) return null;
                return (
                  <span
                    key={it.obj}
                    className={`oc-fix oc-fix-${it.obj}`}
                    style={{ height: OBJ_H[it.obj] ?? 40 }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="" aria-hidden style={{ height: OBJ_H[it.obj] ?? 40 }} />
                  </span>
                );
              })}
            </div>
          </div>
          <div className="oc-floor">
            {CLUSTERS.map((cl) => (
              <div key={cl.id} className={`oc-cluster ${cl.cls}`}>
                {cl.items.map((it, i) => {
                  const src = OFFICE_OBJECTS[it.obj]?.[it.dir];
                  if (!src) return null;
                  return (
                    <img
                      key={`${it.obj}-${i}`}
                      className="oc-obj"
                      style={{ height: OBJ_H[it.obj] ?? 58 }}
                      src={src}
                      alt=""
                      aria-hidden
                      // eslint-disable-next-line @next/next/no-img-element
                    />
                  );
                })}
              </div>
            ))}
            <div className="oc-grid">
              {roster.map((a, i) => {
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
/* Top wall band — the room sign plus the mounted fixtures (blackboard, notice board,
   TV, clock). */
.oc-wall {
  position:relative; height:58px; z-index:3;
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
.oc-sign { flex-shrink:0; font-family:ui-monospace,monospace; font-size:12px; letter-spacing:.28em;
  color:#6f5f3c; text-shadow:0 1px 0 rgba(255,255,255,.5); }
/* fixtures hang on the wall, right-aligned, mounted HIGH on the band so floor
   furniture can sit against the wall below them */
.oc-wall-fix { margin-left:auto; display:flex; align-items:flex-start; gap:20px; height:100%;
  padding-top:3px; }
.oc-fix { display:inline-flex; align-items:flex-end; image-rendering:pixelated;
  filter:drop-shadow(0 2px 2px rgba(0,0,0,.30)); }
.oc-fix img { display:block; image-rendering:pixelated; }
/* the TV is "on": a gentle screen-glow pulse */
.oc-fix-tv-screen img { animation: oc-tv 2.6s ease-in-out infinite; }
@keyframes oc-tv { 0%,100%{filter:brightness(1)} 50%{filter:brightness(1.22) saturate(1.25)} }

/* Floor — the darker lane tile frames the office as a thin BORDER (matching the
   conference-room cards); an inset ::before field carries the main floor tile. */
.oc-floor {
  position:relative; padding:50px 82px 44px;
  background-color:#cbb89a;
  background-image: var(--oc-lane, none);
  background-size: var(--oc-lane-bg, auto);
  background-repeat: repeat;
  image-rendering:pixelated;
}
.oc-floor::before {
  content:''; position:absolute; inset:16px; z-index:0; pointer-events:none;
  background-image: var(--oc-floor, none);
  background-size: var(--oc-floor-bg, auto);
  background-repeat: repeat; image-rendering:pixelated; border-radius:4px;
  box-shadow: inset 0 0 0 2px rgba(0,0,0,.10), inset 0 10px 18px rgba(0,0,0,.05);
}

/* Furniture clusters — each is a flex box anchored to a wall/corner so its members
   auto-space (fixed gap, no overlap) and sit on a common baseline. Heights come from
   the inline OBJ_H map (kept as downscales of the cropped sprites so pixels stay crisp
   and every object reads at a scale consistent with the agents). */
.oc-cluster { position:absolute; z-index:1; display:flex; align-items:flex-end; gap:6px;
  pointer-events:none; }
.oc-obj { display:block; image-rendering:pixelated;
  filter:drop-shadow(0 4px 3px rgba(0,0,0,.30)); }
/* negative offsets tuck the wall-side pieces slightly UNDER the walls (behind the
   opaque wall band / room border) so they read as sitting against the wall. */
.oc-cl-tl { top:-12px; left:6px; }
.oc-cl-tr { top:-12px; right:6px; }
.oc-cl-bl { bottom:-6px; left:6px; }
.oc-cl-br { bottom:-6px; right:6px; }
.oc-cl-lm { top:47%; left:-8px; transform:translateY(-50%);
  flex-direction:column; align-items:flex-start; gap:5px; }
.oc-cl-rm { top:47%; right:-8px; transform:translateY(-50%);
  flex-direction:column; align-items:flex-end; gap:5px; }
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
.oc-cr-wall { position:relative; z-index:2; height:38px; display:flex; align-items:center;
  gap:10px; padding:0 12px;
  background: linear-gradient(rgba(255,255,255,.22), rgba(0,0,0,.10)),
    var(--oc-wall, linear-gradient(#e7dbc2,#d7c7a6));
  background-size: cover, var(--oc-wall-bg,auto); background-repeat:no-repeat, repeat;
  image-rendering:pixelated; border-bottom:3px solid #b6a67f; }
.oc-cr-sign { flex-shrink:1; min-width:0; font-family:ui-monospace,monospace; font-size:10px;
  letter-spacing:.12em; text-transform:uppercase; color:#5f5030;
  text-shadow:0 1px 0 rgba(255,255,255,.5);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.oc-cr-fix { margin-left:auto; flex-shrink:0; display:flex; align-items:center; gap:12px; }
.oc-cr-fiximg { height:26px; display:block; image-rendering:pixelated;
  filter:drop-shadow(0 2px 2px rgba(0,0,0,.28)); }
/* generic TV-screen glow pulse (wall band uses .oc-fix-tv-screen img above) */
img.oc-fix-tv-screen { animation: oc-tv 2.6s ease-in-out infinite; }
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

/* Desk grid: auto-fill => reflows to agent count AND viewport with no JS. Tight
   cells + gap pack the agents' desks close together. */
.oc-grid { position:relative; z-index:2;
  display:grid; grid-template-columns:repeat(auto-fill, minmax(108px, 1fr));
  gap:0 2px; justify-items:center; }

.oc-seat { position:relative; display:flex; flex-direction:column; align-items:center;
  background:none; border:none; cursor:pointer; padding:2px 0; width:100%; }
.oc-figure { position:relative; height:116px; display:flex; align-items:flex-end; justify-content:center; }
.oc-static, .oc-anim { image-rendering:pixelated; filter:drop-shadow(0 5px 4px rgba(0,0,0,.55)); }
.oc-static { height:116px; }
/* animated sprite: the seated typing spritesheet (N frames wide) played via steps */
.oc-anim { --w:116px; display:block; width:var(--w); height:var(--w);
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
  .oc-floor { padding:44px 16px 40px; }
  .oc-floor::before { inset:14px; }
  /* the side gutters collapse on mobile, so drop the left/right-wall clusters */
  .oc-cl-lm, .oc-cl-rm { display:none; }
  .oc-cluster { gap:5px; }
  .oc-obj { height:38px !important; }
  .oc-seat-plant { height:30px; }
  .oc-wall-fix { gap:10px; }
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
