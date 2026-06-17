"use client";

import { useState } from "react";
import {
  Star, Reply, Forward, Trash2, Archive, MoreHorizontal,
  Paperclip, Download, ReplyAll, Flag, FolderInput,
  MailOpen, Tag, Printer, ExternalLink, X,
} from "lucide-react";
import { Email } from "../lib/types";
import { fullDateLabel, initials } from "../lib/utils";
import { useEmailStore } from "../lib/emailStore";
import { getAttachmentDownloadUrl } from "../lib/api";

interface EmailDetailProps {
  email: Email | null;
}

export function EmailDetail({ email }: EmailDetailProps) {
  const { updateEmail, deleteEmail, openCompose } = useEmailStore();
  const [starred, setStarred] = useState(email?.isStarred ?? false);
  const [read, setRead] = useState(email?.isRead ?? true);
  const [flagged, setFlagged] = useState(email?.isFlagged ?? false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [replyMode, setReplyMode] = useState<"reply" | "reply-all" | "forward" | null>(
    null
  );
  const [replyBody, setReplyBody] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [replySending, setReplySending] = useState(false);

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

          <TBtn icon={Archive} label="Archive" onClick={() => {
            if (email) updateEmail(email.id, { folder: "archive" });
          }} />
          <TBtn icon={Trash2} label="Delete" onClick={() => {
            if (email) deleteEmail(email.id);
          }} />
          <TBtn icon={FolderInput} label="Move" onClick={() => {}} />

          <Divider />

          <TBtn
            icon={Flag}
            label={flagged ? "Unflag" : "Flag"}
            onClick={() => {
              if (email) {
                setFlagged((v) => !v);
                updateEmail(email.id, { isFlagged: !flagged });
              }
            }}
            active={flagged}
          />
          <TBtn
            icon={Star}
            label={starred ? "Unstar" : "Star"}
            onClick={() => {
              if (email) {
                setStarred((v) => !v);
                updateEmail(email.id, { isStarred: !starred });
              }
            }}
            active={starred}
          />
          <TBtn
            icon={MailOpen}
            label={read ? "Mark as Unread" : "Mark as Read"}
            onClick={() => {
              if (email) {
                setRead((v) => !v);
                updateEmail(email.id, { isRead: !read });
              }
            }}
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
                <a
                  href={att.downloadUrl || getAttachmentDownloadUrl(att.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 text-muted-foreground hover:text-foreground transition-colors"
                  title={`Download ${att.filename}`}
                >
                  <Download size={12} />
                </a>
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
                  value={forwardTo}
                  onChange={(e) => setForwardTo(e.target.value)}
                  placeholder="To..."
                  className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
                />
              </div>
            )}
            <textarea
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
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
                  onClick={() => {
                    setReplyMode(null);
                    setReplyBody("");
                    setForwardTo("");
                  }}
                >
                  Discard
                </button>
                <button
                  className="px-3 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  disabled={replySending || (!replyBody.trim() && !forwardTo.trim())}
                  onClick={async () => {
                    if (!email || replySending) return;
                    setReplySending(true);
                    try {
                      if (replyMode === "forward") {
                        const fwdSubject = email.subject.startsWith("Fwd:")
                          ? email.subject
                          : `Fwd: ${email.subject}`;
                        const fwdBody = `\n\n---------- Forwarded message ----------\nFrom: ${email.from.name} <${email.from.email}>\nDate: ${email.receivedAt}\nSubject: ${email.subject}\n\n${email.bodyText}`;
                        await openCompose({
                          to: forwardTo || "",
                          subject: fwdSubject,
                          replyToBody: replyBody + fwdBody,
                        });
                      } else {
                        const replyTo = replyMode === "reply-all"
                          ? [email.from.email, ...(email.to || []).filter(t => t.email !== email.from.email).map(t => t.email)].join(", ")
                          : email.from.email;
                        const reSubject = email.subject.startsWith("Re:")
                          ? email.subject
                          : `Re: ${email.subject}`;
                        const quotedBody = `\n\nOn ${email.receivedAt}, ${email.from.name} wrote:\n> ${email.bodyText.replace(/\n/g, "\n> ")}`;
                        await openCompose({
                          to: replyTo,
                          subject: reSubject,
                          replyToBody: replyBody + quotedBody,
                          replyToMessageId: email.providerMessageId,
                        });
                      }
                      setReplyMode(null);
                      setReplyBody("");
                      setForwardTo("");
                    } finally {
                      setReplySending(false);
                    }
                  }}
                >
                  {replySending ? "Opening…" : "Continue in composer"}
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
