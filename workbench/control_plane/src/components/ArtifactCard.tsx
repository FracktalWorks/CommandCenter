"use client";

/**
 * ArtifactCard — inline chat card for agent-generated files (images, markdown,
 * PDFs, CSVs, and other artifacts).
 *
 * Rendered inside the message thread whenever an agent emits an
 * artifact_created / artifact_updated custom event.  Clicking the card opens
 * the ArtifactViewerModal for full fidelity; images render inline as
 * thumbnails; downloadable files show an icon + size + download link.
 *
 * The proxy URL is constructed as:
 *   /api/agent/workspace/{sessionId}/file?path={rel_path}
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  File,
  FileCode,
  FileText,
  FileImage,
  FileSpreadsheet,
  Download,
  Maximize2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArtifactMeta {
  /** Relative path within the agent workspace, e.g. "outputs/chart.png". */
  path: string;
  /** Display name (basename of path). */
  name: string;
  /** File size in bytes (optional — shown when available). */
  size?: number;
  /** MIME type (optional — used for icon selection and rendering). */
  mimeType?: string;
  /** SHA-256 hex digest from the write_artifact tool (optional). */
  sha256?: string;
}

interface ArtifactCardProps {
  artifact: ArtifactMeta;
  sessionId: string;
  /** Called when the user clicks "open" to view in the full modal. */
  onOpen?: (entry: import("./ArtifactSidebar").FileEntry) => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff",
]);

const CODE_EXTS = new Set([
  "py", "ts", "tsx", "js", "jsx", "sh", "bash", "yaml", "yml",
  "toml", "json", "sql", "rs", "go", "java", "c", "cpp", "cs",
  "rb", "php", "swift", "kt", "html", "css", "scss", "xml",
]);

function getExt(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

function isImage(artifact: ArtifactMeta): boolean {
  const ext = getExt(artifact.name);
  if (IMAGE_EXTS.has(ext)) return true;
  if (artifact.mimeType?.startsWith("image/")) return true;
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(artifact: ArtifactMeta): React.ReactNode {
  const ext = getExt(artifact.name);
  const mime = artifact.mimeType ?? "";
  if (IMAGE_EXTS.has(ext) || mime.startsWith("image/"))
    return <FileImage size={15} className="shrink-0 text-purple-400" />;
  if (CODE_EXTS.has(ext))
    return <FileCode size={15} className="shrink-0 text-blue-400" />;
  if (["md", "txt", "log", "rst", "csv"].includes(ext) || mime.startsWith("text/"))
    return <FileText size={15} className="shrink-0 text-green-400" />;
  if (["pdf"].includes(ext) || mime === "application/pdf")
    return <FileText size={15} className="shrink-0 text-red-400" />;
  if (["xlsx", "xls"].includes(ext))
    return <FileSpreadsheet size={15} className="shrink-0 text-emerald-400" />;
  return <File size={15} className="shrink-0 text-zinc-400" />;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function ArtifactCard({
  artifact,
  sessionId,
  onOpen,
}: ArtifactCardProps) {
  const fileUrl = `/api/agent/workspace/${sessionId}/file?path=${encodeURIComponent(artifact.path)}`;
  const image = isImage(artifact);
  const [imgError, setImgError] = useState(false);

  // Build a FileEntry-compatible object for the ArtifactViewerModal
  const buildFileEntry = useCallback((): import("./ArtifactSidebar").FileEntry => ({
    path: artifact.path,
    name: artifact.name,
    size: artifact.size ?? 0,
    modified_at: new Date().toISOString(),
    mime_type: artifact.mimeType ?? "application/octet-stream",
  }), [artifact]);

  const handleOpen = () => {
    onOpen?.(buildFileEntry());
  };

  // ── Image artifact: render inline thumbnail ─────────────────────────────
  if (image && !imgError) {
    return (
      <div className="mt-3 rounded-xl overflow-hidden border border-zinc-700/60 bg-zinc-900/60 group/card">
        {/* Image */}
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={fileUrl}
            alt={artifact.name}
            className="w-full max-h-80 object-contain bg-zinc-950/50"
            loading="lazy"
            onError={() => setImgError(true)}
          />
          {/* Hover overlay with actions */}
          <div className="absolute inset-0 bg-black/0 group-hover/card:bg-black/40 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover/card:opacity-100">
            <button
              onClick={handleOpen}
              className="rounded-lg bg-zinc-800/90 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors flex items-center gap-1.5"
              title="Open full size"
            >
              <Maximize2 size={13} />
              Open
            </button>
            <a
              href={fileUrl}
              download={artifact.name}
              className="rounded-lg bg-zinc-800/90 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors flex items-center gap-1.5"
            >
              <Download size={13} />
              Download
            </a>
          </div>
        </div>
        {/* Caption bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-700/60">
          {fileIcon(artifact)}
          <span className="text-xs text-zinc-300 truncate flex-1 min-w-0 font-mono">
            {artifact.name}
          </span>
          {artifact.size != null && (
            <span className="text-[10px] text-zinc-600 shrink-0">{formatBytes(artifact.size)}</span>
          )}
        </div>
      </div>
    );
  }

  // ── Non-image artifact: file card ───────────────────────────────────────
  return (
    <div className="mt-3 rounded-xl border border-zinc-700/60 bg-zinc-900/60 px-3 py-2.5 flex items-center gap-3 group/card hover:border-zinc-600/80 transition-colors">
      {/* Icon */}
      <div className="shrink-0 w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center">
        {fileIcon(artifact)}
      </div>

      {/* File info */}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-zinc-200 truncate font-mono">
          {artifact.name}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-zinc-600 truncate">{artifact.path}</span>
          {artifact.size != null && (
            <span className="text-[10px] text-zinc-600">{formatBytes(artifact.size)}</span>
          )}
          {artifact.sha256 && (
            <span className="text-[10px] text-zinc-700 font-mono" title={`sha256:${artifact.sha256}`}>
              #{artifact.sha256.slice(0, 7)}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={handleOpen}
          className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
          title="Open in viewer"
        >
          <Maximize2 size={14} />
        </button>
        <a
          href={fileUrl}
          download={artifact.name}
          className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
          title="Download"
        >
          <Download size={14} />
        </a>
      </div>
    </div>
  );
}
