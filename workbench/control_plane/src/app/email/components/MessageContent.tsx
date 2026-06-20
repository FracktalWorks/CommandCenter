"use client";

import { useEffect, useRef, useState } from "react";

interface MessageContentProps {
  /** Raw HTML body from the provider (preferred when present). */
  html?: string | null;
  /** Plain-text body (fallback when there is no HTML). */
  text: string;
}

/**
 * Renders an email body.
 *
 * HTML emails are rendered inside a sandboxed <iframe srcDoc> so remote markup,
 * scripts and styles cannot touch the surrounding app (no script execution, no
 * same-origin access, no top-navigation). The iframe auto-sizes to its content.
 *
 * Plain-text emails fall back to a pre-wrapped block.
 */
export function MessageContent({ html, text }: MessageContentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  const hasHtml = !!html && html.trim().length > 0;

  // Build a self-contained document with a readable base style. Links open in a
  // new tab; the sandbox blocks scripts entirely.
  const srcDoc = hasHtml
    ? `<!doctype html><html><head><meta charset="utf-8">
<base target="_blank">
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; padding:0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    font-size: 14px; line-height: 1.6; color: #e5e7eb; background: transparent;
    word-wrap: break-word; overflow-wrap: anywhere;
  }
  img, table { max-width: 100% !important; height: auto; }
  a { color: #93c5fd; }
  blockquote { border-left: 3px solid #4b5563; margin: 0; padding-left: 12px; color: #9ca3af; }
  pre { white-space: pre-wrap; }
</style></head><body>${html}</body></html>`
    : "";

  useEffect(() => {
    if (!hasHtml) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const resize = () => {
      try {
        const doc = iframe.contentDocument;
        if (doc?.body) {
          const h = Math.max(
            doc.body.scrollHeight,
            doc.documentElement.scrollHeight
          );
          setHeight(h + 16);
        }
      } catch {
        // cross-origin guard — ignore
      }
    };

    iframe.addEventListener("load", resize);
    // Re-measure shortly after load for late-loading images.
    const t = setTimeout(resize, 400);
    return () => {
      iframe.removeEventListener("load", resize);
      clearTimeout(t);
    };
  }, [hasHtml, srcDoc]);

  if (hasHtml) {
    return (
      <iframe
        ref={iframeRef}
        title="Email content"
        srcDoc={srcDoc}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        className="w-full border-0 bg-transparent"
        style={{ height }}
      />
    );
  }

  return (
    <div className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap max-w-2xl">
      {text}
    </div>
  );
}
