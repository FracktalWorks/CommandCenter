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
import { roleFor } from "./scene";

export type OfficeState = "working" | "idle" | "error";

interface OfficeAgent {
  name: string;
  description?: string;
  status?: string;
  source?: string | null;
}

// Floor props sit in the room's corners; the whiteboard is wall-mounted. Each entry
// is [prop file, corner class]. Corners keep them correctly placed at any room size.
const CORNER_PROPS: Array<[string, string]> = [
  ["bookshelf", "oc-tl"],
  ["coffee", "oc-tr"],
  ["plant", "oc-bl"],
  ["water-cooler", "oc-br"],
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

function Seat({
  agent,
  state,
  onOpen,
}: {
  agent: OfficeAgent;
  state: OfficeState;
  onOpen: (name: string) => void;
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
      </div>
      <div className="oc-plate">
        <span className="oc-name">{agent.name}</span>
        <span className={`oc-pill oc-${state}`}>{state === "idle" ? "sleeping" : state}</span>
      </div>
    </button>
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

  // Seamless generated floor tile (repeats to fill any room size); undefined until
  // the Pixel Lab tileset is built, in which case CSS falls back to a procedural floor.
  const roomStyle = OFFICE_ENV.floor
    ? ({
        "--oc-floor": `url(${OFFICE_ENV.floor})`,
        "--oc-floor-size": `${OFFICE_ENV.floorSize ?? 64}px`,
        ...(OFFICE_ENV.wall ? { "--oc-wall": `url(${OFFICE_ENV.wall})` } : {}),
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
        <div className="oc-room" style={roomStyle}>
          <div className="oc-wall">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="oc-wallboard" src="/office-props/whiteboard.png" alt="" aria-hidden />
            <span className="oc-sign">THE OFFICE</span>
          </div>
          <div className="oc-floor">
            {CORNER_PROPS.map(([p, corner]) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={p} className={`oc-prop ${corner}`} src={`/office-props/${p}.png`} alt="" aria-hidden />
            ))}
            <div className="oc-grid">
              {roster.map((a) => (
                <Seat key={a.name} agent={a} state={stateOf(a)} onOpen={onOpen} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Injected once by the page. */
export const TOPDOWN_STYLE = `
.oc-mono { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; letter-spacing:.02em; }

/* Outer room = the walls. Scales to whatever the floor grid needs. */
.oc-room {
  position:relative; border-radius:16px; overflow:hidden;
  background:linear-gradient(#2a2336,#1f1929);
  border:5px solid #3a2f4a;
  box-shadow: inset 0 0 0 3px #1b1626, 0 10px 30px rgba(0,0,0,.35);
}
/* Top wall band — holds the mounted whiteboard + room sign. */
.oc-wall {
  position:relative; height:56px; z-index:3;
  background:
    linear-gradient(rgba(0,0,0,.12), rgba(0,0,0,.42)),
    var(--oc-wall, linear-gradient(#40354f,#2c2440));
  background-size: cover, 56px 56px;
  background-repeat: no-repeat, repeat;
  image-rendering:pixelated;
  border-bottom:3px solid #1b1626;
  display:flex; align-items:center; gap:14px; padding:0 18px;
  box-shadow: inset 0 -8px 14px rgba(0,0,0,.28);
}
.oc-wallboard { height:40px; image-rendering:pixelated; filter:drop-shadow(0 2px 2px rgba(0,0,0,.5)); }
.oc-sign { font-family:ui-monospace,monospace; font-size:12px; letter-spacing:.28em;
  color:#c7b8e0; text-shadow:0 1px 0 #12101a; }

/* Floor — the seamless tile repeats to fill; procedural fallback when no tile yet. */
.oc-floor {
  position:relative; padding:58px 16px 54px;
  background-color:#241d30;
  background-image:
    var(--oc-floor, none),
    repeating-linear-gradient(0deg, transparent, transparent 33px, rgba(255,255,255,.03) 33px, rgba(255,255,255,.03) 34px),
    repeating-linear-gradient(90deg, transparent, transparent 33px, rgba(255,255,255,.03) 33px, rgba(255,255,255,.03) 34px);
  background-size: var(--oc-floor-size,64px) var(--oc-floor-size,64px), auto, auto;
  background-repeat: repeat, repeat, repeat;
  image-rendering:pixelated;
  box-shadow: inset 0 22px 42px rgba(0,0,0,.42), inset 0 -18px 34px rgba(0,0,0,.30);
}

/* Corner props stay pinned to the room corners at ANY size. */
.oc-prop { position:absolute; height:46px; z-index:1; image-rendering:pixelated;
  filter:drop-shadow(0 3px 3px rgba(0,0,0,.5)); pointer-events:none; }
.oc-prop.oc-tl { top:8px;  left:12px; }
.oc-prop.oc-tr { top:8px;  right:12px; }
.oc-prop.oc-bl { bottom:10px; left:12px; }
.oc-prop.oc-br { bottom:10px; right:12px; }

/* Desk grid: auto-fill => reflows to agent count AND viewport with no JS. */
.oc-grid { position:relative; z-index:2;
  display:grid; grid-template-columns:repeat(auto-fill, minmax(148px, 1fr));
  gap:10px 12px; justify-items:center; }

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
.oc-zzz { position:absolute; top:2px; right:24px; color:#8b949e; font-size:13px; animation: oc-zf 2.6s ease-in-out infinite; z-index:3; }
.oc-ping { position:absolute; top:14px; right:26px; width:7px; height:7px; border-radius:50%; background:#58a6ff; box-shadow:0 0 8px #58a6ff; animation: oc-pl 1.2s steps(2) infinite; z-index:3; }
.oc-plate { margin-top:-4px; text-align:center; z-index:3; }
.oc-name { display:block; font-size:12px; color:var(--foreground,#e8e8ef); font-weight:600; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.oc-pill { display:inline-block; margin-top:2px; font-size:9px; text-transform:uppercase; padding:1px 6px; border-radius:5px; border:1px solid; font-family:ui-monospace,monospace; }
.oc-pill.oc-working { color:#f5b301; border-color:#f5b30155; background:#f5b30115; }
.oc-pill.oc-idle { color:#8b949e; border-color:#8b949e33; background:#8b949e10; }
.oc-pill.oc-error { color:#ff6b6b; border-color:#ff6b6b44; background:#ff6b6b12; }

/* Compact the room on small screens: smaller sprites, tighter grid, fewer props. */
@media (max-width:560px){
  .oc-grid { grid-template-columns:repeat(auto-fill, minmax(116px, 1fr)); gap:6px 8px; }
  .oc-figure { height:104px; }
  .oc-static { height:104px; }
  .oc-anim { --w:104px; }
  .oc-floor { padding:52px 8px 46px; }
  .oc-prop { height:36px; }
  .oc-prop.oc-tr, .oc-prop.oc-br { display:none; }
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
