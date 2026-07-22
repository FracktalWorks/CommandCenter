"use client";

import { useState, useEffect, useRef } from "react";
import {
  Star, Reply, Forward, Trash2, Archive, MoreHorizontal,
  Paperclip, ReplyAll, Flag, FolderInput,
  MailOpen, Tag, Printer, ExternalLink, X, AlertTriangle, Loader2, Send,
  ListChecks,
} from "lucide-react";
import { Email } from "../lib/types";
import { fullDateLabel, initials, buildOptimisticSent, bodyMatchKey } from "../lib/utils";
import { useEmailStore, isRealFolder } from "../lib/emailStore";
import {
  fetchFullBody, getEmail, listThread, createRule,
  fileToSendAttachment, composeAssist,
  type SendAttachment, type ArtifactAttachmentRef,
} from "../lib/api";
import { ArtifactAttachPicker } from "./ArtifactAttachPicker";
import { ComposerQuote, AiButton, AiAssistBar } from "./ComposerAI";
import { MessageContent } from "./MessageContent";
import { AttachmentList } from "./AttachmentList";
import { SignaturePreview } from "./SignaturePreview";
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
    viewerCommand, setViewerCommand, triggerSync, softRefresh,
    captureEmailToTasks,
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
  // Which message in the thread the open composer is replying to (Outlook lets
  // you reply to any message in a conversation, not just the latest).
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  // The quoted trailing email, kept OUT of the editable textarea so it's never
  // edited (or fed to the AI drafter); reattached to the body on send.
  const [replyQuote, setReplyQuote] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [replyCc, setReplyCc] = useState("");
  const [replyBcc, setReplyBcc] = useState("");
  // Cc/Bcc rows are shown for Reply All (and Forward) and hidden for a
  // sender-only Reply; the toggle below flips this so the fields appear/vanish
  // with the reply mode. A manual reveal is offered when they're hidden.
  const [showReplyCc, setShowReplyCc] = useState(false);
  // AI draft/improve bar (sparkles button in the composer footer).
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [replyAttachments, setReplyAttachments] = useState<SendAttachment[]>([]);
  const [replyArtifacts, setReplyArtifacts] = useState<ArtifactAttachmentRef[]>([]);
  const [sendErr, setSendErr] = useState<string | null>(null);
  // ── Auto-save (Gmail-style): the reply persists as a Drafts message as you
  //    type, so closing the composer never loses it. draftIdRef holds the local
  //    id of the saved draft so repeated saves update it in place (no dupes). ──
  const draftIdRef = useRef<string | null>(null);
  // The resolved message object the composer is replying to — kept in a ref so
  // the auto-save effect / send handlers (which sit above the early return) read
  // the live target without re-subscribing. Set each render once `view` exists.
  const replyTargetRef = useRef<Email | null>(null);
  // The reply/forward composer block — scrolled into view when opened from a
  // conversation card so the draft box isn't off-screen below a long thread.
  const composerRef = useRef<HTMLDivElement>(null);
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
  // Just-sent replies shown optimistically until the provider sync mirrors the
  // real copy (kept in a ref so the periodic refetch can re-merge them).
  const optimisticSentRef = useRef<Email[]>([]);

  // Merge any still-unsynced optimistic sent replies into a freshly-fetched
  // thread, dropping the ones the real synced message now covers.
  const mergeThread = (fetched: Email[]): Email[] => {
    const pend = optimisticSentRef.current.filter((o) => {
      const key = bodyMatchKey(o.bodyText);
      if (!key) return false;
      const covered = fetched.some(
        (f) =>
          (f.folder || "").toLowerCase() === "sent" &&
          bodyMatchKey(f.bodyText).includes(key)
      );
      return !covered;
    });
    optimisticSentRef.current = pend;
    return pend.length ? [...fetched, ...pend] : fetched;
  };

  // After a reply is sent: show it instantly, then pull the real copy (sync +
  // a few staged thread/list refetches so the conversation and the Reply Zero
  // chip update within a couple of seconds, not on the next 20s tick).
  const refreshThreadAfterSend = (sent?: Email) => {
    if (sent) {
      optimisticSentRef.current = [...optimisticSentRef.current, sent];
      setThread((cur) => mergeThread(cur ?? []));
    }
    const acct = selectedAccountId ?? undefined;
    const threadId = email?.threadId;
    if (acct) void triggerSync(acct);
    if (!threadId) return;
    [1500, 4000, 8000].forEach((d) =>
      setTimeout(() => {
        listThread(acct, threadId)
          .then((t) => setThread(mergeThread(t)))
          .catch(() => {});
      }, d)
    );
    setTimeout(() => void softRefresh(), 5000);
  };

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
        .then((t) => setThread(mergeThread(t)))
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
    optimisticSentRef.current = []; // new conversation — drop pending sent cards
    setFullBodyText(null);
    setReplyMode(null);
    setReplyTargetId(null);
    setReplyQuote("");
    setAiOpen(false);
    setAiInstruction("");
    draftIdRef.current = null;
    replyDirty.current = false;
    setDraftStatus("idle");
    // Pull the whole conversation so we can show a Gmail-style thread view.
    if (email.threadId) {
      listThread(selectedAccountId ?? undefined, email.threadId)
        .then((t) => { if (!cancelled) setThread(mergeThread(t)); })
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
    const target = replyTargetRef.current ?? email;
    const subj0 = target.subject || "";
    const subject = isForward
      ? (subj0.startsWith("Fwd:") ? subj0 : `Fwd: ${subj0}`)
      : (subj0.startsWith("Re:") ? subj0 : `Re: ${subj0}`);
    // Persist the full outgoing message — new text plus the quoted trailing chain.
    const body = replyQuote
      ? `${replyBody.replace(/\s+$/, "")}\n\n${replyQuote}`
      : replyBody;
    const handle = setTimeout(async () => {
      try {
        setDraftStatus("saving");
        const saved = await saveDraft({
          accountId: selectedAccountId,
          draftId: draftIdRef.current ?? undefined,
          // Reply/Reply-All thread onto the target message; Forward is standalone.
          replyToMessageId: isForward ? undefined : target.id,
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
  }, [replyBody, replyQuote, replyTo, replyCc, replyMode, selectedAccountId, email?.id]);

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

  // The message the composer replies to. Defaults to the open message; a
  // conversation card can target any message in the thread (Outlook parity).
  const replyTarget: Email =
    (replyTargetId ? thread?.find((m) => m.id === replyTargetId) : undefined) ??
    view;
  replyTargetRef.current = replyTarget;

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

  /** Open the inline composer with recipients + a quoted body prefilled.
   *  `target` is the message being replied to (defaults to the open message);
   *  a conversation card passes the specific message the user chose. */
  const startReply = (
    mode: "reply" | "reply-all" | "forward",
    target?: Email
  ) => {
    const src = target ?? view;
    setReplyTargetId(src.id);
    setSendErr(null);
    // New reply session: forget any previous draft so we don't update it.
    draftIdRef.current = null;
    replyDirty.current = false;
    setDraftStatus("idle");
    setReplyBcc("");
    setReplyAttachments([]);
    setReplyArtifacts([]);
    setAiOpen(false);
    setAiInstruction("");
    // HTML-only mail (e.g. Outlook) has no bodyText — fall back to the snippet.
    const quoteSrc = src.bodyText || src.snippet || "";
    // The editable box starts EMPTY (just your new text). The quoted trailing
    // chain is kept separate in `replyQuote`, shown collapsed below the box and
    // reattached on send — so it can never be edited or AI-rewritten by mistake.
    setReplyBody("");
    // Reveal Cc/Bcc for Reply All / Forward; hide them for a sender-only Reply.
    setShowReplyCc(mode !== "reply");
    if (mode === "forward") {
      setReplyTo("");
      setReplyCc("");
      setReplyQuote(
        `---------- Forwarded message ----------\n` +
        `From: ${src.from.name} <${src.from.email}>\n` +
        `Date: ${src.receivedAt}\nSubject: ${src.subject}\n\n${quoteSrc}`
      );
    } else {
      const recips =
        mode === "reply-all"
          ? [src.from.email, ...(src.to || []).map((t) => t.email)]
          : [src.from.email];
      const to = recips.filter(
        (e, i) => e && recips.indexOf(e) === i && e.toLowerCase() !== ownEmail
      );
      const cc =
        mode === "reply-all"
          ? (src.cc || [])
              .map((c) => c.email)
              .filter((e) => e && e.toLowerCase() !== ownEmail)
          : [];
      setReplyTo(to.join(", "));
      setReplyCc(cc.join(", "));
      setReplyQuote(
        `On ${src.receivedAt}, ${src.from.name} wrote:\n> ` +
        quoteSrc.replace(/\n/g, "\n> ")
      );
    }
    setReplyMode(mode);
    // Bring the composer into view (it renders below a possibly-long thread).
    setTimeout(
      () => composerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
      60
    );
  };

  /** Switch reply mode without resetting the body/draft — only rebuilds recipients. */
  const switchReplyMode = (mode: "reply" | "reply-all") => {
    const src = replyTargetRef.current ?? view;
    const recips =
      mode === "reply-all"
        ? [src.from.email, ...(src.to || []).map((t: {email: string}) => t.email)]
        : [src.from.email];
    const to = recips.filter(
      (e, i) => e && recips.indexOf(e) === i && e.toLowerCase() !== ownEmail
    );
    const cc =
      mode === "reply-all"
        ? (src.cc || [])
            .map((c: {email: string}) => c.email)
            .filter((e: string | undefined) => e && e.toLowerCase() !== ownEmail)
        : [];
    setReplyTo(to.join(", "));
    setReplyCc(cc.join(", "));
    // Reply All reveals Cc/Bcc; narrowing to Reply hides them (and drops Bcc).
    setShowReplyCc(mode === "reply-all");
    if (mode === "reply") setReplyBcc("");
    setReplyMode(mode);
    replyDirty.current = true;
  };

  const replySubject = () => {
    const subj = replyTarget.subject || "";
    return replyMode === "forward"
      ? subj.startsWith("Fwd:")
        ? subj
        : `Fwd: ${subj}`
      : subj.startsWith("Re:")
        ? subj
        : `Re: ${subj}`;
  };

  const resetReplySession = () => {
    draftIdRef.current = null;
    replyDirty.current = false;
    setDraftStatus("idle");
    setReplyMode(null);
    setReplyBody("");
    setReplyQuote("");
    setReplyTo("");
    setReplyCc("");
    setReplyBcc("");
    setShowReplyCc(false);
    setReplyAttachments([]);
    setReplyArtifacts([]);
    setAiOpen(false);
    setAiInstruction("");
  };

  /** The full outgoing body: the user's new text plus the quoted trailing chain. */
  const composedReply = (newBody: string) =>
    replyQuote ? `${newBody.replace(/\s+$/, "")}\n\n${replyQuote}` : newBody;

  /** Draft or improve the reply with AI — operates on the NEW text only (the
   *  quoted trailing chain is never sent), then drops the result into the box. */
  const runAiDraft = async () => {
    if (!selectedAccountId || aiBusy) return;
    setSendErr(null);
    setAiBusy(true);
    try {
      const target = replyTargetRef.current ?? email;
      const toArr = replyTo.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await composeAssist({
        accountId: selectedAccountId,
        body: replyBody, // NEW text only — the quote is excluded by design
        instruction: aiInstruction.trim(),
        mode: replyMode === "forward" ? "forward" : "reply",
        messageId: target.id,
        to: toArr,
        subject: replyTarget.subject,
      });
      if (res.draft) {
        replyDirty.current = true;
        setReplyBody(res.draft);
        setAiOpen(false);
        setAiInstruction("");
      } else {
        setSendErr("AI couldn't draft this — try adding a quick instruction.");
      }
    } catch (e: any) {
      setSendErr(e?.message || "AI draft failed");
    } finally {
      setAiBusy(false);
    }
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
    const target = replyTargetRef.current ?? email;
    try {
      // Native draft-send now carries Cc/Bcc AND attachments (all stored on the
      // provider draft), so whenever there's a draft OR attachments we save the
      // draft with everything and send it natively (Drafts → Sent, no duplicate,
      // reply stays threaded). A plain reply with no draft/attachments still
      // sends fresh.
      const hasAtt = replyAttachments.length > 0 || replyArtifacts.length > 0;
      if (draftIdRef.current || hasAtt) {
        const saved = await saveDraft({
          accountId: selectedAccountId,
          draftId: draftIdRef.current ?? undefined,
          replyToMessageId: isForward ? undefined : target.id,
          to: toArr,
          cc: ccArr,
          bcc: bccArr,
          subject: replySubject(),
          body: composedReply(replyBody),
          attachments: replyAttachments.length ? replyAttachments : undefined,
          artifacts: replyArtifacts.length ? replyArtifacts : undefined,
        });
        await sendDraft(selectedAccountId, saved.id);
      } else {
        sendEmail({
          accountId: selectedAccountId,
          to: toArr,
          cc: ccArr.length ? ccArr : undefined,
          bcc: bccArr.length ? bccArr : undefined,
          subject: replySubject(),
          bodyText: composedReply(replyBody),
          replyToMessageId: isForward ? undefined : target.providerMessageId,
        });
      }
    } catch (e: any) {
      setSendErr(e?.message || "Failed to send");
      return;
    }
    // Show the reply in the conversation at once, then pull the real synced copy.
    const sent = email.threadId
      ? buildOptimisticSent({
          accountId: selectedAccountId,
          threadId: email.threadId,
          fromEmail: ownEmail || "",
          to: toArr,
          cc: ccArr,
          subject: replySubject(),
          bodyText: composedReply(replyBody),
          hasAttachments:
            replyAttachments.length > 0 || replyArtifacts.length > 0,
        })
      : undefined;
    resetReplySession();
    refreshThreadAfterSend(sent);
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
      replyToBody: replyBody,   // the typed new text
      quote: replyQuote,        // the collapsed trailing chain
      replyToMessageId:
        replyMode === "forward" ? undefined : replyTarget.providerMessageId,
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
            icon={ReplyAll}
            label="Reply All"
            onClick={() => startReply("reply-all")}
            active={replyMode === "reply-all"}
          />
          <TBtn
            icon={Reply}
            label="Reply"
            onClick={() => startReply("reply")}
            active={replyMode === "reply"}
          />
          <TBtn
            icon={Forward}
            label="Forward"
            onClick={() => startReply("forward")}
            active={replyMode === "forward"}
          />

          <TBtn
            icon={ListChecks}
            label="Add to Tasks"
            onClick={() => {
              if (email) captureEmailToTasks(email.id);
            }}
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
                    .filter((f) => isRealFolder(f.key) && f.key !== email?.folder)
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
                className="text-[11px] px-2.5 py-1"
              />
            ))}
          </div>
        )}

        {thread && thread.length > 1 ? (
          /* Conversation view — the whole thread, stacked */
          <ConversationView
            messages={thread}
            openedId={email.id}
            onReply={(m, mode) => startReply(mode, m)}
            onSent={refreshThreadAfterSend}
          />
        ) : isDraftEmail(email) ? (
          /* Standalone draft — editable composer. Pass the reply target so the
             Reply / Reply All toggle can appear when it's a reply to a message. */
          <DraftCard draft={email} replyTo={replyTarget} />
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
          {/* Card-level capture: turn this email (with its thread + who's on it)
              into a routed GTD task — always visible with the message. */}
          <button
            type="button"
            onClick={() => captureEmailToTasks(email.id)}
            title="Add to Tasks — the assistant reads the thread and files a routed task (follow-up / delegated / next action) with a due date if implied."
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors"
          >
            <ListChecks size={14} />
            <span className="hidden sm:inline">Add to Tasks</span>
          </button>
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

        {/* Attachments — same card UI the conversation view uses per message. */}
        {view.hasAttachments && (
          <AttachmentList
            attachments={view.attachments}
            className="mt-6 pt-4 border-t border-border"
          />
        )}
        </>
        )}

        {/* Reply / Forward composer */}
        {replyMode && (
          <div
            ref={composerRef}
            className="mt-8 border border-primary/30 rounded-lg overflow-hidden bg-secondary/30"
          >
            <div className="px-4 py-2 bg-secondary text-xs text-muted-foreground border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span>
                  Replying to{" "}
                  <span className="text-foreground">
                    {replyMode === "forward" ? "…" : replyTarget.from.name}
                  </span>
                </span>
                {/* Reply / Reply All mode toggle (hidden for forward) */}
                {replyMode !== "forward" && (
                  <div className="flex items-center bg-background rounded-md p-0.5 ml-2">
                    <button
                      onClick={() => switchReplyMode("reply-all")}
                      className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                        replyMode === "reply-all" ? "bg-primary text-primary-foreground" : "hover:text-foreground"
                      }`}
                      title="Reply to all"
                    >
                      <ReplyAll size={11} />
                    </button>
                    <button
                      onClick={() => switchReplyMode("reply")}
                      className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                        replyMode === "reply" ? "bg-primary text-primary-foreground" : "hover:text-foreground"
                      }`}
                      title="Reply to sender only"
                    >
                      <Reply size={11} />
                    </button>
                  </div>
                )}
              </div>
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
              {/* Reveal Cc/Bcc on a sender-only reply where they're hidden. */}
              {!showReplyCc && (
                <button
                  type="button"
                  onClick={() => setShowReplyCc(true)}
                  className="text-[10px] text-muted-foreground hover:text-foreground whitespace-nowrap px-1 flex-shrink-0"
                >
                  Cc/Bcc
                </button>
              )}
            </div>
            {showReplyCc && (
              <>
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
              </>
            )}
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
            {/* Signature as it will be appended on send (Outlook/Gmail style). */}
            {replyMode !== "forward" && (
              <SignaturePreview accountId={selectedAccountId} />
            )}
            {/* Quoted trailing email — collapsed, read-only (reattached on send) */}
            <ComposerQuote quote={replyQuote} />
            {/* AI draft/improve bar */}
            {aiOpen && (
              <AiAssistBar
                instruction={aiInstruction}
                onInstruction={setAiInstruction}
                busy={aiBusy}
                hasText={replyBody.trim().length > 0}
                onRun={runAiDraft}
                onClose={() => setAiOpen(false)}
              />
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
                <AiButton active={aiOpen} onClick={() => setAiOpen((v) => !v)} />
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

