"use client";

import { useState } from "react";
import { AlertTriangle, RefreshCw, Settings2, RotateCw, Eraser, Loader2 } from "lucide-react";
import { Email } from "../lib/types";
import { useEmailStore } from "../lib/emailStore";
import { resyncAccount } from "../lib/api";

/**
 * MailboxActions — the sync / mark-as-spam / mailbox-settings cluster.
 *
 * Lives in the email page's desktop top bar (next to the command palette and AI
 * panel toggle). Reads everything it needs from the email store; the caller only
 * has to pass the currently-selected email (for the "mark as spam" action).
 */
export function MailboxActions({ selectedEmail }: { selectedEmail: Email | null }) {
  const { updateEmail, triggerSync, selectedAccountId, syncStatus } = useEmailStore();
  const status = selectedAccountId ? syncStatus[selectedAccountId] : undefined;
  // "processing" = new mail is in and the server is still applying rules/labels
  // and auto-archiving in the background (H1); keep the button busy, but change
  // the hint so the user knows labels are still landing.
  const processing = status === "processing";
  const syncing = status === "syncing" || processing;

  // ── Mailbox settings menu (gear) ──
  const [showSettings, setShowSettings] = useState(false);
  const [resyncing, setResyncing] = useState<"full" | "purge" | null>(null);
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);
  const doResync = async (purge: boolean) => {
    if (!selectedAccountId || resyncing) return;
    if (purge && !confirm(
      "Hard resync deletes this mailbox's locally-stored emails, then re-fetches " +
      "them fresh from the server. Use this only if local data looks wrong. Continue?"
    )) return;
    setResyncing(purge ? "purge" : "full");
    setResyncMsg(null);
    try {
      const r = await resyncAccount(selectedAccountId, purge);
      setResyncMsg(
        `Resynced — ${r.messages_synced ?? 0} message(s) re-fetched.`
      );
    } catch (e) {
      setResyncMsg((e as Error).message || "Resync failed.");
    } finally {
      setResyncing(null);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => selectedAccountId && triggerSync(selectedAccountId)}
        disabled={!selectedAccountId || syncing}
        className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40"
        title={
          processing
            ? "Processing new mail — applying rules, labels & auto-archive…"
            : "Refresh — sync new mail, drafts & changes from the server"
        }
      >
        <RefreshCw size={15} className={syncing ? "animate-spin" : ""} />
      </button>

      <button
        onClick={() =>
          selectedEmail && updateEmail(selectedEmail.id, { folder: "junk" })
        }
        disabled={!selectedEmail}
        className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40"
        title="Mark as spam"
      >
        <AlertTriangle size={15} />
      </button>

      {/* Mailbox settings (gear) */}
      <div className="relative">
        <button
          onClick={() => setShowSettings((v) => !v)}
          className={`p-1.5 rounded transition-colors ${
            showSettings
              ? "text-primary bg-primary/10"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary"
          }`}
          title="Mailbox settings"
        >
          <Settings2 size={15} />
        </button>
        {showSettings && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setShowSettings(false)}
            />
            <div className="absolute right-0 top-full mt-1 z-20 w-64 bg-popover border border-border rounded-lg shadow-xl py-1">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Mailbox
              </div>
              <button
                onClick={() => doResync(false)}
                disabled={!selectedAccountId || !!resyncing}
                className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-secondary transition-colors disabled:opacity-50"
              >
                {resyncing === "full" ? (
                  <Loader2 size={13} className="animate-spin mt-0.5 flex-shrink-0" />
                ) : (
                  <RotateCw size={13} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
                )}
                <span>
                  <span className="block text-xs text-foreground">Resync mailbox</span>
                  <span className="block text-[10px] text-muted-foreground">
                    Re-fetch everything from the server (fixes stale data)
                  </span>
                </span>
              </button>
              <button
                onClick={() => doResync(true)}
                disabled={!selectedAccountId || !!resyncing}
                className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-secondary transition-colors disabled:opacity-50"
              >
                {resyncing === "purge" ? (
                  <Loader2 size={13} className="animate-spin mt-0.5 flex-shrink-0" />
                ) : (
                  <Eraser size={13} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
                )}
                <span>
                  <span className="block text-xs text-foreground">Hard resync</span>
                  <span className="block text-[10px] text-muted-foreground">
                    Clear local copy & re-fetch (for corrupt data)
                  </span>
                </span>
              </button>
              <button
                onClick={() => {
                  if (selectedAccountId) triggerSync(selectedAccountId);
                  setShowSettings(false);
                }}
                disabled={!selectedAccountId || syncing}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary transition-colors disabled:opacity-50"
              >
                <RefreshCw size={13} className={`flex-shrink-0 text-muted-foreground ${syncing ? "animate-spin" : ""}`} />
                <span className="text-xs text-foreground">Sync new mail now</span>
              </button>
              {resyncMsg && (
                <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border">
                  {resyncMsg}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
