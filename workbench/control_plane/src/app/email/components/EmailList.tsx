"use client";

import {
  Pencil, Trash2, Archive, Flag, FolderInput,
  Reply, ReplyAll, Forward, MailOpen, Tag, MoreHorizontal,
  Paperclip, Star, AlertTriangle,
} from "lucide-react";
import { Email } from "../lib/types";
import { timeLabel } from "../lib/utils";

interface EmailListProps {
  emails: Email[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCompose: () => void;
  onToolbarAction: (action: string, email: Email | null) => void;
  loading?: boolean;
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

export function EmailList({
  emails,
  selectedId,
  onSelect,
  onCompose,
  onToolbarAction,
  loading = false,
}: EmailListProps) {
  const selectedEmail = emails.find(e => e.id === selectedId) || null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Primary toolbar row */}
      <div className="flex items-center gap-0.5 px-2 pt-2 pb-1 border-b border-border flex-shrink-0">
        {/* Compose button — primary highlight */}
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

      {/* Secondary toolbar row */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border flex-shrink-0 bg-secondary/30">
        {TOOLBAR_SECONDARY.map(({ icon: Icon, label, key }) => (
          <ToolbarBtn key={key} icon={Icon} label={label} onClick={() => onToolbarAction(key, selectedEmail)} />
        ))}
        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground pr-1">
          {emails.length} msgs
        </span>
      </div>

      {/* Email rows */}
      <div className="flex-1 overflow-y-auto scrollbar-hide">
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
          emails.map((email) => (
            <button
              key={email.id}
              onClick={() => onSelect(email.id)}
              className={`w-full text-left border-b border-border px-3 py-3 transition-colors flex flex-col gap-1 ${
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

              {/* Categories / user labels */}
              {email.categories.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {email.categories.slice(0, 3).map((label) => (
                    <span
                      key={label}
                      className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function ToolbarBtn({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  onClick?: () => void;
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
