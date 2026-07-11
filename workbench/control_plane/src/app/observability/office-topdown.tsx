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

  // Collaborations → conference tables. Concurrently-working agents are grouped
  // (~2 per table) so tables multiply on the fly as more agents work together;
  // a single empty table shows by default when nobody is collaborating. (A real
  // backend collaboration signal can replace this heuristic later.)
  const working = roster
    .filter((a) => stateOf(a) === "working")
    .map((a) => a.name)
    .sort();
  const collabs: string[][] = [];
  if (working.length >= 2) {
    for (let i = 0; i < working.length; i += 2) collabs.push(working.slice(i, i + 2));
    const last = collabs[collabs.length - 1];
    if (collabs.length > 1 && last.length === 1) collabs[collabs.length - 2].push(collabs.pop()![0]);
  }
  const stations: string[][] = collabs.length ? collabs : [[]];

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
            {/* Conference room — one table by default; more tables spawn as more
                agents collaborate concurrently (static seats for now; agents will
                walk over in a later pass). */}
            <div className="oc-conf-zone">
              {stations.map((members, i) => (
                <div className="oc-conf" key={members.join("|") || `conf-${i}`}>
                  <span className="oc-conf-label">
                    {members.length ? members.join(" + ") : "Conference Room"}
                  </span>
                  <div className="oc-conf-stage">
                    <span className="oc-rug" aria-hidden />
                    {["oc-ch-t1", "oc-ch-t2", "oc-ch-b1", "oc-ch-b2"].map((ch) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={ch} className={`oc-chair ${ch}`} src="/office-props/chair.png" alt="" aria-hidden />
                    ))}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="oc-conf-table" src="/office-props/conference-table.png" alt="" aria-hidden />
                  </div>
                </div>
              ))}
            </div>
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
  background-size: cover, 56px 56px;
  background-repeat: no-repeat, repeat;
  image-rendering:pixelated;
  border-bottom:3px solid #b6a67f;
  display:flex; align-items:center; gap:14px; padding:0 18px;
  box-shadow: inset 0 -6px 12px rgba(0,0,0,.10);
}
.oc-wallboard { height:40px; image-rendering:pixelated; filter:drop-shadow(0 2px 2px rgba(0,0,0,.28)); }
.oc-sign { font-family:ui-monospace,monospace; font-size:12px; letter-spacing:.28em;
  color:#6f5f3c; text-shadow:0 1px 0 rgba(255,255,255,.5); }

/* Floor — the seamless tile repeats to fill; procedural fallback when no tile yet. */
.oc-floor {
  position:relative; padding:58px 16px 54px;
  background-color:#e9e2d3;
  background-image:
    var(--oc-floor, none),
    repeating-linear-gradient(0deg, transparent, transparent 33px, rgba(0,0,0,.035) 33px, rgba(0,0,0,.035) 34px),
    repeating-linear-gradient(90deg, transparent, transparent 33px, rgba(0,0,0,.035) 33px, rgba(0,0,0,.035) 34px);
  background-size: var(--oc-floor-size,64px) var(--oc-floor-size,64px), auto, auto;
  background-repeat: repeat, repeat, repeat;
  image-rendering:pixelated;
  box-shadow: inset 0 14px 26px rgba(0,0,0,.08), inset 0 -12px 22px rgba(0,0,0,.06);
}

/* Corner props stay pinned to the room corners at ANY size. Scaled to sit in
   proportion to the seated agents (~90px), not tiny. */
.oc-prop { position:absolute; height:74px; z-index:1; image-rendering:pixelated;
  filter:drop-shadow(0 4px 3px rgba(0,0,0,.32)); pointer-events:none; }
.oc-prop.oc-tl { top:8px;  left:14px; }
.oc-prop.oc-tr { top:8px;  right:14px; }
.oc-prop.oc-bl { bottom:12px; left:14px; }
.oc-prop.oc-br { bottom:12px; right:14px; }

/* Conference zone — one table by default; wraps to a grid of tables as more
   collaborations spawn. */
.oc-conf-zone { position:relative; z-index:2; margin:0 auto 22px;
  display:flex; flex-wrap:wrap; justify-content:center; gap:14px 18px; }
/* One collaboration table = a panelled card. */
.oc-conf { position:relative; width:250px; padding:16px 12px 12px; border-radius:14px;
  background:radial-gradient(120% 90% at 50% 42%, rgba(255,255,255,.5), rgba(0,0,0,.05));
  box-shadow: inset 0 0 0 2px rgba(0,0,0,.06), inset 0 0 20px rgba(0,0,0,.04);
  display:flex; flex-direction:column; align-items:center; gap:8px; }
.oc-conf-label { max-width:230px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-family:ui-monospace,monospace; font-size:10px; letter-spacing:.14em;
  text-transform:uppercase; color:#6f5f3c; text-shadow:0 1px 0 rgba(255,255,255,.5); }
.oc-conf-stage { position:relative; width:224px; height:150px; }
/* CSS area rug centered under the table (clean rectangle, no odd pixel shape). */
.oc-rug { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  width:206px; height:126px; border-radius:12px;
  background:linear-gradient(#efe7d6,#e3d8c0);
  box-shadow: inset 0 0 0 4px rgba(255,255,255,.4), inset 0 0 0 6px rgba(0,0,0,.06),
    0 4px 8px rgba(0,0,0,.12); }
.oc-conf-table { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  z-index:2; width:172px; image-rendering:pixelated;
  filter:drop-shadow(0 5px 4px rgba(0,0,0,.32)); }
/* pixel-art meeting chairs hugging the table's long edges. The chair sprite is
   drawn from behind (back toward viewer) — correct for the near/bottom seats; the
   far/top seats flip vertically so their backs point away toward the wall. */
.oc-chair { position:absolute; z-index:1; width:36px; image-rendering:pixelated;
  filter:drop-shadow(0 2px 2px rgba(0,0,0,.28)); }
.oc-ch-t1, .oc-ch-t2 { transform:scaleY(-1); }
.oc-ch-t1 { top:22px; left:50px; } .oc-ch-t2 { top:22px; right:50px; }
.oc-ch-b1 { bottom:22px; left:50px; } .oc-ch-b2 { bottom:22px; right:50px; }

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
  .oc-grid { grid-template-columns:repeat(auto-fill, minmax(116px, 1fr)); gap:6px 8px; }
  .oc-figure { height:104px; }
  .oc-static { height:104px; }
  .oc-anim { --w:104px; }
  .oc-floor { padding:52px 8px 46px; }
  .oc-prop { height:56px; }
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
