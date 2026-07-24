"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import React from "react";
import type { ChatMessage } from "@/hooks/useAgentChat";
import type { FileEntry } from "@/components/ArtifactSidebar";
import type { ParsedAgentError } from "@/lib/parseAgentError";
import MarkdownMessage from "@/components/MarkdownMessage";
import MessageActionBar from "@/components/MessageActionBar";
import GenerativeUIPanel from "@/components/GenerativeUIPanel";
import ArtifactCard, { type ArtifactMeta } from "@/components/ArtifactCard";
import EmailToolCards from "@/components/email/EmailToolCards";
import TaskToolCards from "@/components/tasks/TaskToolCards";
import GenerativeUINode from "@/components/GenerativeUINode";
import ErrorCard from "@/components/ChatErrorCard";
import { DismissableCard } from "@/components/ToolCardShell";
import { useDismissedToolCards, dismissToolCard } from "@/lib/dismissedTools";
import { openDoc, openGenUI } from "@/lib/sidePanelStore";
import { AppWindow } from "lucide-react";

function MessageBubble({
  message,
  sessionId,
  onChoice,
  onHitlRespond,
  onFileOpen,
  onResend,
  onRetryMessage,
  emailContext,
}: {
  message: ChatMessage;
  sessionId: string;
  onChoice?: (choice: string) => void;
  /** Resolve a BLOCKING generative-UI interaction (spec carried a request_id):
   *  answers resume the parked run via /agent/respond-input instead of being
   *  sent as a new chat message. Falls back to onChoice when absent. */
  onHitlRespond?: (requestId: string, answer: string) => void;
  onFileOpen?: (entry: FileEntry) => void;
  onResend?: (content: string) => void;
  onRetryMessage?: (m: ChatMessage) => void;
  emailContext?: { accountId?: string | null; emailId?: string | null };
}) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const editRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the edit textarea + focus when entering edit mode
  useEffect(() => {
    if (editing && editRef.current) {
      const t = editRef.current;
      t.focus();
      t.style.height = "auto";
      t.style.height = `${Math.max(t.scrollHeight, 60)}px`;
    }
  }, [editing]);

  // Dedup tool events by id before rendering.  A streamed tool call can arrive
  // more than once (MAF surfaces a function_call across several updates as its
  // args fill in), and React throws (#185 / duplicate-key) when sibling
  // elements share a key.  Both the thinking timeline AND the email cards key
  // by tool id, so dedup once here and feed both the same clean list.
  const dedupedToolEvents = useMemo(() => {
    const seen = new Set<string>();
    return (message.toolEvents ?? []).filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }, [message.toolEvents]);

  // Dismissed tool/artifact cards (persisted) — filter them out of every card
  // surface so closing a card sticks across reloads.
  const dismissed = useDismissedToolCards();

  // ── Extract artifact events from custom events ──────────────────────────
  // Dedup by path (last write wins) so an artifact_created followed by an
  // artifact_updated for the SAME file renders as one card, not two.
  const artifactEvents: ArtifactMeta[] = (() => {
    const byPath = new Map<string, ArtifactMeta>();
    for (const e of message.customEvents ?? []) {
      if (
        (e.name === "artifact_created" || e.name === "artifact_updated") &&
        e.value &&
        typeof e.value === "object"
      ) {
        const v = e.value as Record<string, unknown>;
        const path = String(v.path ?? "");
        byPath.set(path, {
          path,
          name: path.split("/").pop() ?? path,
          size: typeof v.size === "number" ? v.size : undefined,
          mimeType: typeof v.mime_type === "string" ? v.mime_type : undefined,
          sha256: typeof v.sha256 === "string" ? v.sha256 : undefined,
        } satisfies ArtifactMeta);
      }
    }
    return [...byPath.values()];
  })();

  // ── Generative-UI events → inline declarative component trees ───────────
  // Agents push `generative_ui` CUSTOM events carrying a safe component tree
  // (data, not code — GenerativeUINode whitelists the node types). Rendered
  // inline as a first-class element (not buried in the "Interactive view"
  // fold) so on-the-fly UI is prominent. Button actions route through onChoice
  // — the same follow-up contract as the ```choices``` MCQ block.
  const genUiEvents = (message.customEvents ?? [])
    .filter((e) => e.name === "generative_ui" && e.value != null)
    .map((e) => e.value);

  if (isSystem) {
    const content = message.content;
    if (content.startsWith("__ERROR__")) {
      try {
        const parsed: ParsedAgentError = JSON.parse(content.slice(9));
        return <ErrorCard parsed={parsed} />;
      } catch {
        // fall through
      }
    }
    // Context-compaction summary pill — styled distinctly so users know
    // the conversation was compressed.
    if (content.startsWith("[CONTEXT SUMMARY")) {
      const lines = content.split("\n");
      const header = lines[0];
      const body = lines.slice(2).join("\n").trim();
      return (
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-primary/80">
          <div className="flex items-center gap-1.5 font-medium mb-1">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 8h10M8 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {header}
          </div>
          {body && (
            <pre className="whitespace-pre-wrap text-[10px] text-primary/60 leading-relaxed">{body}</pre>
          )}
        </div>
      );
    }
    return (
      <div className="text-center text-xs text-muted-foreground italic py-1">
        {content}
      </div>
    );
  }

  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const handleEditSubmit = () => {
    const trimmed = editText.trim();
    if (trimmed && onResend) {
      onResend(trimmed);
    }
    setEditing(false);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleEditSubmit();
    } else if (e.key === "Escape") {
      setEditing(false);
      setEditText(message.content);
    }
  };

  const handleEditInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditText(e.target.value);
    const t = e.currentTarget;
    t.style.height = "auto";
    t.style.height = `${Math.min(Math.max(t.scrollHeight, 60), 300)}px`;
  };

  if (isUser) {
    return (
      <div className="flex justify-end group">
        {editing ? (
          /* ═══ Edit mode ═══ */
          <div className="w-full max-w-full sm:max-w-[85%]">
            <div className="rounded-2xl rounded-tr-sm border-2 border-amber-500/50 bg-secondary shadow-lg shadow-amber-500/5 overflow-hidden">
              {/* Edit header */}
              <div className="flex items-center justify-between px-4 py-2 border-b border-border/60 bg-secondary/80">
                <span className="text-[11px] text-amber-400/80 font-medium">
                  ✏️ Editing message
                </span>
                <span className="text-[10px] text-muted-foreground hidden sm:block">
                  Enter to send · Esc to cancel · Shift+Enter for new line
                </span>
              </div>

              {/* Textarea */}
              <div className="px-3 py-3">
                <textarea
                  ref={editRef}
                  value={editText}
                  onChange={handleEditInput}
                  onKeyDown={handleEditKeyDown}
                  rows={3}
                  className="w-full resize-none rounded-xl bg-card border border-border px-4 py-3 text-[16px] sm:text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-amber-500/60 transition-colors"
                  style={{ minHeight: "60px", maxHeight: "300px" }}
                />
              </div>

              {/* Action buttons */}
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/60 bg-secondary/60">
                <button
                  onClick={() => { setEditing(false); setEditText(message.content); }}
                  className="text-[12px] px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                >
                  Cancel
                </button>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">{editText.length} chars</span>
                  <button
                    onClick={handleEditSubmit}
                    disabled={!editText.trim()}
                    className="text-[12px] px-4 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold disabled:opacity-30 hover:opacity-90 tech-transition flex items-center gap-1.5"
                  >
                    <span>↑</span> Send
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ═══ Normal user bubble — compact, right-aligned, no avatar ═══ */
          <div className="max-w-[88%] sm:max-w-[78%]">
            <div
              onDoubleClick={() => { setEditText(message.content); setEditing(true); }}
              className="px-4 py-2.5 text-[13px] sm:text-sm leading-relaxed bg-primary/15 text-foreground rounded-2xl rounded-tr-md cursor-pointer select-none hover:bg-primary/20 tech-transition"
              title="Double-click to edit"
            >
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            </div>
            <div className="flex items-center justify-end gap-2 mt-1 pr-0.5 opacity-100 transition-opacity">
              {message.content.trim() && (
                <MessageActionBar
                  content={message.content}
                  messageId={message.id}
                  role="user"
                  onEdit={() => { setEditText(message.content); setEditing(true); }}
                />
              )}
              <div className="text-[10px] text-muted-foreground">{timestamp}</div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ═══ Assistant message — no bubble, renders directly ═══
  return (
    <div className="group">
      {/* Content renders directly in the chat window — no wrapper bubble.
          ThinkingContainer, code blocks, and artifact cards have their own
          visual containers. Only the timestamp and action bar are added. */}
      <MarkdownMessage
        content={message.content}
        streaming={message.streaming}
        toolEvents={dedupedToolEvents}
        progressLines={message.progressLines}
        isThinkingActive={message.isThinkingActive}
        reasoningBlocks={message.reasoningBlocks}
        segments={message.segments}
        onChoice={onChoice}
        sessionId={sessionId}
      />
      {/* Inline artifact cards — dismissable (persisted), keyed by sha/path. */}
      {(() => {
        const visible = artifactEvents.filter(
          (a) => !dismissed.has(a.sha256 ?? a.path),
        );
        if (visible.length === 0) return null;
        return (
          <div className="mt-3 space-y-2">
            {visible.map((a) => {
              const id = a.sha256 ?? a.path;
              return (
                <DismissableCard key={id} onDismiss={() => dismissToolCard(id)}>
                  <ArtifactCard
                    artifact={a}
                    sessionId={sessionId}
                    onOpen={onFileOpen}
                    onOpenInSidePanel={(entry) =>
                      openDoc({ path: entry.path, name: entry.name, sessionId })
                    }
                  />
                </DismissableCard>
              );
            })}
          </div>
        );
      })()}
      {/* Inline generative-UI trees — agent-pushed declarative components.
          surface:"panel" specs render as a compact open-chip (the immersive
          view lives in the side panel); specs carrying a request_id route
          interactions through the blocking HITL resume path. */}
      {genUiEvents.length > 0 && (
        <div className="mt-3 space-y-2">
          {genUiEvents.map((spec, i) => {
            const rec = (spec && typeof spec === "object"
              ? spec : {}) as Record<string, unknown>;
            const requestId =
              typeof rec.request_id === "string" ? rec.request_id : null;
            const act = (msg: string) => {
              if (requestId && onHitlRespond) onHitlRespond(requestId, msg);
              else onChoice?.(msg);
            };
            if (rec.surface === "panel") {
              const title = typeof rec.title === "string" && rec.title
                ? rec.title : "Interactive view";
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => openGenUI({
                    id: `${message.id}:${i}`,
                    title,
                    sessionId,
                    spec,
                  })}
                  className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/50 px-3 py-2 text-xs text-foreground hover:bg-secondary/60 transition-colors"
                >
                  <AppWindow size={13} className="text-primary" />
                  <span className="font-medium">{title}</span>
                  <span className="text-muted-foreground">
                    — open in side panel
                  </span>
                </button>
              );
            }
            return <GenerativeUINode key={i} spec={spec} onAction={act} />;
          })}
        </div>
      )}
      {/* Inline email-assistant cards (editable draft, rule disable/delete).
          Inert unless the message contains email-assistant tool calls, so this
          renders in both the chat app and the email app. */}
      <EmailToolCards
        toolEvents={dedupedToolEvents}
        accountId={emailContext?.accountId}
        emailId={emailContext?.emailId}
      />
      {/* Inline task-manager cards (clickable task lists, plan Apply, action
          confirmations). Inert unless the message contains gtd_* tool calls,
          so this renders in both the chat app and the Tasks assistant rail. */}
      <TaskToolCards toolEvents={dedupedToolEvents} />
      <GenerativeUIPanel
        agentState={message.agentState}
        customEvents={message.customEvents}
      />
      {!message.streaming && (
        <div className="flex items-center gap-2 mt-1.5 opacity-100 transition-opacity">
          {message.content.trim() && (
            <MessageActionBar
              content={message.content}
              messageId={message.id}
              role="assistant"
              sessionId={sessionId}
              onRetry={onRetryMessage ? () => onRetryMessage(message) : undefined}
            />
          )}
          <div className="text-[10px] text-muted-foreground">{timestamp}</div>
        </div>
      )}
    </div>
  );
}

// Memoised: the message store updates immutably (every change yields a NEW
// message object), so a reference check on `message` re-renders exactly the
// messages that changed and skips the rest — without this, every streamed token
// re-ran ReactMarkdown for every message in the thread. Callbacks are stable
// (the parent useCallback's them), so comparing their identity is safe.
export default React.memo(MessageBubble, (a, b) =>
  a.message === b.message &&
  a.sessionId === b.sessionId &&
  a.onChoice === b.onChoice &&
  a.onResend === b.onResend &&
  a.onRetryMessage === b.onRetryMessage &&
  a.onFileOpen === b.onFileOpen &&
  a.emailContext?.accountId === b.emailContext?.accountId &&
  a.emailContext?.emailId === b.emailContext?.emailId,
);
