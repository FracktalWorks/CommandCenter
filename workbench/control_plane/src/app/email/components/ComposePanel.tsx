"use client";

import { useState, useEffect, useRef } from "react";
import { X, Loader2, Paperclip } from "lucide-react";
import { useEmailStore } from "../lib/emailStore";
import {
  fileToSendAttachment, composeAssist,
  type SendAttachment, type ArtifactAttachmentRef,
} from "../lib/api";
import { splitQuotedText } from "../lib/quoting";
import { ArtifactAttachPicker } from "./ArtifactAttachPicker";
import { ComposerQuote, AiButton, AiAssistBar } from "./ComposerAI";

interface ComposePanelProps {
  open: boolean;
  onClose: () => void;
  accountId: string;
  onSend: (params: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    bodyText: string;
    replyToMessageId?: string;
    attachments?: SendAttachment[];
    artifacts?: ArtifactAttachmentRef[];
  }) => Promise<void>;
  defaultTo?: string;
  defaultSubject?: string;
  /** Seeds the editable body (e.g. text carried over from a popped-out reply). */
  replyToBody?: string;
  /** The quoted trailing chain — shown collapsed below the box, reattached on
   *  send, and kept OUT of the editable body so AI/edits never touch it. */
  quote?: string;
  replyToMessageId?: string;
}

export function ComposePanel({
  open,
  onClose,
  accountId,
  onSend,
  defaultTo = "",
  defaultSubject = "",
  replyToBody,
  quote,
  replyToMessageId,
}: ComposePanelProps) {
  const [to, setTo] = useState(defaultTo);
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(replyToBody || "");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // AI draft/improve bar (sparkles button in the footer).
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const { saveDraft, sendDraft, deleteEmail } = useEmailStore();
  // Gmail-style auto-save: the composed message persists as a Drafts row as you
  // type (draftIdRef holds the local id so repeated saves update it in place).
  const draftIdRef = useRef<string | null>(null);
  const dirty = useRef(false);
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved">("idle");
  // Uploaded files (base64) + picked AI artifacts (resolved server-side).
  const [attachments, setAttachments] = useState<SendAttachment[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactAttachmentRef[]>([]);

  // A fresh compose session each time the window opens: re-sync fields from the
  // (possibly new) props and forget any prior draft so we don't update it.
  useEffect(() => {
    if (!open) return;
    setTo(defaultTo);
    setCc("");
    setSubject(defaultSubject);
    setBody(replyToBody || "");
    draftIdRef.current = null;
    dirty.current = false;
    setDraftStatus("idle");
    setAttachments([]);
    setArtifacts([]);
    setAiOpen(false);
    setAiInstruction("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** The full outgoing body: the editable text plus the quoted trailing chain. */
  const combinedBody = () =>
    quote ? `${body.replace(/\s+$/, "")}\n\n${quote}` : body;

  /** Draft or improve with AI. Operates only on the NEW text — any inline quote
   *  in the body is split off (and the separate `quote` prop is never sent) so
   *  the AI never rewrites the trailing email. */
  const runAi = async () => {
    if (!accountId || aiBusy) return;
    setSendError(null);
    setAiBusy(true);
    try {
      const { main, quoted } = splitQuotedText(body);
      const toArr = to.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await composeAssist({
        accountId,
        body: main,
        instruction: aiInstruction.trim(),
        mode: replyToMessageId ? "reply" : "new",
        to: toArr,
        subject,
      });
      if (res.draft) {
        dirty.current = true;
        // Reattach any inline quote that lived in the body so we don't drop it.
        setBody(quoted ? `${res.draft.replace(/\s+$/, "")}\n\n${quoted}` : res.draft);
        setAiOpen(false);
        setAiInstruction("");
      } else {
        setSendError("AI couldn't draft this — try adding a quick instruction.");
      }
    } catch (err: any) {
      setSendError(err?.message || "AI draft failed");
    } finally {
      setAiBusy(false);
    }
  };

  /** Read picked files into base64 and append them to the attachments. */
  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    try {
      const added = await Promise.all(Array.from(files).map(fileToSendAttachment));
      setAttachments((prev) => [...prev, ...added]);
    } catch {
      setSendError("Couldn't read one of the attachments");
    }
  };

  // Debounced auto-save once the user edits the draft.
  useEffect(() => {
    if (!open || !accountId || !dirty.current) return;
    const toArr = to.split(",").map((s) => s.trim()).filter(Boolean);
    if (!body.trim() && toArr.length === 0 && !subject.trim()) return;
    const handle = setTimeout(async () => {
      try {
        setDraftStatus("saving");
        const saved = await saveDraft({
          accountId,
          draftId: draftIdRef.current ?? undefined,
          replyToMessageId: draftIdRef.current ? undefined : (replyToMessageId || undefined),
          to: toArr,
          subject,
          body: combinedBody(),
        });
        draftIdRef.current = saved.id;
        setDraftStatus("saved");
      } catch {
        setDraftStatus("idle");
      }
    }, 1200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, subject, body, open, accountId]);

  if (!open) return null;

  const handleSend = async () => {
    if (!to.trim() || sending) return;
    setSending(true);
    setSendError(null);
    const toArr = to.split(",").map((s) => s.trim()).filter(Boolean);
    const ccArr = cc ? cc.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const hasAttachments = attachments.length > 0 || artifacts.length > 0;
    try {
      // Native draft-send when auto-save produced a draft and there's no Cc and
      // no attachments (the draft write-path carries neither); otherwise send fresh.
      if (draftIdRef.current && ccArr.length === 0 && !hasAttachments) {
        const saved = await saveDraft({
          accountId,
          draftId: draftIdRef.current,
          to: toArr,
          subject,
          body: combinedBody(),
        });
        await sendDraft(accountId, saved.id);
        onClose();
      } else {
        await onSend({
          to: toArr,
          cc: ccArr.length ? ccArr : undefined,
          subject,
          bodyText: combinedBody(),
          replyToMessageId: replyToMessageId,
          attachments: attachments.length ? attachments : undefined,
          artifacts: artifacts.length ? artifacts : undefined,
        });
        if (draftIdRef.current) void deleteEmail(draftIdRef.current);
        // onClose is called by the store after successful send
      }
    } catch (err: any) {
      setSendError(err.message || "Failed to send");
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-12 sm:pt-20 px-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Compose window */}
      <div className="relative w-full max-w-2xl bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/50">
          <span className="text-sm font-medium text-foreground">New Message</span>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Fields */}
        <div className="px-4 py-3 space-y-3">
          {/* To */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-8 flex-shrink-0">To:</span>
            <input
              type="text"
              value={to}
              onChange={(e) => { dirty.current = true; setTo(e.target.value); }}
              placeholder="Email address..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>

          {/* Cc */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-8 flex-shrink-0">Cc:</span>
            <input
              type="text"
              value={cc}
              onChange={(e) => { dirty.current = true; setCc(e.target.value); }}
              placeholder="Cc..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>

          {/* Subject */}
          <div className="flex items-center gap-2 border-t border-border pt-3">
            <span className="text-xs text-muted-foreground w-8 flex-shrink-0">Subj:</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => { dirty.current = true; setSubject(e.target.value); }}
              placeholder="Subject..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>

          {/* Body */}
          <div className="border-t border-border pt-3">
            <textarea
              value={body}
              onChange={(e) => { dirty.current = true; setBody(e.target.value); }}
              placeholder="Write your message..."
              rows={12}
              autoFocus
              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none resize-none leading-relaxed"
            />
          </div>

          {/* Quoted trailing email — collapsed, read-only (reattached on send) */}
          <ComposerQuote quote={quote || ""} className="pb-1" />

          {/* Attachment chips */}
          {(attachments.length > 0 || artifacts.length > 0) && (
            <div className="border-t border-border pt-2 flex flex-wrap gap-1.5">
              {attachments.map((a, i) => (
                <span
                  key={`f-${i}`}
                  className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border border-border bg-secondary text-muted-foreground"
                >
                  <Paperclip size={10} />
                  <span className="truncate max-w-[160px]" title={a.filename}>{a.filename}</span>
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="hover:text-foreground"
                    title="Remove attachment"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              {artifacts.map((a, i) => (
                <span
                  key={`a-${i}`}
                  className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border border-primary/40 bg-primary/5 text-primary"
                  title={a.path}
                >
                  <Paperclip size={10} />
                  <span className="truncate max-w-[160px]">{a.name || a.path}</span>
                  <button
                    onClick={() => setArtifacts((prev) => prev.filter((_, j) => j !== i))}
                    className="hover:text-foreground"
                    title="Remove attachment"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* AI draft/improve bar */}
        {aiOpen && (
          <AiAssistBar
            instruction={aiInstruction}
            onInstruction={setAiInstruction}
            busy={aiBusy}
            hasText={body.trim().length > 0}
            onRun={runAi}
            onClose={() => setAiOpen(false)}
          />
        )}

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between">
          <div className="flex-1">
            {sendError ? (
              <span className="text-[10px] text-red-500">{sendError}</span>
            ) : draftStatus === "saving" ? (
              <span className="text-[10px] text-muted-foreground">Saving draft…</span>
            ) : draftStatus === "saved" ? (
              <span className="text-[10px] text-muted-foreground">Draft saved to Drafts</span>
            ) : (
              <span className="text-[10px] text-muted-foreground">
                Sent from your connected email account
              </span>
            )}
          </div>
          <div className="flex gap-2 items-center">
            <AiButton active={aiOpen} onClick={() => setAiOpen((v) => !v)} />
            <label
              className="px-2 py-1.5 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
              title="Attach files"
            >
              <Paperclip size={14} />
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }}
              />
            </label>
            <ArtifactAttachPicker
              exclude={artifacts.map((a) => a.path)}
              onPick={(ref) => setArtifacts((prev) =>
                prev.some((a) => a.path === ref.path) ? prev : [...prev, ref])}
            />
            <button
              onClick={() => {
                // Discard removes the auto-saved draft (closing via X keeps it).
                if (draftIdRef.current) void deleteEmail(draftIdRef.current);
                onClose();
              }}
              disabled={sending}
              className="px-3 py-1.5 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
            >
              Discard
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !to.trim()}
              className="px-4 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {sending && <Loader2 size={12} className="animate-spin" />}
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
