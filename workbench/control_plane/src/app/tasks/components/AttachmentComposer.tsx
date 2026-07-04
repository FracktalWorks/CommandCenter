"use client";

import { useRef, useState } from "react";
import { Paperclip, Link2, X, Loader2, Image as ImageIcon, FileText } from "lucide-react";
import { apiUploadAttachment } from "../lib/api";
import type { TaskAttachment } from "../lib/types";

/** Chip for one attachment (composer + read-only views share the look). */
export function AttachmentChip({
  att,
  onRemove,
}: {
  att: TaskAttachment;
  onRemove?: () => void;
}) {
  const Icon = att.kind === "image" ? ImageIcon : att.kind === "link" ? Link2 : FileText;
  return (
    <span className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground">
      <Icon className="h-3 w-3 shrink-0" />
      <a
        href={att.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="truncate hover:text-primary hover:underline"
      >
        {att.name}
      </a>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${att.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="tech-transition shrink-0 text-muted-foreground hover:text-destructive"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/** Read-only chip row for an item's attachments (cards, detail, clarify). */
export function AttachmentChips({ attachments }: { attachments?: TaskAttachment[] }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {attachments.map((a, i) => (
        <AttachmentChip key={`${a.url}-${i}`} att={a} />
      ))}
    </span>
  );
}

/**
 * Capture-time attachment composer: attach a photo/file (uploaded to the
 * gateway store) or paste a link — context kept WITH the capture (GTD:
 * "for more context later"). Controlled: the parent owns the list and
 * sends it with the capture.
 */
export function AttachmentComposer({
  attachments,
  onChange,
  compact = false,
}: {
  attachments: TaskAttachment[];
  onChange: (next: TaskAttachment[]) => void;
  compact?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded: TaskAttachment[] = [];
      for (const f of Array.from(files).slice(0, 5)) {
        uploaded.push(await apiUploadAttachment(f));
      }
      onChange([...attachments, ...uploaded]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const addLink = () => {
    const raw = linkUrl.trim();
    if (!raw) return;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let name = url;
    try {
      name = new URL(url).hostname + (new URL(url).pathname !== "/" ? new URL(url).pathname : "");
    } catch {
      /* keep raw as the name */
    }
    onChange([...attachments, { kind: "link", name: name.slice(0, 80), url }]);
    setLinkUrl("");
    setLinkOpen(false);
  };

  return (
    <div className={compact ? "" : "mt-1.5"}>
      {(attachments.length > 0 || error) && (
        <div className="mb-1 flex flex-wrap items-center gap-1">
          {attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.url}-${i}`}
              att={a}
              onRemove={() => onChange(attachments.filter((_, idx) => idx !== i))}
            />
          ))}
          {error && <span className="text-[11px] text-destructive">{error}</span>}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void addFiles(e.target.files)}
        />
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          title="Attach a photo or file"
          className="tech-transition inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Paperclip className="h-3.5 w-3.5" />
          )}
          {!compact && (uploading ? "Uploading…" : "Attach")}
        </button>
        {!linkOpen ? (
          <button
            type="button"
            onClick={() => setLinkOpen(true)}
            title="Add a link"
            className="tech-transition inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Link2 className="h-3.5 w-3.5" />
            {!compact && "Link"}
          </button>
        ) : (
          <span className="flex flex-1 items-center gap-1">
            <input
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addLink();
                }
                if (e.key === "Escape") setLinkOpen(false);
              }}
              placeholder="Paste a URL…"
              className="flex-1 rounded-md border border-border bg-background/60 px-2 py-1 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-[12px]"
            />
            <button
              type="button"
              onClick={addLink}
              className="tech-transition rounded-md px-1.5 py-1 text-[11px] font-medium text-primary hover:underline"
            >
              Add
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
