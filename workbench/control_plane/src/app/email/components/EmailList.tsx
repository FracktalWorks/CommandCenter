"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Pencil, Trash2, Archive, Flag, FolderInput,
  Reply, ReplyAll, Forward, MailOpen, Mail, Tag, MoreHorizontal,
  Paperclip, Star, AlertTriangle, ChevronRight, Loader2, Check, CheckSquare, X,
  MessagesSquare,
} from "lucide-react";
import { Email } from "../lib/types";
import { timeLabel } from "../lib/utils";
import { useEmailStore } from "../lib/emailStore";
import { LabelMenu } from "./LabelMenu";

interface EmailListProps {
  emails: Email[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCompose: () => void;
  onToolbarAction: (action: string, email: Email | null) => void;
  loading?: boolean;
  total?: number;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  onBackfill?: () => void;
  backfilling?: boolean;
  canBackfill?: boolean;
}

const TOOLBAR_PRIMARY = [
  { icon: Trash2, label: "Delete", key: "delete" },
  { icon: Archive, label: "Archive", key: "archive" },
  { icon: Flag, label: "Flag", key: "flag" },
  { icon: FolderInput, label: "Move", key: "move" },
];

const TOOLBAR_SECONDARY = [
  { icon: Reply, label: "Reply", key: "reply" },
  { icon: ReplyAll, label: "Reply All", key: "reply-all" },
  { icon: Forward, label: "Forward", key: "forward" },
  { icon: MailOpen, label: "Mark as Read", key: "mark-read" },
  { icon: Tag, label: "Label", key: "label" },
];

interface CtxState {
  x: number;
  y: number;
  email: Email;
}

export function EmailList({
  emails,
  selectedId,
  onSelect,
  onCompose,
  onToolbarAction,
  loading = false,
  total,
  onLoadMore,
  loadingMore = false,
  onBackfill,
  backfilling = false,
  canBackfill = false,
}: EmailListProps) {
  const selectedEmail = emails.find((e) => e.id === selectedId) || null;
  const {
    updateEmail, deleteEmail, folders, selectedFolder,
    selectedLabel, selectLabel,
  } = useEmailStore();
  const [ctx, setCtx] = useState<CtxState | null>(null);

  // ── Bulk selection ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Clear the selection when the folder changes (render-time reset, not effect).
  const [prevFolder, setPrevFolder] = useState(selectedFolder);
  if (selectedFolder !== prevFolder) {
    setPrevFolder(selectedFolder);
    setSelected(new Set());
  }
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = emails.length > 0 && emails.every((e) => selected.has(e.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(emails.map((e) => e.id)));
  const clearSelection = () => setSelected(new Set());
  const bulkUpdate = (
    updates: Partial<Pick<Email, "isRead" | "isStarred" | "isFlagged" | "folder">>
  ) => {
    selected.forEach((id) => updateEmail(id, updates));
    clearSelection();
  };
  const bulkDelete = () => {
    selected.forEach((id) => deleteEmail(id));
    clearSelection();
  };

  const openContextAt = (px: number, py: number, email: Email) => {
    // Clamp so the menu stays on-screen.
    const menuW = 210;
    const menuH = 380;
    const x = Math.min(px, window.innerWidth - menuW);
    const y = Math.min(py, window.innerHeight - menuH);
    setCtx({ x: Math.max(8, x), y: Math.max(8, y), email });
  };
  const openContext = (e: React.MouseEvent, email: Email) => {
    e.preventDefault();
    openContextAt(e.clientX, e.clientY, email);
  };

  // Long-press → context menu on touch devices (mirrors right-click).
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpFired = useRef(false);
  const startLongPress = (e: React.TouchEvent, email: Email) => {
    const t = e.touches[0];
    lpFired.current = false;
    const { clientX, clientY } = t;
    lpTimer.current = setTimeout(() => {
      lpFired.current = true;
      openContextAt(clientX, clientY, email);
    }, 500);
  };
  const cancelLongPress = () => {
    if (lpTimer.current) {
      clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
  };

  const hasMore = total !== undefined && emails.length < total;
  const canPageProvider = !hasMore && canBackfill && !!onBackfill;

  // ── Auto-load on scroll ──
  // When the bottom sentinel scrolls into view, page the next batch: first from
  // what's already synced (DB), then — once that's exhausted — pull older mail
  // from the provider (backfill). Replaces the manual "Load more" buttons.
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const handleAutoLoad = useCallback(() => {
    if (loadingMore || backfilling) return;
    if (hasMore) onLoadMore?.();
    else if (canPageProvider) onBackfill?.();
  }, [loadingMore, backfilling, hasMore, canPageProvider, onLoadMore, onBackfill]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) handleAutoLoad();
      },
      { root: scrollRef.current, rootMargin: "300px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleAutoLoad]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Primary toolbar row */}
      <div className="flex items-center gap-0.5 px-2 pt-2 pb-1 border-b border-border flex-shrink-0">
        <button
          title="New Email"
          onClick={onCompose}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors mr-1"
        >
          <Pencil size={12} />
          <span className="text-[10px] font-medium">New</span>
        </button>

        {TOOLBAR_PRIMARY.map(({ icon: Icon, label, key }) => (
          <ToolbarBtn key={key} icon={Icon} label={label} onClick={() => onToolbarAction(key, selectedEmail)} />
        ))}

        <div className="flex-1" />

        <button
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          title="More actions"
        >
          <MoreHorizontal size={13} />
        </button>
      </div>

      {/* Secondary toolbar row — becomes a bulk-action bar when rows are picked */}
      {selected.size > 0 ? (
        <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border flex-shrink-0 bg-primary/10 overflow-x-auto scrollbar-hide">
          <button
            onClick={toggleAll}
            title={allSelected ? "Deselect all" : "Select all"}
            className="p-1.5 rounded text-primary hover:bg-secondary transition-colors"
          >
            <CheckSquare size={13} />
          </button>
          <span className="text-[10px] font-medium text-foreground px-1">
            {selected.size} selected
          </span>
          <div className="flex-1" />
          <ToolbarBtn icon={MailOpen} label="Mark read" onClick={() => bulkUpdate({ isRead: true })} />
          <ToolbarBtn icon={Mail} label="Mark unread" onClick={() => bulkUpdate({ isRead: false })} />
          <ToolbarBtn icon={Flag} label="Flag" onClick={() => bulkUpdate({ isFlagged: true })} />
          <ToolbarBtn icon={Archive} label="Archive" onClick={() => bulkUpdate({ folder: "archive" })} />
          <ToolbarBtn icon={Trash2} label="Delete" onClick={bulkDelete} />
          <button
            onClick={clearSelection}
            title="Clear selection"
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border flex-shrink-0 bg-secondary/30 overflow-x-auto scrollbar-hide">
          {TOOLBAR_SECONDARY.map(({ icon: Icon, label, key }) => (
            <ToolbarBtn
              key={key}
              icon={Icon}
              label={label}
              onClick={(e) => {
                // "Label" opens the label picker (the context menu, which hosts
                // LabelMenu) anchored at the button for the selected message.
                if (key === "label") {
                  if (selectedEmail) {
                    setCtx({ x: e.clientX, y: e.clientY + 12, email: selectedEmail });
                  }
                } else {
                  onToolbarAction(key, selectedEmail);
                }
              }}
            />
          ))}
          <div className="flex-1" />
          <span className="text-[10px] text-muted-foreground pr-1">
            {emails.length}
            {total !== undefined && total > emails.length ? ` of ${total}` : ""} msgs
          </span>
        </div>
      )}

      {/* Active label filter */}
      {selectedLabel && (
        <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border flex-shrink-0 bg-primary/5 text-[11px]">
          <Tag size={11} className="text-primary flex-shrink-0" />
          <span className="text-foreground/70">
            Filtered by label <b className="text-primary">{selectedLabel}</b>
          </span>
          <button
            onClick={() => selectLabel(null)}
            title="Clear label filter"
            className="ml-auto flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
          >
            <X size={11} /> Clear
          </button>
        </div>
      )}

      {/* Email rows */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-hide">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-xs">Loading emails...</p>
          </div>
        ) : emails.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <MailOpen size={24} className="opacity-40" />
            <p className="text-xs">No emails to show</p>
          </div>
        ) : (
          <>
            {emails.map((email) => {
              const isSel = selected.has(email.id);
              return (
              <div
                key={email.id}
                className={`group flex items-stretch border-b border-border ${
                  isSel ? "bg-primary/5" : ""
                }`}
              >
                {/* Selection checkbox — shown on hover or when selected */}
                <button
                  onClick={() => toggleOne(email.id)}
                  title={isSel ? "Deselect" : "Select"}
                  className={`flex items-center pl-2 pr-1 flex-shrink-0 transition-opacity ${
                    isSel || selected.size > 0
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center ${
                      isSel
                        ? "bg-primary border-primary text-primary-foreground"
                        : "border-muted-foreground/40"
                    }`}
                  >
                    {isSel && <Check size={11} />}
                  </span>
                </button>
              <button
                onClick={() => {
                  // Suppress the tap-click that follows a long-press.
                  if (lpFired.current) {
                    lpFired.current = false;
                    return;
                  }
                  onSelect(email.id);
                }}
                onContextMenu={(e) => openContext(e, email)}
                onTouchStart={(e) => startLongPress(e, email)}
                onTouchMove={cancelLongPress}
                onTouchEnd={cancelLongPress}
                onTouchCancel={cancelLongPress}
                className={`flex-1 min-w-0 text-left pr-3 pl-1 py-3 transition-colors flex flex-col gap-1 select-none ${
                  selectedId === email.id
                    ? "bg-primary/10 border-l-2 border-l-primary"
                    : "hover:bg-secondary/50"
                }`}
              >
                {/* Sender + indicators + time */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {!email.isRead && (
                      <div className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 mt-0.5" />
                    )}
                    <span
                      className={`text-xs truncate ${
                        email.isRead ? "text-foreground/70" : "text-foreground font-medium"
                      }`}
                    >
                      {email.from.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {(email.threadCount ?? 1) > 1 && (
                      <span
                        className="inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded-full bg-secondary text-muted-foreground"
                        title={`${email.threadCount} messages in this conversation`}
                      >
                        <MessagesSquare size={9} />
                        {email.threadCount}
                      </span>
                    )}
                    {email.importance === "high" && (
                      <AlertTriangle size={10} className="text-red-400" />
                    )}
                    {email.hasAttachments && (
                      <Paperclip size={10} className="text-muted-foreground" />
                    )}
                    {email.isFlagged && (
                      <Flag size={10} className="text-amber-400 fill-amber-400" />
                    )}
                    {email.isStarred && (
                      <Star size={10} className="text-amber-400 fill-amber-400" />
                    )}
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {timeLabel(email.receivedAt)}
                    </span>
                  </div>
                </div>

                {/* Subject */}
                <div
                  className={`text-xs truncate ${
                    email.isRead ? "text-foreground/60" : "text-foreground"
                  }`}
                >
                  {email.subject}
                </div>

                {/* Preview */}
                <div className="text-[11px] text-muted-foreground truncate leading-relaxed">
                  {email.snippet}
                </div>

                {/* Categories / user labels — click to filter the list */}
                {email.categories.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {email.categories.slice(0, 3).map((label) => (
                      <span
                        key={label}
                        role="button"
                        tabIndex={0}
                        title={`Filter by “${label}”`}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          selectLabel(label);
                        }}
                        className={`text-[9px] px-1.5 py-0.5 rounded-full cursor-pointer transition-colors ${
                          selectedLabel === label
                            ? "bg-primary text-primary-foreground"
                            : "bg-primary/15 text-primary hover:bg-primary/30"
                        }`}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </button>
              </div>
              );
            })}

            {/* Auto-load sentinel: pages from the DB, then backfills from the
                provider. Tapping it also works if auto-load hasn't fired. */}
            {(hasMore || canPageProvider) && (
              <div ref={sentinelRef} className="p-2">
                <button
                  onClick={handleAutoLoad}
                  disabled={loadingMore || backfilling}
                  className="w-full flex items-center justify-center gap-1.5 py-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  {(loadingMore || backfilling) && (
                    <Loader2 size={12} className="animate-spin" />
                  )}
                  {backfilling
                    ? "Fetching older messages…"
                    : loadingMore
                      ? "Loading…"
                      : hasMore
                        ? `Load more (${emails.length} of ${total})`
                        : "Load older messages from server"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Right-click context menu */}
      {ctx && (
        <ContextMenu
          ctx={ctx}
          folders={folders}
          onClose={() => setCtx(null)}
          onReply={(k) => onToolbarAction(k, ctx.email)}
          onUpdate={(u) => updateEmail(ctx.email.id, u)}
          onDelete={() => deleteEmail(ctx.email.id)}
        />
      )}
    </div>
  );
}

function ContextMenu({
  ctx,
  folders,
  onClose,
  onReply,
  onUpdate,
  onDelete,
}: {
  ctx: CtxState;
  folders: { key: string; label: string }[];
  onClose: () => void;
  onReply: (action: string) => void;
  onUpdate: (
    updates: Partial<Pick<Email, "isRead" | "isStarred" | "isFlagged" | "folder">>
  ) => void;
  onDelete: () => void;
}) {
  const { email } = ctx;
  const [moveOpen, setMoveOpen] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const run = (fn: () => void) => {
    fn();
    onClose();
  };
  const moveTargets = folders.filter(
    (f) => f.key !== "starred" && f.key !== email.folder
  );

  return (
    <>
      {/* Outside-click / right-click catcher */}
      <div
        className="fixed inset-0 z-[80]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="fixed z-[81] w-52 bg-popover border border-border rounded-lg shadow-xl py-1 text-xs"
        style={{ left: ctx.x, top: ctx.y }}
      >
        <CtxItem icon={Reply} label="Reply" onClick={() => run(() => onReply("reply"))} />
        <CtxItem icon={ReplyAll} label="Reply All" onClick={() => run(() => onReply("reply-all"))} />
        <CtxItem icon={Forward} label="Forward" onClick={() => run(() => onReply("forward"))} />

        <CtxDivider />

        <CtxItem
          icon={email.isRead ? Mail : MailOpen}
          label={email.isRead ? "Mark as unread" : "Mark as read"}
          onClick={() => run(() => onUpdate({ isRead: !email.isRead }))}
        />
        <CtxItem
          icon={Flag}
          label={email.isFlagged ? "Clear flag" : "Flag / mark important"}
          onClick={() => run(() => onUpdate({ isFlagged: !email.isFlagged }))}
        />
        <CtxItem
          icon={Star}
          label={email.isStarred ? "Remove star" : "Add star"}
          onClick={() => run(() => onUpdate({ isStarred: !email.isStarred }))}
        />

        <CtxDivider />

        {/* Move to → */}
        <button
          className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-foreground/80 hover:text-foreground hover:bg-secondary transition-colors"
          onClick={() => setMoveOpen((v) => !v)}
        >
          <span className="flex items-center gap-2">
            <FolderInput size={13} /> Move to…
          </span>
          <ChevronRight
            size={12}
            className={`transition-transform ${moveOpen ? "rotate-90" : ""}`}
          />
        </button>
        {moveOpen && (
          <div className="max-h-40 overflow-y-auto bg-secondary/40 border-y border-border">
            {moveTargets.length === 0 ? (
              <div className="px-3 py-1.5 text-muted-foreground">No other folders</div>
            ) : (
              moveTargets.map((f) => (
                <button
                  key={f.key}
                  className="w-full text-left pl-8 pr-3 py-1.5 text-foreground/80 hover:text-foreground hover:bg-secondary transition-colors"
                  onClick={() => run(() => onUpdate({ folder: f.key }))}
                >
                  {f.label}
                </button>
              ))
            )}
          </div>
        )}
        {/* Label → */}
        <button
          className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-foreground/80 hover:text-foreground hover:bg-secondary transition-colors"
          onClick={() => setLabelOpen((v) => !v)}
        >
          <span className="flex items-center gap-2">
            <Tag size={13} /> Label…
          </span>
          <ChevronRight
            size={12}
            className={`transition-transform ${labelOpen ? "rotate-90" : ""}`}
          />
        </button>
        {labelOpen && (
          <div onClick={(e) => e.stopPropagation()}>
            <LabelMenu email={email} />
          </div>
        )}

        <CtxItem
          icon={Archive}
          label="Archive"
          onClick={() => run(() => onUpdate({ folder: "archive" }))}
        />

        <CtxDivider />

        <CtxItem
          icon={Trash2}
          label="Delete"
          danger
          onClick={() => run(onDelete)}
        />
      </div>
    </>
  );
}

function CtxItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-secondary ${
        danger
          ? "text-red-500 hover:text-red-400"
          : "text-foreground/80 hover:text-foreground"
      }`}
    >
      <Icon size={13} className="flex-shrink-0" />
      {label}
    </button>
  );
}

function CtxDivider() {
  return <div className="my-1 border-t border-border" />;
}

function ToolbarBtn({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
    >
      <Icon size={13} />
    </button>
  );
}
