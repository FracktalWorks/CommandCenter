"use client";

import { useState } from "react";
import {
  Star, Reply, Forward, Trash2, Archive, MoreHorizontal,
  Paperclip, Download, ReplyAll, Flag, FolderInput,
  MailOpen, Tag, Printer, ExternalLink, X,
} from "lucide-react";
import { Email } from "../lib/types";
import { fullDateLabel, initials } from "../lib/utils";

interface EmailDetailProps {
  email: Email | null;
}

export function EmailDetail({ email }: EmailDetailProps) {
  const [starred, setStarred] = useState(email?.isStarred ?? false);
  const [read, setRead] = useState(email?.isRead ?? true);
  const [flagged, setFlagged] = useState(email?.isFlagged ?? false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [replyMode, setReplyMode] = useState<"reply" | "reply-all" | "forward" | null>(
    null
  );

  // Keep state in sync when email changes
  if (email && starred !== email.isStarred) setStarred(email.isStarred);
  if (email && read !== email.isRead) setRead(email.isRead);
  if (email && flagged !== email.isFlagged) setFlagged(email.isFlagged);

  if (!email) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-muted-foreground gap-3">
        <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
          </svg>
        </div>
        <p className="text-sm">Select an email to read</p>
      </div>
    );
  }

  const replyLabel =
    replyMode === "forward"
      ? "Forward"
      : replyMode === "reply-all"
        ? "Reply All"
        : "Reply";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Main toolbar ── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0 bg-card">
        {/* Left group */}
        <div className="flex items-center gap-0.5 flex-wrap">
          <TBtn
            icon={Reply}
            label="Reply"
            onClick={() => setReplyMode("reply")}
            active={replyMode === "reply"}
          />
          <TBtn
            icon={ReplyAll}
            label="Reply All"
            onClick={() => setReplyMode("reply-all")}
            active={replyMode === "reply-all"}
          />
          <TBtn
            icon={Forward}
            label="Forward"
            onClick={() => setReplyMode("forward")}
            active={replyMode === "forward"}
          />

          <Divider />

          <TBtn icon={Archive} label="Archive" onClick={() => {}} />
          <TBtn icon={Trash2} label="Delete" onClick={() => {}} />
          <TBtn icon={FolderInput} label="Move" onClick={() => {}} />

          <Divider />

          <TBtn
            icon={Flag}
            label={flagged ? "Unflag" : "Flag"}
            onClick={() => setFlagged((v) => !v)}
            active={flagged}
          />
          <TBtn
            icon={Star}
            label={starred ? "Unstar" : "Star"}
            onClick={() => setStarred((v) => !v)}
            active={starred}
          />
          <TBtn
            icon={MailOpen}
            label={read ? "Mark as Unread" : "Mark as Read"}
            onClick={() => setRead((v) => !v)}
            active={!read}
          />
          <TBtn icon={Tag} label="Label" onClick={() => {}} />

          <Divider />

          <TBtn icon={Printer} label="Print" onClick={() => window.print()} />
          <TBtn icon={ExternalLink} label="Open in new tab" onClick={() => {}} />
        </div>

        {/* More menu */}
        <div className="relative">
          <TBtn
            icon={MoreHorizontal}
            label="More options"
            onClick={() => setShowMoreMenu((v) => !v)}
            active={showMoreMenu}
          />
          {showMoreMenu && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowMoreMenu(false)}
              />
              <div className="absolute right-0 top-full mt-1 z-20 bg-popover border border-border rounded-lg shadow-xl py-1 w-44">
                {[
                  "Mark as spam",
                  "Block sender",
                  "Create filter",
                  "Add to contacts",
                  "Download email",
                  "Report phishing",
                ].map((item) => (
                  <button
                    key={item}
                    className="w-full text-left px-3 py-1.5 text-xs text-foreground/80 hover:text-foreground hover:bg-secondary transition-colors"
                    onClick={() => setShowMoreMenu(false)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Email content ── */}
      <div className="flex-1 overflow-y-auto scrollbar-hide px-6 py-5">
        {/* Subject */}
        <div className="flex items-start gap-2 mb-4">
          <h2 className="flex-1 text-foreground text-lg font-semibold">
            {email.subject}
          </h2>
          {!read && (
            <span className="flex-shrink-0 text-[9px] px-1.5 py-0.5 bg-primary/15 text-primary rounded-full mt-1">
              Unread
            </span>
          )}
        </div>

        {/* Sender info */}
        <div className="flex items-start gap-3 mb-6">
          <div className="w-9 h-9 rounded-full bg-primary/20 text-primary flex items-center justify-center flex-shrink-0 text-xs font-semibold">
            {initials(email.from.name)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-sm font-medium text-foreground">
                {email.from.name}
              </span>
              <span className="text-xs text-muted-foreground">
                &lt;{email.from.email}&gt;
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              To: {email.to.map((t) => t.name || t.email).join(", ")}
            </div>
            {email.cc && email.cc.length > 0 && (
              <div className="text-xs text-muted-foreground">
                Cc: {email.cc.map((c) => c.name || c.email).join(", ")}
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              {fullDateLabel(email.receivedAt)}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap max-w-2xl">
          {email.bodyText}
        </div>

        {/* Attachment */}
        {email.hasAttachments && email.attachments && email.attachments.length > 0 && (
          <div className="mt-6 pt-4 border-t border-border">
            <p className="text-xs text-muted-foreground mb-2">
              Attachments ({email.attachments.length})
            </p>
            {email.attachments.map((att) => (
              <div
                key={att.id}
                className="flex items-center gap-2 bg-secondary rounded-md px-3 py-2 w-fit mb-1.5"
              >
                <Paperclip size={13} className="text-muted-foreground" />
                <span className="text-xs text-foreground">{att.filename}</span>
                <button className="ml-2 text-muted-foreground hover:text-foreground transition-colors">
                  <Download size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Reply / Forward composer */}
        {replyMode && (
          <div className="mt-8 border border-primary/30 rounded-lg overflow-hidden bg-secondary/30">
            <div className="px-4 py-2 bg-secondary text-xs text-muted-foreground border-b border-border flex items-center justify-between">
              <span>
                {replyLabel} to{" "}
                <span className="text-foreground">
                  {replyMode === "forward" ? "…" : email.from.name}
                </span>
              </span>
              <button
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setReplyMode(null)}
              >
                <X size={14} />
              </button>
            </div>
            {replyMode === "forward" && (
              <div className="px-4 py-1.5 border-b border-border">
                <input
                  type="text"
                  placeholder="To..."
                  className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
                />
              </div>
            )}
            <textarea
              placeholder={`Write your ${replyLabel.toLowerCase()}...`}
              rows={5}
              autoFocus
              className="w-full bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground outline-none resize-none"
            />
            <div className="px-4 py-2 bg-secondary/50 border-t border-border flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">
                Press Ctrl+Enter to send
              </span>
              <div className="flex gap-2">
                <button
                  className="px-3 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  onClick={() => setReplyMode(null)}
                >
                  Discard
                </button>
                <button className="px-3 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                  Send
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TBtn({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      className={`p-1.5 rounded transition-colors ${
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary"
      }`}
    >
      <Icon size={13} />
    </button>
  );
}

function Divider() {
  return <div className="w-px h-4 bg-border" />;
}
