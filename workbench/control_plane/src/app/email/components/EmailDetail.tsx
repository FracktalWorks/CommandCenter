"use client";

import { useState, useEffect, useRef } from "react";
import {
  Star, Reply, Forward, Trash2, Archive, MoreHorizontal,
  Paperclip, Download, ReplyAll, Flag, FolderInput,
  MailOpen, Tag, Printer, ExternalLink, X, AlertTriangle, Loader2, Send,
} from "lucide-react";
import { Email } from "../lib/types";
import { fullDateLabel, initials } from "../lib/utils";
import { useEmailStore } from "../lib/emailStore";
import {
  getAttachmentDownloadUrl, fetchFullBody, getEmail, listThread, createRule,
  fileToSendAttachment, type SendAttachment, type ArtifactAttachmentRef,
} from "../lib/api";
import { ArtifactAttachPicker } from "./ArtifactAttachPicker";
import { MessageContent } from "./MessageContent";
import { ConversationView, DraftCard, isDraftEmail } from "./ConversationView";
import { LabelMenu } from "./LabelMenu";
import { LabelChip } from "./LabelChip";
import { useViewMode } from "@/components/ViewModeProvider";

interface EmailDetailProps {
  email: Email | null;
}

export function EmailDetail({ email }: EmailDetailProps) {
  const {
    updateEmail, deleteEmail, openCompose, hydrateEmail, folders,
    accounts, selectedAccountId, sendEmail, saveDraft, sendDraft,
    viewerCommand, setViewerCommand,
  } = useEmailStore();
  const { isMobile } = useViewMode();
  const [starred, setStarred] = useState(email?.isStarred ?? false);
  const [read, setRead] = useState(email?.isRead ?? true);
  const [flagged, setFlagged] = useState(email?.isFlagged ?? false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [showLabelMenu, setShowLabelMenu] = useState(false);
  const [replyMode, setReplyMode] = useState<"reply" | "reply-all" | "forward" | null>(
    null
  );
  const [replyBody, setReplyBody] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [replyCc, setReplyCc] = useState("");
  const [replyBcc, setReplyBcc] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<SendAttachment[]>([]);
  const [replyArtifacts, setReplyArtifacts] = useState<ArtifactAttachmentRef[]>([]);
  const [sendErr, setSendErr] = useState<string | null>(null);
  // ── Auto-save (Gmail-style): the reply persists as a Drafts message as you
  //    type, so closing the composer never loses it. draftIdRef holds the local
  //    id of the saved draft so repeated saves update it in place (no dupes). ──
  const draftIdRef = useRef<string | null>(null);
  const replyDirty = useRef(false);
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [loadingFullBody, setLoadingFullBody] = useState(false);
  const [fullBodyText, setFullBodyText] = useState<string | null>(null);
  // Full message detail (body + attachments) fetched lazily on selection. The
  // list row often carries an empty body (Outlook syncs headers only), so we
  // always fetch the authoritative copy from the gateway when an email opens.
  const [detail, setDetail] = useState<Email | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // The full conversation (all messages sharing this thread_id), if any.
  const [thread, setThread] = useState<Email[] | null>(null);

  // Create an archive rule for this sender, then archive the open message.
  const blockSender = async () => {
    if (!email) return;
    const sender = email.from.email;
    const accountId = email.accountId || selectedAccountId;
    if (!sender || !accountId) return;
    try {
      await createRule({
        account_id: accountId,
        name: `Block ${sender}`.slice(0, 60),
        instructions: "",
        from_pattern: sender,
        enabled: true,
        automated: true,
        run_on_threads: false,
        conditional_operator: "OR",
        actions: [{ type: "ARCHIVE" }],
      });
    } catch {
      /* best-effort — still archive below */
    }
    updateEmail(email.id, { folder: "archive" });
  };

  // Download the open message as a .eml file.
  const downloadEml = () => {
    if (!email) return;
    const body = detail?.bodyText || email.bodyText || fullBodyText || "";
    const eml =
      `From: ${email.from.name} <${email.from.email}>\n` +
      `To: ${email.to.map((t) => t.email).join(", ")}\n` +
      `Subject: ${email.subject}\n` +
      `Date: ${email.receivedAt}\n\n` +
      body;
    const url = URL.createObjectURL(
      new Blob([eml], { type: "message/rfc822" })
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(email.subject || "email")
      .replace(/[^a-z0-9]+/gi, "_")
      .slice(0, 40)}.eml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Background refresh of the OPEN conversation (~20s) so an assistant-created
  // draft, or a reply that just synced from upstream, appears without reopening
  // the thread. Re-fetching keeps existing cards (keyed by message id — incl. a
  // draft you're editing) and only adds new ones. Pauses when the tab is hidden.
  useEffect(() => {
    if (!email?.threadId) return;
    const threadId = email.threadId;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      listThread(selectedAccountId ?? undefined, threadId)
        .then(setThread)
        .catch(() => {});
    };
    const id = setInterval(tick, 20000);
    return () => clearInterval(id);
  }, [email?.threadId, selectedAccountId]);

  // Fetch full content whenever the selected email changes.
  useEffect(() => {
    if (!email) {
      setDetail(null);
      setThread(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setThread(null);
    setFullBodyText(null);
    setReplyMode(null);
    draftIdRef.current = null;
    replyDirty.current = false;
    setDraftStatus("idle");
    // Pull the whole conversation so we can show a Gmail-style thread view.
    if (email.threadId) {
      listThread(selectedAccountId ?? undefined, email.threadId)
        .then((t) => { if (!cancelled) setThread(t); })
        .catch(() => { if (!cancelled) setThread(null); });
    }
    const needsBody = !email.bodyHtml && !email.bodyText;
    const needsAttachments = email.hasAttachments && (!email.attachments || email.attachments.length === 0);
    if (!needsBody && !needsAttachments) {
      setDetail(email);
      return;
    }
    setLoadingDetail(true);
    getEmail(email.id)
      .then((full) => {
        if (!cancelled) {
          setDetail(full);
          hydrateEmail(full);
        }
      })
      .catch(() => {
        if (!cancelled) setDetail(email); // fall back to list row
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Gmail-style auto-save ──
  // Debounce-persist the open reply/forward as a Drafts message once the user
  // edits it. Creates the draft on the first save (threaded for reply/reply-all)
  // and updates the same one thereafter, so closing the box never loses work.
  // NOTE: must stay ABOVE the `if (!email) return` early-return so the hook is
  // called on every render (moving it below crashes with a hooks-order error).
  useEffect(() => {
    if (!replyMode || !selectedAccountId || !email) return;
    if (!replyDirty.current) return; // ignore the prefilled quote — wait for edits
    const toArr = replyTo.split(",").map((s) => s.trim()).filter(Boolean);
    if (!replyBody.trim() && toArr.length === 0) return;
    const isForward = replyMode === "forward";
    const subj0 = email.subject || "";
    const subject = isForward
      ? (subj0.startsWith("Fwd:") ? subj0 : `Fwd: ${subj0}`)
      : (subj0.startsWith("Re:") ? subj0 : `Re: ${subj0}`);
    const body = replyBody;
    const handle = setTimeout(async () => {
      try {
        setDraftStatus("saving");
        const saved = await saveDraft({
          accountId: selectedAccountId,
          draftId: draftIdRef.current ?? undefined,
          // Reply/Reply-All thread onto the open message; Forward is standalone.
          replyToMessageId: isForward ? undefined : email.id,
          to: toArr,
          subject,
          body,
        });
        draftIdRef.current = saved.id;
        setDraftStatus("saved");
      } catch {
        setDraftStatus("idle");
      }
    }, 1200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyBody, replyTo, replyCc, replyMode, selectedAccountId, email?.id]);

  // Bridge for the desktop unified toolbar: it issues a transient store command
  // (reply/forward/block/download) that this viewer executes via the live
  // handlers captured in the ref below (kept in a ref so this effect — which
  // must sit above the early return — needn't reference them before they exist).
  const cmdRef = useRef<{
    reply: (m: "reply" | "reply-all" | "forward") => void;
    block: () => void;
    download: () => void;
  }>({ reply: () => {}, block: () => {}, download: () => {} });
  useEffect(() => {
    if (!viewerCommand) return;
    const h = cmdRef.current;
    if (viewerCommand === "block") h.block();
    else if (viewerCommand === "download") h.download();
    else h.reply(viewerCommand);
    setViewerCommand(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerCommand]);

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

  // Render the fullest copy we have (the lazily-fetched detail, or the list row).
  const view: Email = detail ?? email;

  const replyLabel =
    replyMode === "forward"
      ? "Forward"
      : replyMode === "reply-all"
        ? "Reply All"
        : "Reply";

  // The address of the account we're viewing from — excluded from reply-all
  // recipients so we don't reply to ourselves.
  const ownEmail = accounts
    .find((a) => a.id === selectedAccountId)?.emailAddress?.toLowerCase();

  /** Open the inline composer with recipients + a quoted body prefilled. */
  const startReply = (mode: "reply" | "reply-all" | "forward") => {
    setSendErr(null);
    // New reply session: forget any previous draft so we don't update it.
    draftIdRef.current = null;
    replyDirty.current = false;
    setDraftStatus("idle");
    setReplyBcc("");
    setReplyAttachments([]);
    setReplyArtifacts([]);
    // HTML-only mail (e.g. Outlook) has no bodyText — fall back to the snippet.
    const quoteSrc = view.bodyText || view.snippet || "";
    if (mode === "forward") {
      setReplyTo("");
      setReplyCc("");
      setReplyBody(
        `\n\n---------- Forwarded message ----------\n` +
        `From: ${view.from.name} <${view.from.email}>\n` +
        `Date: ${view.receivedAt}\nSubject: ${view.subject}\n\n${quoteSrc}`
      );
    } else {
      const recips =
        mode === "reply-all"
          ? [view.from.email, ...(view.to || []).map((t) => t.email)]
          : [view.from.email];
      const to = recips.filter(
        (e, i) => e && recips.indexOf(e) === i && e.toLowerCase() !== ownEmail
      );
      const cc =
        mode === "reply-all"
          ? (view.cc || [])
              .map((c) => c.email)
              .filter((e) => e && e.toLowerCase() !== ownEmail)
          : [];
      setReplyTo(to.join(", "));
      setReplyCc(cc.join(", "));
      setReplyBody(
        `\n\nOn ${view.receivedAt}, ${view.from.name} wrote:\n> ` +
        quoteSrc.replace(/\n/g, "\n> ")
      );
    }
    setReplyMode(mode);
  };

  const replySubject = () =>
    replyMode === "forward"
      ? email.subject.startsWith("Fwd:")
        ? email.subject
        : `Fwd: ${email.subject}`
      : email.subject.startsWith("Re:")
        ? email.subject
        : `Re: ${email.subject}`;

  const resetReplySession = () => {
    draftIdRef.current = null;
    replyDirty.current = false;
    setDraftStatus("idle");
    setReplyMode(null);
    setReplyBody("");
    setReplyTo("");
    setReplyCc("");
    setReplyBcc("");
    setReplyAttachments([]);
    setReplyArtifacts([]);
  };

  /** Send the reply/forward. If it was auto-saved as a draft we send that draft
   *  natively (Drafts → Sent, no duplicate); otherwise we send a fresh message. */
  const handleInlineSend = async () => {
    if (!email) return;
    if (!selectedAccountId) {
      setSendErr("No account selected");
      return;
    }
    const toArr = replyTo.split(",").map((s) => s.trim()).filter(Boolean);
    if (toArr.length === 0) {
      setSendErr("Add at least one recipient");
      return;
    }
    const ccArr = replyCc.split(",").map((s) => s.trim()).filter(Boolean);
    const bccArr = replyBcc.split(",").map((s) => s.trim()).filter(Boolean);
    const isForward = replyMode === "forward";
    try {
      // Native draft-send only when there's no Cc/Bcc and no attachments — the
      // draft write-path doesn't carry them, so those go via the full send (and
      // the auto-saved draft, if any, is discarded so it doesn't linger).
      if (
        draftIdRef.current && ccArr.length === 0 && bccArr.length === 0 &&
        replyAttachments.length === 0 && replyArtifacts.length === 0
      ) {
        const saved = await saveDraft({
          accountId: selectedAccountId,
          draftId: draftIdRef.current,
          replyToMessageId: isForward ? undefined : email.id,
          to: toArr,
          subject: replySubject(),
          body: replyBody,
        });
        await sendDraft(selectedAccountId, saved.id);
      } else {
        sendEmail({
          accountId: selectedAccountId,
          to: toArr,
          cc: ccArr.length ? ccArr : undefined,
          bcc: bccArr.length ? bccArr : undefined,
          subject: replySubject(),
          bodyText: replyBody,
          replyToMessageId: isForward ? undefined : email.providerMessageId,
          attachments: replyAttachments.length ? replyAttachments : undefined,
          artifacts: replyArtifacts.length ? replyArtifacts : undefined,
        });
        if (draftIdRef.current) {
          // Drop the lingering auto-saved draft now the message has been sent.
          void deleteEmail(draftIdRef.current);
        }
      }
    } catch (e: any) {
      setSendErr(e?.message || "Failed to send");
      return;
    }
    resetReplySession();
  };

  /** Read picked files into base64 and append them to the reply's attachments. */
  const addReplyFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    replyDirty.current = true;
    try {
      const added = await Promise.all(Array.from(files).map(fileToSendAttachment));
      setReplyAttachments((prev) => [...prev, ...added]);
    } catch {
      setSendErr("Couldn't read one of the attachments");
    }
  };

  /** Hand the current draft off to the full composer (Cc/Bcc, attachments). */
  const popOutToComposer = () => {
    openCompose({
      to: replyTo,
      subject: replySubject(),
      replyToBody: replyBody,
      replyToMessageId:
        replyMode === "forward" ? undefined : email.providerMessageId,
    });
    setReplyMode(null);
  };

  // Keep the command bridge pointed at the live handlers (runs each render).
  cmdRef.current = { reply: startReply, block: blockSender, download: downloadEml };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Main toolbar (MOBILE ONLY — on desktop the unified EmailToolbar
          below the page top bar provides these actions) ── */}
      {isMobile && (
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0 bg-card">
        {/* Left group */}
        <div className="flex items-center gap-0.5 flex-wrap">
          <TBtn
            icon={Reply}
            label="Reply"
            onClick={() => startReply("reply")}
            active={replyMode === "reply"}
          />
          <TBtn
            icon={ReplyAll}
            label="Reply All"
            onClick={() => startReply("reply-all")}
            active={replyMode === "reply-all"}
          />
          <TBtn
            icon={Forward}
            label="Forward"
            onClick={() => startReply("forward")}
            active={replyMode === "forward"}
          />

          <Divider />

          <TBtn icon={Archive} label="Archive" onClick={() => {
            if (email) updateEmail(email.id, { folder: "archive" });
          }} />
          <TBtn icon={Trash2} label="Delete" onClick={() => {
            if (email) deleteEmail(email.id);
          }} />
          <div className="relative">
            <TBtn
              icon={FolderInput}
              label="Move to folder"
              onClick={() => setShowMoveMenu((v) => !v)}
              active={showMoveMenu}
            />
            {showMoveMenu && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowMoveMenu(false)}
                />
                <div className="absolute left-0 top-full mt-1 z-20 bg-popover border border-border rounded-lg shadow-xl py-1 w-44 max-h-64 overflow-y-auto">
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Move to
                  </div>
                  {folders
                    .filter((f) => f.key !== "starred" && f.key !== email?.folder)
                    .map((f) => (
                      <button
                        key={f.key}
                        className="w-full text-left px-3 py-1.5 text-xs text-foreground/80 hover:text-foreground hover:bg-secondary transition-colors"
                        onClick={() => {
                          if (email) updateEmail(email.id, { folder: f.key });
                          setShowMoveMenu(false);
                        }}
                      >
                        {f.label}
                      </button>
                    ))}
                </div>
              </>
            )}
          </div>

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
          <div className="relative">
            <TBtn
              icon={Tag}
              label="Label"
              onClick={() => setShowLabelMenu((v) => !v)}
              active={showLabelMenu}
            />
            {showLabelMenu && email && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowLabelMenu(false)}
                />
                <div className="absolute left-0 top-full mt-1 z-20">
                  <LabelMenu email={email} />
                </div>
              </>
            )}
          </div>

          <Divider />

          <TBtn icon={Printer} label="Print" onClick={() => window.print()} />
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
                  {
                    label: "Mark as spam",
                    run: () => updateEmail(email.id, { folder: "junk" }),
                  },
                  {
                    label: "Report phishing",
                    run: () => updateEmail(email.id, { folder: "junk" }),
                  },
                  {
                    label: "Block sender",
                    run: () => blockSender(),
                  },
                  {
                    label: "Download email",
                    run: () => downloadEml(),
                  },
                ].map((item) => (
                  <button
                    key={item.label}
                    className="w-full text-left px-3 py-1.5 text-xs text-foreground/80 hover:text-foreground hover:bg-secondary transition-colors"
                    onClick={() => {
                      item.run();
                      setShowMoreMenu(false);
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      )}

      {/* ── Email content ── */}
      <div className="flex-1 overflow-y-auto scrollbar-hide px-6 py-5">
        {/* Subject + status badges */}
        <div className="flex items-start gap-2 mb-4">
          <h2 className="flex-1 text-foreground text-lg font-semibold">
            {email.subject}
          </h2>
          <div className="flex items-center gap-1 flex-shrink-0 mt-1">
            {view.importance === "high" && (
              <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 bg-red-500/15 text-red-400 rounded-full">
                <AlertTriangle size={9} /> Important
              </span>
            )}
            {flagged && (
              <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 bg-amber-500/15 text-amber-400 rounded-full">
                <Flag size={9} /> Flagged
              </span>
            )}
            {!read && (
              <span className="text-[9px] px-1.5 py-0.5 bg-primary/15 text-primary rounded-full">
                Unread
              </span>
            )}
          </div>
        </div>

        {/* Categories / labels — rendered in their assigned colours */}
        {view.categories && view.categories.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-4">
            {view.categories.map((cat) => (
              <LabelChip
                key={cat}
                name={cat}
                icon
                className="text-[10px] px-2 py-0.5"
              />
            ))}
          </div>
        )}

        {thread && thread.length > 1 ? (
          /* Conversation view — the whole thread, stacked */
          <ConversationView messages={thread} openedId={email.id} />
        ) : isDraftEmail(email) ? (
          /* Standalone draft — editable composer */
          <DraftCard draft={email} />
        ) : (
        <>
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
        {loadingDetail ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-6">
            <Loader2 size={14} className="animate-spin" /> Loading message…
          </div>
        ) : fullBodyText ? (
          <div className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap max-w-2xl">
            {fullBodyText}
          </div>
        ) : !view.bodyHtml && !view.bodyText ? (
          <div className="text-sm text-muted-foreground italic py-4">
            This message has no preview text.{" "}
            <button
              onClick={async () => {
                setLoadingFullBody(true);
                try {
                  const fb = await fetchFullBody(view.id);
                  setFullBodyText(fb.body_text || "(empty message)");
                } catch {
                  setFullBodyText("(failed to load message)");
                } finally {
                  setLoadingFullBody(false);
                }
              }}
              className="text-primary hover:opacity-80 not-italic"
            >
              {loadingFullBody ? "Loading…" : "Load from provider"}
            </button>
          </div>
        ) : (
          <MessageContent html={view.bodyHtml} text={view.bodyText} />
        )}

        {/* "Load full message" button — appears when body was truncated at sync */}
        {view.bodyTruncated && !fullBodyText && (
          <div className="mt-2">
            <button
              onClick={async () => {
                setLoadingFullBody(true);
                try {
                  const fb = await fetchFullBody(view.id);
                  setFullBodyText(fb.body_text);
                } catch {
                  // keep truncated body on failure
                } finally {
                  setLoadingFullBody(false);
                }
              }}
              disabled={loadingFullBody}
              className="flex items-center gap-1.5 text-xs text-primary hover:opacity-80 transition-opacity disabled:opacity-40"
            >
              <ExternalLink size={12} />
              {loadingFullBody ? "Loading…" : "Load full message from provider"}
            </button>
            <p className="text-[10px] text-muted-foreground mt-1">
              This message was truncated to save storage. Click to fetch the complete body.
            </p>
          </div>
        )}

        {/* Attachments */}
        {view.hasAttachments && view.attachments && view.attachments.length > 0 && (
          <div className="mt-6 pt-4 border-t border-border">
            <p className="text-xs text-muted-foreground mb-2">
              Attachments ({view.attachments.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {view.attachments.map((att) => {
                // Always go through the authenticated Next proxy — the absolute
                // gateway downloadUrl can't carry the internal token from a
                // browser, so it would 401.
                const url = getAttachmentDownloadUrl(att.id);
                const isImage = att.mimeType.startsWith("image/");
                return (
                  <div
                    key={att.id}
                    className="border border-border rounded-md overflow-hidden bg-secondary w-fit"
                  >
                    {isImage && (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open ${att.filename}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={url}
                          alt={att.filename}
                          className="max-h-40 max-w-[240px] object-contain bg-background block"
                        />
                      </a>
                    )}
                    <div className="flex items-center gap-2 px-3 py-2">
                      <Paperclip size={13} className="text-muted-foreground flex-shrink-0" />
                      <span
                        className="text-xs text-foreground truncate max-w-[160px]"
                        title={att.filename}
                      >
                        {att.filename}
                      </span>
                      {att.sizeBytes > 0 && (
                        <span className="text-[10px] text-muted-foreground flex-shrink-0">
                          {formatBytes(att.sizeBytes)}
                        </span>
                      )}
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        download={att.filename}
                        className="ml-1 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                        title={`Download ${att.filename}`}
                      >
                        <Download size={12} />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        </>
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
            {/* Recipients */}
            <div className="px-4 py-1.5 border-b border-border flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-7 flex-shrink-0">To</span>
              <input
                type="text"
                value={replyTo}
                onChange={(e) => { replyDirty.current = true; setReplyTo(e.target.value); }}
                placeholder="Recipients (comma-separated)…"
                className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
              />
            </div>
            <div className="px-4 py-1.5 border-b border-border flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-7 flex-shrink-0">Cc</span>
              <input
                type="text"
                value={replyCc}
                onChange={(e) => { replyDirty.current = true; setReplyCc(e.target.value); }}
                placeholder="Cc…"
                className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
              />
            </div>
            <div className="px-4 py-1.5 border-b border-border flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-7 flex-shrink-0">Bcc</span>
              <input
                type="text"
                value={replyBcc}
                onChange={(e) => { replyDirty.current = true; setReplyBcc(e.target.value); }}
                placeholder="Bcc…"
                className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
              />
            </div>
            <textarea
              value={replyBody}
              onChange={(e) => { replyDirty.current = true; setReplyBody(e.target.value); }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void handleInlineSend();
                }
              }}
              placeholder={`Write your ${replyLabel.toLowerCase()}…`}
              rows={6}
              autoFocus
              className="w-full bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground outline-none resize-none"
            />
            {(replyAttachments.length > 0 || replyArtifacts.length > 0) && (
              <div className="px-4 pb-2 flex flex-wrap gap-1.5">
                {replyAttachments.map((a, i) => (
                  <span
                    key={`f-${i}`}
                    className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border border-border bg-secondary text-muted-foreground"
                  >
                    <Paperclip size={10} />
                    <span className="truncate max-w-[140px]" title={a.filename}>
                      {a.filename}
                    </span>
                    <button
                      onClick={() =>
                        setReplyAttachments((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="hover:text-foreground"
                      title="Remove attachment"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {replyArtifacts.map((a, i) => (
                  <span
                    key={`a-${i}`}
                    className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border border-primary/40 bg-primary/5 text-primary"
                    title={a.path}
                  >
                    <Paperclip size={10} />
                    <span className="truncate max-w-[140px]">{a.name || a.path}</span>
                    <button
                      onClick={() =>
                        setReplyArtifacts((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="hover:text-foreground"
                      title="Remove attachment"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="px-4 py-2 bg-secondary/50 border-t border-border flex items-center justify-between gap-2">
              <span className="text-[10px] truncate">
                {sendErr ? (
                  <span className="text-red-500">{sendErr}</span>
                ) : draftStatus === "saving" ? (
                  <span className="text-muted-foreground">Saving draft…</span>
                ) : draftStatus === "saved" ? (
                  <span className="text-muted-foreground">Draft saved · Ctrl+Enter to send</span>
                ) : (
                  <span className="text-muted-foreground">Ctrl+Enter to send</span>
                )}
              </span>
              <div className="flex gap-2 flex-shrink-0 items-center">
                <label
                  className="px-2 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
                  title="Attach files"
                >
                  <Paperclip size={13} />
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      void addReplyFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
                <ArtifactAttachPicker
                  exclude={replyArtifacts.map((a) => a.path)}
                  onPick={(ref) => {
                    replyDirty.current = true;
                    setReplyArtifacts((prev) =>
                      prev.some((a) => a.path === ref.path) ? prev : [...prev, ref]);
                  }}
                />
                <button
                  className="px-3 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  onClick={popOutToComposer}
                  title="Open in the full composer (Bcc, attachments)"
                >
                  Pop out
                </button>
                <button
                  className="px-3 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  onClick={() => {
                    // Discard the auto-saved draft too (the X keeps it instead).
                    if (draftIdRef.current) void deleteEmail(draftIdRef.current);
                    setSendErr(null);
                    resetReplySession();
                  }}
                  title="Discard this draft"
                >
                  Discard
                </button>
                <button
                  className="px-4 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  disabled={!replyTo.trim() || !replyBody.trim()}
                  onClick={handleInlineSend}
                >
                  <Send size={12} />
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
