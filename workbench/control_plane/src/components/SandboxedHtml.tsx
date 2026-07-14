"use client";

/**
 * SandboxedHtml — runs agent-GENERATED HTML/CSS/JS in a locked-down iframe.
 *
 * This is Tier 3 of generative UI (see GenerativeUINode): the escape hatch for
 * when no declarative primitive (Tier 1) or named template (Tier 2) fits and the
 * agent genuinely needs custom, animated, reactive markup it wrote on the fly.
 *
 * ── Trust model ────────────────────────────────────────────────────────────
 * The agent-authored code is NEVER trusted. It runs inside an <iframe> whose
 * `sandbox` attribute grants ONLY `allow-scripts` — deliberately WITHOUT
 * `allow-same-origin`. Consequences, all intentional:
 *   • the frame gets an opaque, unique origin → it cannot read our cookies,
 *     localStorage, IndexedDB, or reach any same-origin API;
 *   • it cannot touch the parent DOM (no window.parent.document access);
 *   • a strict CSP inside the srcdoc blocks network egress (no fetch/img/script
 *     to remote hosts) so generated code can't exfiltrate or beacon out;
 *   • navigation/top-level redirects are not granted.
 * The ONLY channel back to the app is `postMessage`, which we validate and map
 * onto the existing onAction(...) follow-up-message contract — the same contract
 * declarative buttons use. So a Tier-3 card is exactly as interactive as a
 * Tier-1 one, with none of the ambient authority.
 *
 * ── Icons without a network ────────────────────────────────────────────────
 * The CSP blocks remote images by design, so icons can't be pulled from a CDN.
 * Instead the parent pre-resolves the Lucide icons the agent asked for into
 * inline SVG STRINGS (buildIconMap) and injects them into the frame, exposed as
 * `ccIcon("Name")` and auto-filled into `[data-cc-icon]` placeholders. Icons are
 * data (SVG), so this preserves the no-network guarantee.
 *
 * ── React inside the frame ─────────────────────────────────────────────────
 * The frame is self-contained: it cannot import from our bundle. If the agent
 * wants React it must inline it. To keep generated code both capable and offline
 * (CSP blocks CDNs), we do NOT ship React into the frame; agents author plain
 * HTML/CSS/JS (which can be arbitrarily animated/reactive via the DOM + CSS).
 * "React elements" in the product sense are served by Tier 2 templates, which
 * ARE real React components in our bundle. This is the safe division of labour:
 * our React (trusted, templated) vs. their DOM/JS (untrusted, sandboxed).
 */

import { useEffect, useMemo, useRef, useState } from "react";

interface SandboxedHtmlProps {
  /** Agent-authored HTML. May contain <style> and <script>. No external hosts. */
  html: string;
  /** Optional fixed height (px). Omit to auto-size to content via postMessage. */
  height?: number;
  /** Button/interaction actions bubble up here as follow-up messages. */
  onAction?: (action: string) => void;
  /** Viewer theme so generated CSS can adapt (exposed as data-theme + vars). */
  theme?: "light" | "dark";
  /** name → inline SVG string. Pre-resolved on the parent (Lucide, no network)
   *  so generated code can drop icons via ccIcon("name") or [data-cc-icon]. */
  icons?: Record<string, string>;
}

// A nonce-free but locked CSP: allow inline style/script (the generated code
// IS inline), forbid every remote fetch surface. 'unsafe-inline'/'unsafe-eval'
// are scoped to this opaque-origin frame only — they grant the generated code
// nothing outside its own sandbox.
const FRAME_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The bridge injected into every frame: exposes ccAction/ccIcon + auto-height.
 *  `__ICONS__` is replaced with the pre-resolved { name: svgString } JSON. */
const BRIDGE = `
<script>
  (function () {
    var ICONS = __ICONS__;
    // The ONLY way generated code talks to the app. Everything else is walled off.
    window.ccAction = function (action) {
      try { parent.postMessage({ __cc: true, kind: "action", action: String(action) }, "*"); }
      catch (e) {}
    };
    // Return the inline SVG string for a pre-resolved Lucide icon name (or "").
    window.ccIcon = function (name) { return ICONS[name] || ""; };
    // Delegate clicks on [data-cc-action] so agents don't need to wire handlers.
    document.addEventListener("click", function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-cc-action]") : null;
      if (el) window.ccAction(el.getAttribute("data-cc-action"));
    });
    // Auto-fill <span data-cc-icon="Name"></span> placeholders with the SVG.
    Array.prototype.forEach.call(document.querySelectorAll("[data-cc-icon]"), function (el) {
      var svg = ICONS[el.getAttribute("data-cc-icon")];
      if (svg) el.innerHTML = svg;
    });
    function reportHeight() {
      var h = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      );
      try { parent.postMessage({ __cc: true, kind: "height", height: h }, "*"); } catch (e) {}
    }
    window.addEventListener("load", reportHeight);
    if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.documentElement);
    setTimeout(reportHeight, 50);
    setTimeout(reportHeight, 300);
  })();
</script>`;

/** JSON for injection into a <script>: escape `<`/`>` and the U+2028/U+2029 line
 *  separators (legal in JSON, illegal bare in a JS string literal) so the value
 *  cannot break out of the script context. Uses charCode literals to avoid
 *  embedding the raw separators in this source file. */
function safeScriptJson(value: unknown): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(value ?? {})
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .split(LS).join("\\u2028")
    .split(PS).join("\\u2029");
}

function buildSrcDoc(
  html: string,
  theme: "light" | "dark",
  icons: Record<string, string>,
): string {
  // Base styling gives generated code sane defaults + our theme tokens without
  // it needing to know our design system. Generated <style> can override.
  const base = `
<style>
  :root { color-scheme: ${theme}; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    color: ${theme === "dark" ? "#e5e7eb" : "#111827"};
    background: transparent;
    padding: 2px;
  }
  * { box-sizing: border-box; }
  a { color: ${theme === "dark" ? "#7dd3fc" : "#0369a1"}; }
  [data-cc-icon] svg { display: inline-block; vertical-align: middle; }
</style>`;
  const bridge = BRIDGE.replace("__ICONS__", safeScriptJson(icons));
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
${base}</head><body>${html}${bridge}</body></html>`;
}

export default function SandboxedHtml({
  html,
  height,
  onAction,
  theme = "dark",
  icons,
}: SandboxedHtmlProps): React.ReactElement {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [autoHeight, setAutoHeight] = useState<number>(height ?? 120);

  const srcDoc = useMemo(
    () => buildSrcDoc(html, theme, icons ?? {}),
    [html, theme, icons],
  );

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      // Only trust messages from OUR frame's contentWindow, and only our shape.
      const frame = frameRef.current;
      if (!frame || ev.source !== frame.contentWindow) return;
      const data = ev.data;
      if (!data || typeof data !== "object" || (data as { __cc?: unknown }).__cc !== true) {
        return;
      }
      const kind = (data as { kind?: string }).kind;
      if (kind === "action") {
        const action = String((data as { action?: unknown }).action ?? "").slice(0, 2000);
        if (action) onAction?.(action);
      } else if (kind === "height" && height == null) {
        const h = Number((data as { height?: unknown }).height);
        // Clamp so a runaway document can't grow unbounded.
        if (Number.isFinite(h) && h > 0) setAutoHeight(Math.min(Math.max(h, 40), 2000));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onAction, height]);

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1 border-b border-border/50 bg-secondary/40">
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
          Generated UI
        </span>
        <span className="ml-auto text-[9px] text-muted-foreground/60">sandboxed</span>
      </div>
      <iframe
        ref={frameRef}
        // allow-scripts ONLY — no allow-same-origin (opaque origin, no ambient authority).
        sandbox="allow-scripts"
        // Belt-and-suspenders: also block by feature policy.
        allow=""
        referrerPolicy="no-referrer"
        title="Generated UI"
        srcDoc={srcDoc}
        style={{ width: "100%", height: height ?? autoHeight, border: "0", display: "block" }}
      />
    </div>
  );
}
