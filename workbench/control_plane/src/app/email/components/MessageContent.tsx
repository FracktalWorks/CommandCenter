"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { ImageOff } from "lucide-react";

interface MessageContentProps {
  /** Raw HTML body from the provider (preferred when present). */
  html?: string | null;
  /** Plain-text body (fallback when there is no HTML). */
  text: string;
}

/** Matches a remote (http/https) URL inside src/srcset/poster/background or CSS url(). */
const REMOTE_RE = /(?:src|srcset|poster|background)\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:/i;

/**
 * Sanitize an untrusted HTML email body. Runs only in the browser (DOMPurify
 * needs a DOM). Strips scripts/handlers/dangerous tags; keeps <style>/inline
 * styles so the email still looks like the email. Forces links to open in a new
 * tab. Remote-resource *loading* is gated separately by the iframe CSP — here we
 * only sanitize and report whether remote content is present.
 */
function sanitizeEmailHtml(raw: string): { clean: string; hasRemote: boolean } {
  const hadAnchorHook = "afterSanitizeAttributes";
  DOMPurify.addHook(hadAnchorHook, (node) => {
    if ((node as Element).tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
  const clean = DOMPurify.sanitize(raw, {
    // Defense in depth — the iframe sandbox already blocks scripts, but strip
    // the obvious dangerous structural tags too. <style> is intentionally kept.
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "base", "meta", "link"],
    FORBID_ATTR: ["ping"],
    ADD_ATTR: ["target"],
    ALLOW_DATA_ATTR: false,
    WHOLE_DOCUMENT: false,
  });
  DOMPurify.removeHook(hadAnchorHook);
  return { clean, hasRemote: REMOTE_RE.test(clean) };
}

/**
 * Renders an email body.
 *
 * HTML emails are rendered inside a sandboxed <iframe srcDoc>:
 *  - DOMPurify sanitizes the markup before it ever reaches the frame.
 *  - The sandbox has no allow-scripts, so JS never runs (allow-same-origin is
 *    present only so the parent can measure content height for auto-sizing).
 *  - A Content-Security-Policy meta blocks scripts entirely and gates remote
 *    images: blocked by default (defeats tracking pixels), allowed once the
 *    user clicks "Show images".
 *
 * Plain-text emails fall back to a pre-wrapped block.
 */
export function MessageContent({ html, text }: MessageContentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(400);
  const [mounted, setMounted] = useState(false);
  const [showImages, setShowImages] = useState(false);

  const hasHtml = !!html && html.trim().length > 0;

  // DOMPurify needs the DOM — defer sanitization to the client to avoid SSR
  // crashes and hydration mismatches on the iframe srcDoc.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => setMounted(true), []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Reset the image gate whenever the message changes — done during render
  // (React's recommended pattern) rather than in an effect.
  const [prevHtml, setPrevHtml] = useState(html);
  if (html !== prevHtml) {
    setPrevHtml(html);
    setShowImages(false);
  }

  const sanitized = useMemo(() => {
    if (!hasHtml || !mounted) return null;
    return sanitizeEmailHtml(html as string);
  }, [hasHtml, mounted, html]);

  const srcDoc = useMemo(() => {
    if (!sanitized) return "";
    // CSP: no scripts ever; styles inline (emails rely on them); images gated.
    const imgSrc = showImages ? "img-src data: https: http:;" : "img-src data:;";
    const mediaSrc = showImages ? "media-src https: http:;" : "media-src 'none';";
    const fontSrc = showImages ? "font-src data: https: http:;" : "font-src data:;";
    const csp =
      "default-src 'none'; script-src 'none'; object-src 'none'; " +
      "base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; " +
      imgSrc +
      mediaSrc +
      fontSrc;
    // Render on a white "sheet" with dark text — email HTML is authored for a
    // white background, so this stays readable in BOTH app themes (no more
    // white-on-white in light mode or dark-on-dark when mail sets its own
    // black text). This mirrors how Gmail/Outlook render message bodies.
    return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta charset="utf-8">
<base target="_blank">
<style>
  :root { color-scheme: light; }
  html,body { margin:0; padding:0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    font-size: 14px; line-height: 1.6; color: #1f2937; background: #ffffff;
    padding: 12px 14px;
    word-wrap: break-word; overflow-wrap: anywhere;
  }
  img, table { max-width: 100% !important; height: auto; }
  a { color: #2563eb; }
  blockquote { border-left: 3px solid #d1d5db; margin: 0; padding-left: 12px; color: #6b7280; }
  pre { white-space: pre-wrap; }
</style></head><body>${sanitized.clean}</body></html>`;
  }, [sanitized, showImages]);

  useEffect(() => {
    if (!srcDoc) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    let observer: ResizeObserver | null = null;

    const resize = () => {
      try {
        const doc = iframe.contentDocument;
        if (doc?.body) {
          const h = Math.max(
            doc.body.scrollHeight,
            doc.documentElement.scrollHeight
          );
          if (h > 0) setHeight(h + 24);
          // Keep tracking growth as images/fonts settle in.
          if (!observer && typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(resize);
            observer.observe(doc.body);
          }
        }
      } catch {
        // cross-origin guard — ignore
      }
    };

    iframe.addEventListener("load", resize);
    // Re-measure a few times after load for late-loading images/web fonts.
    const timers = [200, 600, 1200].map((d) => setTimeout(resize, d));
    return () => {
      iframe.removeEventListener("load", resize);
      timers.forEach(clearTimeout);
      observer?.disconnect();
    };
  }, [srcDoc]);

  if (hasHtml) {
    return (
      <div className="w-full">
        {sanitized?.hasRemote && !showImages && (
          <div className="flex items-center justify-between gap-2 mb-2 px-3 py-2 rounded-md bg-secondary border border-border text-xs">
            <span className="flex items-center gap-2 text-muted-foreground">
              <ImageOff size={13} />
              Remote images are blocked to protect your privacy.
            </span>
            <button
              onClick={() => setShowImages(true)}
              className="text-primary hover:opacity-80 font-medium whitespace-nowrap"
            >
              Show images
            </button>
          </div>
        )}
        {/* Render the frame only after mount so srcDoc is the sanitized client
            value (avoids an SSR hydration mismatch on the attribute). */}
        {mounted ? (
          <iframe
            ref={iframeRef}
            title="Email content"
            srcDoc={srcDoc}
            // allow-same-origin (without allow-scripts) lets us measure content
            // height for auto-sizing; scripts still never run.
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            className="w-full border border-border rounded-md bg-white"
            style={{ height, minHeight: 200 }}
          />
        ) : (
          <div style={{ minHeight: 200 }} />
        )}
      </div>
    );
  }

  return (
    <div className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap max-w-2xl">
      {text}
    </div>
  );
}
