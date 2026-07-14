"use client";

/**
 * genUITemplates — Tier 2 of generative UI: a registry of pre-DESIGNED, polished,
 * animated React components an agent renders by NAME while supplying only data.
 *
 * Why templates: Tier 1 (GenerativeUINode primitives) is safe but generic; Tier 3
 * (SandboxedHtml) is unlimited but inconsistent run-to-run. Templates are the
 * sweet spot — the agent picks `weatherCard` / `statDashboard` / … and passes
 * typed data; the DESIGN (layout, motion, theming) is ours and identical every
 * time, so on-the-fly UI still looks like one coherent product.
 *
 * An agent triggers a template with a generative_ui node:
 *   { "type": "template", "props": { "name": "weatherCard", "data": { ... } } }
 * Unknown names fall back to an inert card (same safety posture as Tier 1).
 *
 * SOURCE OF TRUTH: TEMPLATE_CATALOG below lists every template + its data shape.
 * The backend emit_generative_ui docstring MUST mirror this list, or agents will
 * emit names the renderer drops. Keep them in lockstep.
 *
 * All animation is CSS/SVG only (no new bundle deps). Every template is
 * theme-agnostic: it styles via the app's CSS custom-property tokens (full
 * colors — see theme-css-vars memory) so it reads correctly in light and dark.
 */

import { createElement, useEffect, useState } from "react";

import { resolveIcon } from "@/lib/icons";

type Data = Record<string, unknown>;

/** Small inline Lucide icon for templates (optional `icon` fields). */
function TIcon({ name, size = 16, color }: { name?: unknown; size?: number; color?: string }) {
  if (!name || typeof name !== "string") return null;
  // createElement (not <Icon/>) so the resolved component isn't flagged as
  // declared-during-render (react-hooks/static-components).
  return createElement(resolveIcon(name), {
    size, strokeWidth: 1.75, color: color ?? "currentColor", "aria-hidden": true,
  });
}

const str = (v: unknown, f = ""): string =>
  typeof v === "string" ? v : v == null ? f : String(v);
const num = (v: unknown, f = 0): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : f;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ── Catalog (source of truth, also consumed for the fallback listing) ────────

export interface TemplateSpec {
  name: string;
  summary: string;
  /** Human-readable data shape, mirrored into the backend tool docstring. */
  data: string;
}

export const TEMPLATE_CATALOG: TemplateSpec[] = [
  {
    name: "weatherCard",
    summary: "Current conditions + multi-day forecast, animated sky icon.",
    data: "{ location, tempC|tempF, condition('sunny'|'cloudy'|'rain'|'snow'|'storm'), highC?, lowC?, humidity?, wind?, forecast?:[{day,condition,high,low}] }",
  },
  {
    name: "statDashboard",
    summary: "Row of KPI stat tiles with delta arrows and animated count-up.",
    data: "{ title?, stats:[{ label, value, unit?, delta?:number, icon?(Lucide name e.g. 'trending-up') }] }",
  },
  {
    name: "barChart",
    summary: "Horizontal bar chart with animated grow-in bars.",
    data: "{ title?, unit?, bars:[{ label, value, tone?('primary'|'success'|'warning'|'danger') }] }",
  },
  {
    name: "sparkTrend",
    summary: "Single metric with an inline SVG sparkline trend.",
    data: "{ label, value, unit?, delta?:number, series:number[] }",
  },
  {
    name: "comparison",
    summary: "Side-by-side option comparison with a highlighted winner.",
    data: "{ title?, options:[{ name, recommended?:bool, rows:[{ label, value }] }] }",
  },
  {
    name: "progressTracker",
    summary: "Ordered steps with done/active/pending states and a progress bar.",
    data: "{ title?, steps:[{ label, state('done'|'active'|'pending') }] }",
  },
];

// ── Shared bits ──────────────────────────────────────────────────────────────

/** Whether the viewer prefers reduced motion (evaluated once, lazily). */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/** Ease-out count-up for numeric values. Respects prefers-reduced-motion by
 *  starting AT the target (no animation) rather than mutating state in-effect. */
function useCountUp(target: number, ms = 700): number {
  // Lazy initial state: reduced-motion users start at the final value, so the
  // effect below never needs to setState synchronously (react-hooks lint).
  const [v, setV] = useState(() => (prefersReducedMotion() ? target : 0));
  useEffect(() => {
    if (prefersReducedMotion()) return;
    let raf = 0;
    let start: number | null = null;
    const step = (t: number) => {
      if (start == null) start = t;
      const p = Math.min((t - start) / ms, 1);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

const TONE_COLOR: Record<string, string> = {
  primary: "var(--primary, #0ea5e9)",
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
};

function DeltaArrow({ delta }: { delta: number }): React.ReactElement | null {
  if (!delta) return <span style={{ color: "var(--muted-foreground)" }}>—</span>;
  const up = delta > 0;
  return (
    <span style={{ color: up ? "#10b981" : "#ef4444", fontVariantNumeric: "tabular-nums" }}>
      {up ? "▲" : "▼"} {Math.abs(delta)}
    </span>
  );
}

// ── Animated weather glyph (pure SVG/CSS) ────────────────────────────────────

function WeatherGlyph({ condition, size = 48 }: { condition: string; size?: number }) {
  const c = condition.toLowerCase();
  const sun = (
    <g>
      <circle cx="24" cy="24" r="9" fill="#fbbf24">
        <animate attributeName="r" values="9;9.8;9" dur="3s" repeatCount="indefinite" />
      </circle>
      {Array.from({ length: 8 }).map((_, i) => (
        <line
          key={i}
          x1="24" y1="24" x2="24" y2="6"
          stroke="#fbbf24" strokeWidth="2" strokeLinecap="round"
          transform={`rotate(${i * 45} 24 24)`}
        >
          <animate attributeName="opacity" values="0.4;1;0.4" dur="2s"
            begin={`${i * 0.15}s`} repeatCount="indefinite" />
        </line>
      ))}
    </g>
  );
  const cloud = (
    <g>
      <ellipse cx="24" cy="30" rx="14" ry="8" fill="#94a3b8">
        <animate attributeName="cx" values="22;26;22" dur="4s" repeatCount="indefinite" />
      </ellipse>
      <circle cx="17" cy="26" r="7" fill="#cbd5e1" />
      <circle cx="30" cy="26" r="8" fill="#cbd5e1" />
    </g>
  );
  const drops = (
    <g>
      {[14, 24, 34].map((x, i) => (
        <line key={x} x1={x} y1="34" x2={x - 2} y2="42" stroke="#38bdf8" strokeWidth="2"
          strokeLinecap="round">
          <animate attributeName="opacity" values="0;1;0" dur="1s"
            begin={`${i * 0.25}s`} repeatCount="indefinite" />
        </line>
      ))}
    </g>
  );
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      {c.includes("sun") || c.includes("clear") ? sun : null}
      {c.includes("cloud") || c.includes("rain") || c.includes("storm") ? cloud : null}
      {c.includes("rain") || c.includes("storm") ? drops : null}
      {c.includes("snow") ? (
        <text x="24" y="40" textAnchor="middle" fontSize="16" fill="#e0f2fe">❄</text>
      ) : null}
    </svg>
  );
}

// ── Templates ────────────────────────────────────────────────────────────────

function WeatherCard({ data }: { data: Data }) {
  const location = str(data.location, "Weather");
  const temp = data.tempF != null ? num(data.tempF) : num(data.tempC);
  const unit = data.tempF != null ? "°F" : "°C";
  const condition = str(data.condition, "clear");
  const animated = useCountUp(temp);
  const forecast = arr(data.forecast);
  return (
    <div style={{
      borderRadius: 14, padding: 16, border: "1px solid var(--border)",
      background: "linear-gradient(135deg, color-mix(in srgb, var(--primary,#0ea5e9) 12%, var(--card)), var(--card))",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <WeatherGlyph condition={condition} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>{location}</div>
          <div style={{ fontSize: 34, fontWeight: 600, color: "var(--foreground)", lineHeight: 1.1 }}>
            {Math.round(animated)}{unit}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-foreground)", textTransform: "capitalize" }}>
            {condition}
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: 11, color: "var(--muted-foreground)", lineHeight: 1.6 }}>
          {data.highC != null && <div>H {num(data.highC)}°</div>}
          {data.lowC != null && <div>L {num(data.lowC)}°</div>}
          {data.humidity != null && <div>💧 {num(data.humidity)}%</div>}
          {data.wind != null && <div>🌬 {str(data.wind)}</div>}
        </div>
      </div>
      {forecast.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          {forecast.slice(0, 7).map((d, i) => {
            const day = (d ?? {}) as Data;
            return (
              <div key={i} style={{
                flex: 1, textAlign: "center", padding: "8px 4px", borderRadius: 10,
                background: "var(--secondary)", animation: `ccFadeUp .4s ease ${i * 0.05}s both`,
              }}>
                <div style={{ fontSize: 10, color: "var(--muted-foreground)" }}>{str(day.day)}</div>
                <WeatherGlyph condition={str(day.condition, condition)} size={26} />
                <div style={{ fontSize: 11, color: "var(--foreground)" }}>
                  {num(day.high)}°<span style={{ color: "var(--muted-foreground)" }}> {num(day.low)}°</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <style>{`@keyframes ccFadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

function StatTile({ s }: { s: Data }) {
  const value = num(s.value);
  const animated = useCountUp(value);
  const isNumeric = typeof s.value === "number" || /^-?\d/.test(str(s.value));
  return (
    <div style={{
      flex: 1, minWidth: 110, padding: 12, borderRadius: 12,
      border: "1px solid var(--border)", background: "var(--card)",
      animation: "ccFadeUp .4s ease both",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--muted-foreground)" }}>
        <TIcon name={s.icon} size={13} />
        <span>{str(s.label)}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}>
        {isNumeric ? Math.round(animated).toLocaleString() : str(s.value)}
        {s.unit != null && <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}> {str(s.unit)}</span>}
      </div>
      {s.delta != null && (
        <div style={{ fontSize: 11, marginTop: 2 }}><DeltaArrow delta={num(s.delta)} /></div>
      )}
    </div>
  );
}

function StatDashboard({ data }: { data: Data }) {
  const stats = arr(data.stats);
  return (
    <div>
      {data.title != null && (
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)", marginBottom: 8 }}>
          {str(data.title)}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {stats.map((s, i) => <StatTile key={i} s={(s ?? {}) as Data} />)}
      </div>
      <style>{`@keyframes ccFadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

function BarChart({ data }: { data: Data }) {
  const bars = arr(data.bars).map((b) => (b ?? {}) as Data);
  const max = Math.max(1, ...bars.map((b) => num(b.value)));
  return (
    <div style={{ padding: 14, borderRadius: 12, border: "1px solid var(--border)", background: "var(--card)" }}>
      {data.title != null && (
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)", marginBottom: 10 }}>
          {str(data.title)}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {bars.map((b, i) => {
          const pct = (num(b.value) / max) * 100;
          const color = TONE_COLOR[str(b.tone, "primary")] ?? TONE_COLOR.primary;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 90, fontSize: 11, color: "var(--muted-foreground)", textAlign: "right",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {str(b.label)}
              </div>
              <div style={{ flex: 1, height: 18, borderRadius: 6, background: "var(--secondary)", overflow: "hidden" }}>
                <div style={{
                  height: "100%", width: `${pct}%`, background: color, borderRadius: 6,
                  animation: `ccGrow .7s cubic-bezier(.22,1,.36,1) ${i * 0.06}s both`,
                }} />
              </div>
              <div style={{ width: 52, fontSize: 11, color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}>
                {num(b.value).toLocaleString()}{data.unit != null ? str(data.unit) : ""}
              </div>
            </div>
          );
        })}
      </div>
      <style>{`@keyframes ccGrow{from{width:0}}`}</style>
    </div>
  );
}

function SparkTrend({ data }: { data: Data }) {
  const series = arr(data.series).map((n) => num(n));
  const value = num(data.value);
  const animated = useCountUp(value);
  const w = 120, h = 36;
  const min = Math.min(...series, 0), max = Math.max(...series, 1);
  const range = max - min || 1;
  const pts = series.map((v, i) => {
    const x = series.length > 1 ? (i / (series.length - 1)) * w : 0;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 14, borderRadius: 12,
      border: "1px solid var(--border)", background: "var(--card)" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>{str(data.label)}</div>
        <div style={{ fontSize: 24, fontWeight: 600, color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}>
          {Math.round(animated).toLocaleString()}
          {data.unit != null && <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}> {str(data.unit)}</span>}
        </div>
        {data.delta != null && <div style={{ fontSize: 11 }}><DeltaArrow delta={num(data.delta)} /></div>}
      </div>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <polyline points={pts} fill="none" stroke="var(--primary,#0ea5e9)" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ strokeDasharray: 400, strokeDashoffset: 400, animation: "ccDraw 1s ease forwards" }} />
      </svg>
      <style>{`@keyframes ccDraw{to{stroke-dashoffset:0}}`}</style>
    </div>
  );
}

function Comparison({ data }: { data: Data }) {
  const options = arr(data.options).map((o) => (o ?? {}) as Data);
  const rowLabels = Array.from(new Set(
    options.flatMap((o) => arr(o.rows).map((r) => str((r as Data).label))),
  ));
  return (
    <div style={{ borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
      {data.title != null && (
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)", padding: "10px 12px",
          borderBottom: "1px solid var(--border)", background: "var(--card)" }}>{str(data.title)}</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: `140px repeat(${options.length}, 1fr)` }}>
        <div style={{ background: "var(--card)" }} />
        {options.map((o, i) => (
          <div key={i} style={{
            padding: "8px 10px", fontSize: 12, fontWeight: 600, textAlign: "center",
            color: o.recommended ? "#10b981" : "var(--foreground)",
            background: o.recommended ? "color-mix(in srgb, #10b981 12%, var(--card))" : "var(--card)",
            borderLeft: "1px solid var(--border)",
          }}>
            {str(o.name)}{o.recommended ? " ★" : ""}
          </div>
        ))}
        {rowLabels.map((label, ri) => (
          <div key={label} style={{ display: "contents" }}>
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--muted-foreground)",
              borderTop: "1px solid var(--border)", background: ri % 2 ? "var(--secondary)" : "transparent" }}>
              {label}
            </div>
            {options.map((o, ci) => {
              const row = arr(o.rows).map((r) => (r ?? {}) as Data).find((r) => str(r.label) === label);
              return (
                <div key={ci} style={{ padding: "8px 10px", fontSize: 12, textAlign: "center",
                  color: "var(--foreground)", borderTop: "1px solid var(--border)", borderLeft: "1px solid var(--border)",
                  background: o.recommended ? "color-mix(in srgb, #10b981 6%, transparent)" : (ri % 2 ? "var(--secondary)" : "transparent") }}>
                  {row ? str(row.value) : "—"}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProgressTracker({ data }: { data: Data }) {
  const steps = arr(data.steps).map((s) => (s ?? {}) as Data);
  const done = steps.filter((s) => str(s.state) === "done").length;
  const pct = steps.length ? (done / steps.length) * 100 : 0;
  return (
    <div style={{ padding: 14, borderRadius: 12, border: "1px solid var(--border)", background: "var(--card)" }}>
      {data.title != null && (
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)", marginBottom: 10 }}>{str(data.title)}</div>
      )}
      <div style={{ height: 6, borderRadius: 3, background: "var(--secondary)", overflow: "hidden", marginBottom: 12 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: "#10b981",
          animation: "ccGrow .7s cubic-bezier(.22,1,.36,1) both" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.map((s, i) => {
          const state = str(s.state, "pending");
          const dot = state === "done" ? "#10b981" : state === "active" ? "var(--primary,#0ea5e9)" : "var(--border)";
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 14, height: 14, borderRadius: "50%", background: dot,
                boxShadow: state === "active" ? "0 0 0 4px color-mix(in srgb, var(--primary,#0ea5e9) 25%, transparent)" : "none",
                animation: state === "active" ? "ccPulse 1.6s ease-in-out infinite" : "none",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, color: "#fff" }}>
                {state === "done" ? "✓" : ""}
              </span>
              <span style={{ fontSize: 12,
                color: state === "pending" ? "var(--muted-foreground)" : "var(--foreground)",
                fontWeight: state === "active" ? 600 : 400 }}>
                {str(s.label)}
              </span>
            </div>
          );
        })}
      </div>
      <style>{`@keyframes ccGrow{from{width:0}}@keyframes ccPulse{0%,100%{opacity:1}50%{opacity:.55}}`}</style>
    </div>
  );
}

// ── Registry ─────────────────────────────────────────────────────────────────

export type TemplateRenderer = (data: Data) => React.ReactElement;

export const TEMPLATE_REGISTRY: Record<string, TemplateRenderer> = {
  weatherCard: (data) => <WeatherCard data={data} />,
  statDashboard: (data) => <StatDashboard data={data} />,
  barChart: (data) => <BarChart data={data} />,
  sparkTrend: (data) => <SparkTrend data={data} />,
  comparison: (data) => <Comparison data={data} />,
  progressTracker: (data) => <ProgressTracker data={data} />,
};

/** Render a template node, or an inert fallback if the name is unknown. */
export function renderTemplate(name: string, data: unknown): React.ReactElement {
  const renderer = TEMPLATE_REGISTRY[name];
  const safeData = (data && typeof data === "object" ? data : {}) as Data;
  if (!renderer) {
    return (
      <div className="rounded border border-dashed border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
        unknown template{name ? `: ${name}` : ""}
      </div>
    );
  }
  return renderer(safeData);
}
