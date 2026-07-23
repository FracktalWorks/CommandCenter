"use client";

/**
 * GenerativeUINode — a SAFE, declarative generative-UI renderer.
 *
 * Agents push a `generative_ui` CUSTOM AG-UI event carrying a component TREE
 * (data, never code) which renders as real UI inside chat. This is the
 * "generative UI over our AG-UI custom channel + renderer registry" approach
 * (see specs/chat_ui_agui_hitl_review_2026-07.md): we adopt the PATTERN that
 * Prefab/FastMCP-Apps embody, but over our own AG-UI transport — no MCP-Apps
 * host, no arbitrary HTML/JS.
 *
 * Three tiers of richness, all safe:
 *   • Tier 1 — the whitelisted primitives below (card/table/badge/…): inert data,
 *     no code path. The default and safest.
 *   • Tier 2 — `template` node: renders a pre-designed, animated React component
 *     from TEMPLATE_REGISTRY by NAME, supplying only data. Our design, every time.
 *   • Tier 3 — `html` node: agent-GENERATED HTML/CSS/JS, executed inside a
 *     locked-down opaque-origin iframe (SandboxedHtml). Unlimited/animated but
 *     fully isolated — no ambient authority, actions bridged via postMessage.
 * There is NO in-tree raw-markup injection: an unknown `type` renders as an inert
 * labelled fallback, and the `html` tier's code never touches our DOM/origin.
 *
 * Interactivity: `button` nodes carry an `action` string; clicking one calls
 * onAction(action), which the chat wires to submit the action as a follow-up
 * (same contract as the ```choices``` MCQ block). Template buttons and sandboxed
 * [data-cc-action] elements use the SAME onAction contract. No client-side eval
 * of agent code in our context.
 */

import { createElement } from "react";
import { useTheme } from "next-themes";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import SandboxedHtml from "@/components/SandboxedHtml";
import { renderTemplate } from "@/components/genUITemplates";
import { resolveIcon } from "@/lib/icons";
import { buildIconMap } from "@/lib/iconSvg";

// ─── Schema ────────────────────────────────────────────────────────────────

/** One node in the generative-UI tree. `type` MUST be a whitelisted kind. */
export interface GenUINode {
  type: string;
  props?: Record<string, unknown>;
  children?: GenUINode[];
}

/** The whitelisted component kinds. Extend deliberately — each is inert data. */
const KNOWN_TYPES = new Set([
  "card", "stack", "row", "heading", "text", "markdown", "badge",
  "divider", "keyValue", "table", "list", "code", "link", "button", "callout",
  "template", "html", "icon",
]);

/** tone → foreground color token for icons (matches badge/callout palette). */
const ICON_TONE: Record<string, string> = {
  success: "#10b981",
  error: "#ef4444",
  warning: "#f59e0b",
  info: "#38bdf8",
  muted: "var(--muted-foreground)",
  neutral: "var(--foreground)",
};

const s = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : v == null ? fallback : String(v);

// ─── Node renderer ───────────────────────────────────────────────────────

function Node({
  node, onAction, theme, depth = 0,
}: {
  node: GenUINode;
  onAction?: (action: string) => void;
  theme: "light" | "dark";
  depth?: number;
}): React.ReactElement | null {
  // Depth guard — a pathological/looping tree can't blow the stack.
  if (depth > 20) return null;
  if (!node || typeof node !== "object") return null;
  const type = s(node.type);
  const props = (node.props ?? {}) as Record<string, unknown>;
  const kids = Array.isArray(node.children) ? node.children : [];

  const renderKids = () =>
    kids.map((k, i) => <Node key={i} node={k} onAction={onAction} theme={theme} depth={depth + 1} />);

  switch (type) {
    case "card":
      return (
        <div className="rounded-lg border border-border/60 bg-card/50 p-3 space-y-2">
          {props.title != null && (
            <div className="text-sm font-semibold text-foreground">{s(props.title)}</div>
          )}
          {renderKids()}
        </div>
      );

    case "stack":
      return <div className="space-y-2">{renderKids()}</div>;

    case "row":
      return <div className="flex flex-wrap items-center gap-2">{renderKids()}</div>;

    case "heading":
      return <div className="text-sm font-semibold text-foreground">{s(props.text)}</div>;

    case "text":
      return (
        <p className={`text-[13px] leading-relaxed ${
          props.muted ? "text-muted-foreground" : "text-foreground"
        }`}>{s(props.text)}</p>
      );

    case "markdown":
      return (
        <div className="text-[13px] leading-relaxed text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{s(props.text)}</ReactMarkdown>
        </div>
      );

    case "badge": {
      const tone = s(props.tone, "neutral");
      const toneCls =
        tone === "success" ? "border-emerald-700/50 text-emerald-300 bg-emerald-950/30" :
        tone === "error" ? "border-red-700/50 text-red-300 bg-red-950/30" :
        tone === "warning" ? "border-amber-700/50 text-amber-300 bg-amber-950/30" :
        tone === "info" ? "border-sky-700/50 text-sky-300 bg-sky-950/30" :
        "border-border text-muted-foreground bg-secondary/50";
      return (
        <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded border ${toneCls}`}>
          {s(props.text)}
        </span>
      );
    }

    case "divider":
      return <hr className="border-border/60 my-1" />;

    case "keyValue": {
      const pairs = Array.isArray(props.pairs) ? props.pairs : [];
      return (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px]">
          {pairs.map((p, i) => {
            const pair = (p ?? {}) as Record<string, unknown>;
            return (
              <div key={i} className="contents">
                <dt className="text-muted-foreground">{s(pair.key)}</dt>
                <dd className="text-foreground">{s(pair.value)}</dd>
              </div>
            );
          })}
        </dl>
      );
    }

    case "table": {
      const cols = Array.isArray(props.columns) ? props.columns.map((c) => s(c)) : [];
      const rows = Array.isArray(props.rows) ? props.rows : [];
      return (
        <div className="overflow-x-auto rounded-md border border-border/60">
          <table className="w-full text-left text-[12px]">
            <thead className="bg-secondary/60">
              <tr>{cols.map((c, i) => (
                <th key={i} className="px-2 py-1 font-medium text-muted-foreground">{c}</th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => {
                const cells = Array.isArray(r) ? r : [];
                return (
                  <tr key={ri} className="border-t border-border/60">
                    {cells.map((cell, ci) => (
                      <td key={ci} className="px-2 py-1 text-foreground">{s(cell)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }

    case "list": {
      const items = Array.isArray(props.items) ? props.items : [];
      const ordered = !!props.ordered;
      const Tag = ordered ? "ol" : "ul";
      return (
        <Tag className={`ml-5 space-y-0.5 text-[13px] text-foreground ${
          ordered ? "list-decimal" : "list-disc"
        } list-outside marker:text-muted-foreground`}>
          {items.map((it, i) => <li key={i}>{s(it)}</li>)}
        </Tag>
      );
    }

    case "code":
      return (
        <pre className="rounded-md bg-[#0c0c0c] border border-white/10 p-2.5 overflow-x-auto text-[11px] text-zinc-100 font-mono">
          {s(props.text)}
        </pre>
      );

    case "link": {
      const href = s(props.href);
      // Only http(s) links — never javascript:/data: (injection guard).
      const safe = /^https?:\/\//i.test(href);
      if (!safe) return <span className="text-muted-foreground">{s(props.text, href)}</span>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer"
          className="text-sky-400 underline underline-offset-2 hover:text-sky-300 break-all text-[13px]">
          {s(props.text, href)}
        </a>
      );
    }

    case "button": {
      const action = s(props.action);
      const label = s(props.label, "Action");
      const tone = s(props.tone, "default");
      const toneCls =
        tone === "primary" ? "border-emerald-600/70 bg-emerald-900/40 text-emerald-100 hover:bg-emerald-900/60" :
        tone === "danger" ? "border-red-700/60 bg-red-950/40 text-red-200 hover:bg-red-900/50" :
        "border-border bg-secondary/70 text-foreground hover:bg-secondary";
      return (
        <button
          type="button"
          disabled={!action || !onAction}
          onClick={() => action && onAction?.(action)}
          className={`text-left text-xs rounded-lg border px-3 py-1.5 transition-colors disabled:opacity-50 ${toneCls}`}
        >
          {label}
        </button>
      );
    }

    case "callout": {
      const tone = s(props.tone, "info");
      const toneCls =
        tone === "success" ? "border-emerald-700/40 bg-emerald-950/20" :
        tone === "error" ? "border-red-700/40 bg-red-950/20" :
        tone === "warning" ? "border-amber-700/40 bg-amber-950/20" :
        "border-sky-700/40 bg-sky-950/20";
      return (
        <div className={`rounded-md border px-3 py-2 space-y-1 ${toneCls}`}>
          {props.title != null && (
            <div className="text-[12px] font-semibold text-foreground">{s(props.title)}</div>
          )}
          {props.text != null && (
            <div className="text-[12px] text-muted-foreground">{s(props.text)}</div>
          )}
          {renderKids()}
        </div>
      );
    }

    case "icon": {
      // A Lucide icon by name (kebab/camel/Pascal accepted). On-brand, bundled,
      // no network. Unknown names fall back to a neutral glyph, never crash.
      const size = typeof props.size === "number" ? props.size : 16;
      const color = ICON_TONE[s(props.tone, "neutral")] ?? ICON_TONE.neutral;
      const label = s(props.label);
      // createElement (not <Icon/>) so the resolved Lucide component isn't seen
      // as a component declared during render (react-hooks/static-components).
      const glyph = createElement(resolveIcon(s(props.name)), {
        size, color, strokeWidth: 1.75,
        "aria-hidden": label ? undefined : true,
        "aria-label": label || undefined,
      });
      if (!label) return <span className="inline-flex align-middle">{glyph}</span>;
      return (
        <span className="inline-flex items-center gap-1.5 align-middle text-[13px] text-foreground">
          {glyph}
          <span>{label}</span>
        </span>
      );
    }

    case "template": {
      // Tier 2 — render a pre-designed animated component by name (data-only).
      // Interactive templates (formCard, optionPicker) receive the same
      // onAction channel buttons use, so their submits flow back to the agent.
      const name = s(props.name);
      const data = props.data;
      return renderTemplate(name, data, { onAction });
    }

    case "html": {
      // Tier 3 — agent-generated markup/JS, executed ONLY inside the isolated
      // opaque-origin iframe. Actions bridge back through the same onAction path.
      const code = s(props.code ?? props.html);
      if (!code) return null;
      const height =
        typeof props.height === "number" ? props.height : undefined;
      // Pre-resolve any Lucide icons the agent declared into inline SVG so the
      // sandbox can use them with no network (ccIcon / [data-cc-icon]).
      const icons = buildIconMap(props.icons);
      return (
        <SandboxedHtml
          html={code}
          height={height}
          onAction={onAction}
          theme={theme}
          icons={icons}
        />
      );
    }

    default:
      // Unknown type → inert, labelled fallback. NEVER render raw props/markup.
      if (!KNOWN_TYPES.has(type)) {
        return (
          <div className="rounded border border-dashed border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
            unsupported UI element{type ? `: ${type}` : ""}
          </div>
        );
      }
      return null;
  }
}

// ─── Public component ────────────────────────────────────────────────────

/**
 * Render a generative-UI tree (the value of a `generative_ui` CUSTOM event).
 * Accepts either a single node or `{ root: node }` / `{ view: node }` wrappers.
 */
export default function GenerativeUINode({
  spec, onAction,
}: {
  spec: unknown;
  onAction?: (action: string) => void;
}): React.ReactElement | null {
  const { resolvedTheme } = useTheme();
  const theme: "light" | "dark" = resolvedTheme === "light" ? "light" : "dark";
  const root =
    spec && typeof spec === "object"
      ? ((spec as Record<string, unknown>).root
        ?? (spec as Record<string, unknown>).view
        ?? spec)
      : spec;
  if (!root || typeof root !== "object") return null;
  return <Node node={root as GenUINode} onAction={onAction} theme={theme} />;
}
