"use client";

/**
 * ArtifactViewerModal — renders agent-generated files with type-appropriate fidelity.
 *
 * Rendering matrix:
 *   .md                 → react-markdown + remark-gfm
 *   .py .ts .js .sh … → shiki syntax highlighter
 *   .pdf                → react-pdf (pdfjs-dist)
 *   .png .jpg .svg …   → <img> with zoom
 *   .csv .txt .log      → plain preformatted text
 *   other               → hex-dump excerpt + download button
 */

import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { FileEntry } from "./ArtifactSidebar";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ArtifactViewerModalProps {
  sessionId: string;
  entry: FileEntry;
  onClose: () => void;
}

type ViewerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "text"; content: string; lang?: string }
  | { status: "markdown"; content: string }
  | { status: "image"; url: string }
  | { status: "pdf"; url: string }
  | { status: "binary"; hex: string; filename: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getExt(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

const CODE_EXTS = new Set([
  "py","ts","tsx","js","jsx","sh","bash","zsh","fish",
  "yaml","yml","toml","json","sql","rs","go","java","c",
  "cpp","cs","rb","php","swift","kt","scala","r","lua",
  "html","css","scss","less","xml","graphql","proto",
]);

const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","webp","svg","ico","bmp","tiff"]);
const TEXT_EXTS  = new Set(["txt","log","csv","tsv","rst","ini","cfg","conf","env"]);

function classify(entry: FileEntry): "markdown" | "code" | "image" | "pdf" | "text" | "binary" {
  const ext = getExt(entry.name);
  if (ext === "md" || ext === "mdx")  return "markdown";
  if (CODE_EXTS.has(ext))              return "code";
  if (IMAGE_EXTS.has(ext))             return "image";
  if (ext === "pdf" || entry.mime_type === "application/pdf") return "pdf";
  if (TEXT_EXTS.has(ext) || entry.mime_type.startsWith("text/")) return "text";
  return "binary";
}

function langFromExt(ext: string): string {
  const map: Record<string, string> = {
    py: "python", ts: "typescript", tsx: "tsx", js: "javascript",
    jsx: "jsx", sh: "bash", bash: "bash", zsh: "bash",
    yaml: "yaml", yml: "yaml", toml: "toml", json: "json",
    sql: "sql", rs: "rust", go: "go", java: "java", c: "c",
    cpp: "cpp", cs: "csharp", rb: "ruby", php: "php",
    html: "html", css: "css", scss: "scss", xml: "xml",
  };
  return map[ext] ?? "plaintext";
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer.slice(0, 256));
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = Array.from(bytes.slice(i, i + 16));
    const hex = chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${i.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Code renderer (shiki) ────────────────────────────────────────────────────

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { codeToHtml } = await import("shiki");
        const result = await codeToHtml(code, {
          lang,
          theme: "github-dark",
        });
        if (!cancelled) setHtml(result);
      } catch {
        // Fallback: render plain
        if (!cancelled) setHtml(null);
      }
    })();
    return () => { cancelled = true; };
  }, [code, lang]);

  if (html) {
    return (
      <div
        className="overflow-x-auto text-sm font-mono leading-relaxed"
        // shiki injects its own background + colors; we strip the wrapper
        // background so our modal background shows through
        style={{ background: "transparent" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  // plain fallback
  return (
    <pre className="overflow-x-auto whitespace-pre text-sm font-mono text-zinc-300 leading-relaxed">
      {code}
    </pre>
  );
}

// ─── Markdown image path resolver ─────────────────────────────────────────────

/**
 * Rewrite an image src found inside a markdown file so it routes through the
 * gateway file proxy.
 *
 * Rules (in priority order):
 *  1. Already a full URL (http/https/data:) → pass through unchanged
 *  2. Absolute path starting with /          → treat as workspace-relative and proxy
 *  3. Relative path                          → resolve against the markdown file's
 *                                             directory, then proxy
 */
function resolveMediaSrc(src: string, sessionId: string, mdFilePath: string): string {
  // Full URLs and data URIs pass through unchanged
  if (/^(https?:|data:)/i.test(src)) return src;

  let workspacePath: string;
  if (src.startsWith("/")) {
    // Treat absolute paths as workspace-root-relative
    workspacePath = src.replace(/^\/+/, "");
  } else {
    // Relative: resolve against the directory containing the .md file
    const mdDir = mdFilePath.includes("/")
      ? mdFilePath.substring(0, mdFilePath.lastIndexOf("/"))
      : "";
    // Resolve ".." segments manually (URL has no filesystem resolve in browser)
    const parts = (mdDir ? `${mdDir}/${src}` : src).split("/");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "..") resolved.pop();
      else if (part !== ".") resolved.push(part);
    }
    workspacePath = resolved.join("/");
  }

  return `/api/agent/workspace/${sessionId}/file?path=${encodeURIComponent(workspacePath)}`;
}

// ─── PDF renderer (react-pdf) ─────────────────────────────────────────────────

type PdfComponents = {
  Document: React.ComponentType<{
    file: string;
    onLoadSuccess: (p: { numPages: number }) => void;
    loading?: React.ReactNode;
    error?: React.ReactNode;
    children?: React.ReactNode;
  }>;
  Page: React.ComponentType<{
    pageNumber: number;
    width?: number;
    renderTextLayer?: boolean;
    renderAnnotationLayer?: boolean;
  }>;
};

function PdfViewer({ url }: { url: string }) {
  const [pdf, setPdf] = useState<PdfComponents | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [page, setPage] = useState(1);

  // Dynamically import react-pdf and configure the worker once.
  // react-pdf 10.x bundles its OWN pdfjs-dist — we must point workerSrc
  // at the worker from THAT bundled copy, not the top-level pdfjs-dist.
  useEffect(() => {
    import("react-pdf")
      .then((mod) => {
        mod.pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        setPdf({
          Document: mod.Document as PdfComponents["Document"],
          Page: mod.Page as PdfComponents["Page"],
        });
      })
      .catch((e) => setLoadError(String(e)));
  }, []);

  if (loadError) {
    return <div className="py-8 text-red-400 text-sm">Failed to load PDF renderer: {loadError}</div>;
  }

  if (!pdf) {
    return <div className="flex items-center justify-center h-32 text-zinc-500 text-sm animate-pulse">Loading PDF renderer…</div>;
  }

  const { Document, Page } = pdf;

  return (
    <div className="flex flex-col items-center gap-3">
      <Document
        file={url}
        onLoadSuccess={({ numPages: n }) => { setNumPages(n); setPage(1); }}
        loading={<div className="py-8 text-zinc-500 text-sm">Loading PDF…</div>}
        error={<div className="py-8 text-red-400 text-sm">Failed to load PDF. Try downloading instead.</div>}
      >
        <Page
          pageNumber={page}
          width={Math.min(700, typeof window !== "undefined" ? window.innerWidth - 120 : 700)}
          renderTextLayer={false}
          renderAnnotationLayer={false}
        />
      </Document>
      {numPages > 1 && (
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded px-2 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 transition-colors"
          >
            ‹ Prev
          </button>
          <span>{page} / {numPages}</span>
          <button
            disabled={page >= numPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded px-2 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 transition-colors"
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ArtifactViewerModal({ sessionId, entry, onClose }: ArtifactViewerModalProps) {
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const blobUrlRef = useRef<string | null>(null);

  // Build the file URL and load content
  useEffect(() => {
    let cancelled = false;
    const fileUrl = `/api/agent/workspace/${sessionId}/file?path=${encodeURIComponent(entry.path)}`;
    const kind = classify(entry);

    // Revoke any previous blob URL
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    setState({ status: "loading" });

    (async () => {
      try {
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

        if (kind === "image") {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          if (!cancelled) setState({ status: "image", url });
          return;
        }

        if (kind === "pdf") {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          if (!cancelled) setState({ status: "pdf", url });
          return;
        }

        if (kind === "binary") {
          const buf = await res.arrayBuffer();
          if (!cancelled) setState({ status: "binary", hex: toHex(buf), filename: entry.name });
          return;
        }

        const text = await res.text();
        if (!cancelled) {
          if (kind === "markdown") {
            setState({ status: "markdown", content: text });
          } else if (kind === "code") {
            setState({ status: "text", content: text, lang: langFromExt(getExt(entry.name)) });
          } else {
            setState({ status: "text", content: text });
          }
        }
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: String(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, entry.path]);

  // Clean up blob URLs on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const downloadUrl = `/api/agent/workspace/${sessionId}/file?path=${encodeURIComponent(entry.path)}`;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Modal */}
      <div className="relative flex flex-col w-full max-w-4xl max-h-[90vh] rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl overflow-hidden mx-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-zinc-200 truncate">{entry.name}</span>
            <span className="text-xs text-zinc-600 truncate hidden sm:block">{entry.path}</span>
            <span className="text-xs text-zinc-700">· {formatBytes(entry.size)}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-3">
            <a
              href={downloadUrl}
              download={entry.name}
              className="rounded px-2 py-1 text-xs text-zinc-400 bg-zinc-800 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
            >
              Download
            </a>
            <button
              onClick={onClose}
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors text-lg leading-none"
              title="Close"
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-6 min-h-0">
          {state.status === "loading" && (
            <div className="flex items-center justify-center h-32">
              <div className="text-sm text-zinc-500 animate-pulse">Loading…</div>
            </div>
          )}

          {state.status === "error" && (
            <div className="rounded border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-400">
              {state.message}
            </div>
          )}

          {state.status === "markdown" && (
            <div className="prose prose-invert max-w-none
              prose-headings:font-semibold prose-headings:text-zinc-100
              prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg
              prose-p:text-zinc-300 prose-p:leading-7
              prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
              prose-strong:text-zinc-200 prose-em:text-zinc-300
              prose-code:text-sky-300 prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
              prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-700 prose-pre:text-zinc-300 prose-pre:text-sm
              prose-blockquote:border-zinc-600 prose-blockquote:text-zinc-400
              prose-hr:border-zinc-700
              prose-li:text-zinc-300 prose-li:marker:text-zinc-500
              prose-table:text-sm prose-thead:border-zinc-700 prose-tbody:border-zinc-800
              prose-th:text-zinc-300 prose-td:text-zinc-400
              prose-img:rounded prose-img:mx-auto"
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={{
                  // Rewrite image src: relative paths → gateway file proxy
                  img({ src, alt, ...rest }) {
                    const rawSrc = typeof src === "string" ? src : "";
                    const resolvedSrc = resolveMediaSrc(rawSrc, sessionId, entry.path);
                    // eslint-disable-next-line @next/next/no-img-element
                    return <img src={resolvedSrc} alt={alt ?? ""} {...rest} className="max-w-full rounded" />;
                  },
                  // Open links in a new tab and guard external URLs
                  a({ href, children, ...rest }) {
                    const isExternal = href?.startsWith("http");
                    return (
                      <a
                        href={href}
                        target={isExternal ? "_blank" : undefined}
                        rel={isExternal ? "noreferrer noopener" : undefined}
                        {...rest}
                      >
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {state.content}
              </ReactMarkdown>
            </div>
          )}

          {state.status === "text" && state.lang && (
            <CodeBlock code={state.content} lang={state.lang} />
          )}

          {state.status === "text" && !state.lang && (
            <pre className="whitespace-pre-wrap text-sm font-mono text-zinc-300 leading-relaxed">
              {state.content}
            </pre>
          )}

          {state.status === "image" && (
            <div className="flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={state.url}
                alt={entry.name}
                className="max-w-full max-h-[70vh] object-contain rounded"
              />
            </div>
          )}

          {state.status === "pdf" && (
            <PdfViewer url={state.url} />
          )}

          {state.status === "binary" && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-zinc-500">
                Binary file — showing first 256 bytes as hex
              </p>
              <pre className="overflow-x-auto text-xs font-mono text-zinc-400 bg-zinc-900 rounded p-3 leading-relaxed">
                {state.hex}
              </pre>
              <a
                href={downloadUrl}
                download={entry.name}
                className="self-start rounded px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
              >
                Download file
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
