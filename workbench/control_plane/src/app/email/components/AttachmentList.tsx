"use client";

import { useState } from "react";
import { ChevronDown, Download, Eye, FileText } from "lucide-react";
import { Attachment } from "../lib/types";
import { getAttachmentDownloadUrl } from "../lib/api";
import { formatBytes } from "../lib/utils";
import ArtifactViewerModal from "@/components/ArtifactViewerModal";
import type { FileEntry } from "@/components/ArtifactSidebar";

// Show this many attachment cards before rolling the rest up behind a toggle —
// a long signature email (or a message with many files) would otherwise flood
// the reading pane with attachment chips.
const COLLAPSED_COUNT = 4;

/**
 * The attachment "download card" list — shared by the single-message reader
 * (EmailDetail) and each message card in a conversation (ConversationView), so
 * a thread's earlier messages surface their files the same way as the open one.
 *
 * Each attachment is a compact card: a small thumbnail (image attachments — the
 * thumbnail opens full-size in a new tab) or a file icon, the filename + size,
 * and a download link. The image bytes come through the same authenticated Next
 * proxy as the download, so no extra endpoint is needed for the preview.
 */
/** A synthetic FileEntry so an email attachment can be rendered by the shared
 *  ArtifactViewerModal. The modal keys its type detection off `name`/`mime_type`
 *  and fetches bytes from the `downloadUrl` override, so no workspace path or
 *  session is needed. */
function toFileEntry(att: Attachment): FileEntry {
  return {
    path: att.filename,
    name: att.filename,
    size: att.sizeBytes,
    modified_at: "",
    mime_type: att.mimeType || "application/octet-stream",
  };
}

export function AttachmentList({
  attachments,
  className = "",
}: {
  attachments?: Attachment[];
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // The attachment currently open in the pop-up viewer (null = closed). Images,
  // PDFs and documents all open in the same ArtifactViewerModal — never a new
  // browser tab or the side panel.
  const [viewing, setViewing] = useState<Attachment | null>(null);
  if (!attachments || attachments.length === 0) return null;

  const total = attachments.length;
  const overflow = total - COLLAPSED_COUNT;
  const shown = expanded ? attachments : attachments.slice(0, COLLAPSED_COUNT);

  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground mb-2">
        Attachments ({total})
      </p>
      <div className="flex flex-wrap gap-2">
        {shown.map((att) => {
          // Always go through the authenticated Next proxy — the absolute
          // gateway downloadUrl can't carry the internal token from a browser,
          // so it would 401.
          const url = getAttachmentDownloadUrl(att.id);
          const isImage = att.mimeType.startsWith("image/");
          return (
            <div
              key={att.id}
              className="flex items-center border border-border rounded-md bg-secondary overflow-hidden w-fit max-w-[260px]"
            >
              {/* Thumbnail / icon — opens the pop-up viewer. */}
              <button
                type="button"
                onClick={() => setViewing(att)}
                title={`Preview ${att.filename}`}
                className="flex-shrink-0 group relative"
              >
                {isImage ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={att.filename}
                      loading="lazy"
                      className="w-14 h-14 object-cover bg-background block"
                    />
                    <span className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-black/40">
                      <Eye size={14} className="text-white" />
                    </span>
                  </>
                ) : (
                  <span className="w-14 h-14 bg-background flex items-center justify-center group-hover:bg-secondary/60 transition-colors">
                    <FileText size={18} className="text-muted-foreground group-hover:text-foreground" />
                  </span>
                )}
              </button>
              {/* Filename / size — also opens the viewer. */}
              <button
                type="button"
                onClick={() => setViewing(att)}
                title={`Preview ${att.filename}`}
                className="min-w-0 px-2.5 py-1 text-left"
              >
                <div
                  className="text-xs text-foreground truncate max-w-[150px]"
                  title={att.filename}
                >
                  {att.filename}
                </div>
                {att.sizeBytes > 0 && (
                  <div className="text-[10px] text-muted-foreground">
                    {formatBytes(att.sizeBytes)}
                  </div>
                )}
              </button>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                download={att.filename}
                title={`Download ${att.filename}`}
                className="px-2 self-stretch flex items-center text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors flex-shrink-0"
              >
                <Download size={13} />
              </a>
            </div>
          );
        })}
      </div>
      {overflow > 0 && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronDown
            size={12}
            className={`transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Show fewer" : `Show all ${total} attachments`}
        </button>
      )}

      {/* Pop-up viewer — images, PDFs and documents all render here. Read-only:
          attachments aren't workspace files, so no edit/save/delete. */}
      {viewing && (
        <ArtifactViewerModal
          sessionId=""
          entry={toFileEntry(viewing)}
          downloadUrl={getAttachmentDownloadUrl(viewing.id)}
          readOnly
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
