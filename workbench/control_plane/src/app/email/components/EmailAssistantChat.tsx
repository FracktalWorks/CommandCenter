"use client";

/**
 * EmailAssistantChat — the email app's AI chat rail.
 *
 * This is a THIN wrapper around the shared <AgentChat> (the same component the
 * main chat app uses), pinned to the `email-assistant` agent.  It does NOT
 * reimplement streaming, tool rendering, recovery, persistence, or compaction —
 * all of that comes from the shared chat infrastructure, so improvements to the
 * chat app automatically flow into the email app.
 *
 * The wrapper's only jobs are:
 *   1. Manage the email-assistant session list (via the shared @/lib/sessions
 *      store, scoped to agentName="email-assistant" — so these conversations are
 *      the SAME objects the chat app sees).
 *   2. Feed the agent the user's current email context (selected account + open
 *      email) so it can act on "this email" without the user repeating ids.
 *   3. Bridge the Assistant "Fix" flow (pendingChatPrompt → composer).
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSession } from "next-auth/react";
import { Sparkles, Plus, MessagesSquare, Trash2, X } from "lucide-react";
import AgentChat from "@/components/AgentChat";
import {
  getSessions, createSession, upsertSession, deleteSession,
  enrichSession, fetchAndMergeSessionsFromDb, type ChatSession,
} from "@/lib/sessions";
import { useActiveSessions } from "@/hooks/useActiveSessions";
import { useEmailStore } from "../lib/emailStore";

const AGENT = "email-assistant";

interface EmailAssistantChatProps {
  selectedAccountId?: string | null;
  selectedEmailId?: string | null;
}

export function EmailAssistantChat({
  selectedAccountId,
  selectedEmailId,
}: EmailAssistantChatProps) {
  const { data: nextAuthSession } = useSession();
  const userId: string = nextAuthSession?.user?.email ?? "dev@fracktal.in";

  const accounts = useEmailStore((s) => s.accounts);
  const emails = useEmailStore((s) => s.emails);
  const pendingChatPrompt = useEmailStore((s) => s.pendingChatPrompt);
  const setPendingChatPrompt = useEmailStore((s) => s.setPendingChatPrompt);

  const activeRunIds = useActiveSessions();

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [showSessions, setShowSessions] = useState(false);
  const [pendingInput, setPendingInput] = useState<string | undefined>();

  const emailSessions = useMemo(
    () => sessions.filter((s) => s.agentName === AGENT),
    [sessions],
  );

  // Restore the most recent email-assistant session (or start one) on mount.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const existing = getSessions().filter((s) => s.agentName === AGENT);
    if (existing.length > 0) {
      setSessions(getSessions());
      setActiveId(existing[0].id);
    } else {
      const s = createSession(AGENT);
      upsertSession(s);
      setSessions(getSessions());
      setActiveId(s.id);
    }
  }, []);

  // Merge email-assistant sessions that live only in Postgres (cache clear,
  // other device, or created from the main chat app).
  useEffect(() => {
    let cancelled = false;
    fetchAndMergeSessionsFromDb()
      .then((merged) => { if (!cancelled) setSessions(merged); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // The Assistant's "Fix" flow hands a correction prompt through the store —
  // drop it into the composer (the user reviews & sends it).
  useEffect(() => {
    if (pendingChatPrompt) {
      setPendingInput(pendingChatPrompt);
      setPendingChatPrompt(null);
    }
  }, [pendingChatPrompt, setPendingChatPrompt]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const newSession = useCallback(() => {
    const s = createSession(AGENT);
    upsertSession(s);
    setSessions(getSessions());
    setActiveId(s.id);
    setShowSessions(false);
  }, []);

  const switchSession = useCallback((id: string) => {
    setActiveId(id);
    setShowSessions(false);
  }, []);

  const removeSession = useCallback(
    (id: string) => {
      deleteSession(id);
      const remaining = getSessions().filter((s) => s.agentName === AGENT);
      setSessions(getSessions());
      if (id === activeId) {
        if (remaining.length > 0) {
          setActiveId(remaining[0].id);
        } else {
          const s = createSession(AGENT);
          upsertSession(s);
          setSessions(getSessions());
          setActiveId(s.id);
        }
      }
    },
    [activeId],
  );

  const handleActivity = useCallback(
    (info: { firstUserMessage?: string; lastPreview?: string; messageCount: number }) => {
      enrichSession(activeId, info);
      setSessions(getSessions());
    },
    [activeId],
  );

  // Compose the email context the agent operates with — the selected account
  // and the currently-open email, so "this email" / "reply" resolve correctly.
  const emailContextStr = useMemo(() => {
    const parts: string[] = [
      "You are the email assistant, embedded inside the user's email client UI.",
    ];
    const account = accounts.find((a) => a.id === selectedAccountId);
    if (account) {
      parts.push(
        `Active account: "${account.label || account.emailAddress}" ` +
        `(email_address: ${account.emailAddress}, account_id: ${account.id}). ` +
        "Use this account_id for tools unless the user names a different account.",
      );
    } else if (selectedAccountId) {
      parts.push(
        `Active account_id: ${selectedAccountId}. Use it for account-scoped tools ` +
        "unless the user names a different account.",
      );
    } else {
      parts.push(
        "No account is selected yet — call list_accounts and pick one before any " +
        "account-scoped action.",
      );
    }
    const email = emails.find((e) => e.id === selectedEmailId);
    if (email) {
      const from = email.from.name
        ? `${email.from.name} <${email.from.email}>`
        : email.from.email;
      parts.push(
        'The user currently has this email open. When they say "this email", ' +
        '"this thread", "reply", or "summarize this", they mean it:\n' +
        `  • email_id: ${email.id}\n` +
        `  • subject: ${email.subject || "(no subject)"}\n` +
        `  • from: ${from}\n` +
        `Call read_email(email_id="${email.id}") to read its full body before acting.`,
      );
    } else if (selectedEmailId) {
      parts.push(
        `The user has email_id ${selectedEmailId} open; call read_email to read ` +
        "it when relevant.",
      );
    }
    return parts.join("\n\n");
  }, [accounts, emails, selectedAccountId, selectedEmailId]);

  const activeSession = emailSessions.find((s) => s.id === activeId);

  return (
    <div className="flex flex-col h-full bg-sidebar text-sidebar-foreground overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-9 border-b border-sidebar-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center">
            <Sparkles size={11} />
          </div>
          <span className="text-xs font-semibold text-sidebar-foreground">
            AI Assistant
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowSessions((v) => !v)}
            title="Chat history"
            className={`p-1 rounded transition-colors ${
              showSessions
                ? "text-primary bg-primary/10"
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent"
            }`}
          >
            <MessagesSquare size={14} />
          </button>
          <button
            onClick={newSession}
            title="New chat"
            className="p-1 rounded text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      {/* Sessions list */}
      {showSessions && (
        <div className="border-b border-sidebar-border bg-secondary/30 max-h-56 overflow-y-auto scrollbar-hide flex-shrink-0">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Conversations
            </span>
            <button
              onClick={() => setShowSessions(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          </div>
          {emailSessions.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              No conversations yet.
            </div>
          ) : (
            emailSessions.map((s) => (
              <div
                key={s.id}
                className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                  s.id === activeId ? "bg-primary/10" : "hover:bg-secondary/60"
                }`}
                onClick={() => switchSession(s.id)}
              >
                {activeRunIds.has(s.id) ? (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"
                    title="Active — agent is working"
                  />
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-foreground truncate">
                    {s.title || "New conversation"}
                  </div>
                  {s.lastPreview && (
                    <div className="text-[10px] text-muted-foreground truncate">
                      {s.lastPreview}
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSession(s.id);
                  }}
                  title="Delete conversation"
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive flex-shrink-0"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Shared chat — the same AgentChat the main chat app renders */}
      <div className="flex-1 min-h-0">
        {activeSession && (
          <AgentChat
            key={activeSession.id}
            agentName={AGENT}
            sessionId={activeSession.id}
            compact
            persona={emailContextStr}
            emailContext={{ accountId: selectedAccountId, emailId: selectedEmailId }}
            memoryUserId={userId}
            expectedMessageCount={activeSession.messageCount}
            onActivity={handleActivity}
            pendingInput={pendingInput}
            onPendingInputConsumed={() => setPendingInput(undefined)}
          />
        )}
      </div>
    </div>
  );
}
