"use client";

/**
 * Top-down RPG office — each agent is a real Pixel Lab character standing at a
 * desk in a shared room. Working agents type at a lit monitor; idle ones dim and
 * doze; errors flash red. Sprites are the pre-generated character library
 * (characters.generated.ts / public/characters) — selection only, no runtime
 * generation. Roster status (working/idle/error) drives the state.
 */

import React from "react";

import { Building2, Coins } from "lucide-react";

import { CHARACTERS } from "./characters.generated";
import { roleFor } from "./scene";

export type OfficeState = "working" | "idle" | "error";

interface OfficeAgent {
  name: string;
  description?: string;
  status?: string;
  source?: string | null;
}

// Front-ish facings for visual variety (all read as "at the desk").
const FACINGS = ["south", "south-east", "south-west"] as const;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Map an agent to a character key: exact match wins, else its role's stand-in. */
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
  if (CHARACTERS[name]) return name;
  return ROLE_TO_CHAR[roleFor(name)] ?? "strategy";
}

function spriteSrc(name: string): string {
  const key = characterFor(name);
  const dir = FACINGS[hash(name) % FACINGS.length];
  return CHARACTERS[key][dir];
}

function Station({
  agent,
  state,
  onOpen,
}: {
  agent: OfficeAgent;
  state: OfficeState;
  onOpen: (name: string) => void;
}) {
  return (
    <button
      onClick={() => onOpen(agent.name)}
      className={`td-station td-${state}`}
      title={agent.description || agent.name}
    >
      <div className="td-sprite-wrap">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="td-sprite" src={spriteSrc(agent.name)} alt={agent.name} />
        {state === "idle" && <span className="td-zzz">z</span>}
      </div>
      <div className="td-desk">
        <span className={`td-monitor ${state === "working" ? "on" : ""}`} />
        <span className="td-kbd" />
      </div>
      <div className="td-plate">
        <span className="td-name">{agent.name}</span>
        <span className={`td-pill td-${state}`}>
          {state === "idle" ? "sleeping" : state}
        </span>
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

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="td-mono text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Building2 size={13} /> The Office · {workingCount}/{roster.length} at work
        </div>
        <div className="td-mono text-[11px] text-emerald-500 flex items-center gap-1">
          <Coins size={12} /> Today {fmtCost(todayCost)}
        </div>
      </div>
      {roster.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-center gap-2">
          <Building2 size={30} className="text-muted-foreground/50" />
          <p className="td-mono text-sm text-muted-foreground">No agents registered yet.</p>
        </div>
      ) : (
        <div className="td-room">
          <div className="td-wall" />
          <div className="td-grid">
            {roster.map((a) => (
              <Station key={a.name} agent={a} state={stateOf(a)} onOpen={onOpen} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Injected once by the page. */
export const TOPDOWN_STYLE = `
.td-mono { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; letter-spacing:.02em; }
.td-room {
  position:relative; padding:34px 22px 22px;
  background:
    linear-gradient(var(--td-floor,#2a2233), var(--td-floor2,#241d2e)) padding-box,
    repeating-linear-gradient(0deg, transparent, transparent 31px, rgba(255,255,255,.03) 31px, rgba(255,255,255,.03) 32px),
    repeating-linear-gradient(90deg, transparent, transparent 31px, rgba(255,255,255,.03) 31px, rgba(255,255,255,.03) 32px);
  border:4px solid #3a2f4a; border-radius:14px;
  box-shadow: inset 0 0 0 3px #1b1626, inset 0 18px 40px rgba(0,0,0,.35);
}
.td-wall { position:absolute; inset:4px 4px auto 4px; height:26px;
  background:linear-gradient(#3a2f4a,#2f2640); border-radius:10px 10px 0 0; border-bottom:2px solid #1b1626; }
.td-grid { position:relative; display:grid; grid-template-columns:repeat(2,1fr); gap:22px 26px; }
@media (min-width:900px){ .td-grid { grid-template-columns:repeat(3,1fr); } }
.td-station { position:relative; display:flex; flex-direction:column; align-items:center; padding-top:26px;
  background:none; border:none; cursor:pointer; }
.td-sprite-wrap { position:relative; height:96px; display:flex; align-items:flex-end; z-index:2; }
.td-sprite { image-rendering:pixelated; height:100px; filter: drop-shadow(0 4px 3px rgba(0,0,0,.5)); transition:transform .15s; }
.td-station:hover .td-sprite { transform:translateY(-3px) scale(1.04); }
.td-idle .td-sprite { filter: grayscale(.5) brightness(.72) drop-shadow(0 4px 3px rgba(0,0,0,.5)); }
.td-working .td-sprite { animation: td-bob .7s steps(2) infinite; }
.td-error .td-sprite { animation: td-shake .4s steps(2) 4; }
.td-desk { position:relative; width:150px; height:32px; margin-top:-14px; z-index:1;
  background:linear-gradient(#5a4326,#4a3620); border-radius:5px; border:2px solid #2f2415;
  box-shadow:0 5px 0 #241a10, 0 8px 10px rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; gap:8px; }
.td-monitor { width:32px; height:20px; margin-top:-8px; background:#0d1117; border:2px solid #10151d; border-radius:3px; }
.td-monitor.on { background:#1f6feb; box-shadow:0 0 8px rgba(88,166,255,.6); animation: td-flick 1.3s steps(3) infinite; }
.td-kbd { width:42px; height:6px; background:#c7d0da; border-radius:2px; }
.td-plate { margin-top:8px; text-align:center; }
.td-name { display:block; font-size:12px; color:var(--foreground,#e6e6ee); font-weight:600; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.td-pill { display:inline-block; margin-top:3px; font-size:9px; text-transform:uppercase; padding:1px 6px; border-radius:5px; border:1px solid; font-family:ui-monospace,monospace; }
.td-pill.td-working { color:#f5b301; border-color:#f5b30155; background:#f5b30115; }
.td-pill.td-idle { color:#8b949e; border-color:#8b949e33; background:#8b949e10; }
.td-pill.td-error { color:#ff6b6b; border-color:#ff6b6b44; background:#ff6b6b12; }
.td-zzz { position:absolute; top:-2px; right:2px; color:#8b949e; font-size:12px; opacity:.85; animation: td-zzz 2.6s ease-in-out infinite; }
@keyframes td-bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
@keyframes td-shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-3px)} 75%{transform:translateX(3px)} }
@keyframes td-flick { 0%,100%{opacity:1} 50%{opacity:.75} }
@keyframes td-zzz { 0%{opacity:0;transform:translateY(0)} 40%{opacity:.85} 100%{opacity:0;transform:translateY(-8px)} }
@media (prefers-reduced-motion: reduce){ .td-working .td-sprite,.td-error .td-sprite,.td-monitor.on,.td-zzz { animation:none; } }
`;
