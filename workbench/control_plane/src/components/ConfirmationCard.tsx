"use client";

/**
 * ConfirmationCard — Human-in-the-Loop confirmation prompt.
 *
 * When the agent needs user approval before taking an action, it emits a
 * "confirmation_requested" custom event. This card renders inline in the
 * chat thread with Approve / Reject buttons.
 *
 * Usage:
 *   <ConfirmationCard
 *     title="Confirm email send"
 *     detail="Send weekly sales report to team@fracktal.in?"
 *     onApprove={() => sendMessage("APPROVE: send_email")}
 *     onReject={() => sendMessage("REJECT: send_email")}
 *   />
 */

interface ConfirmationCardProps {
  title: string;
  detail?: string;
  /** Additional context to show (e.g. what will happen). */
  context?: string;
  onApprove: () => void;
  onReject: () => void;
  /** Disable buttons after a choice is made. */
  disabled?: boolean;
}

export default function ConfirmationCard({
  title,
  detail,
  context,
  onApprove,
  onReject,
  disabled = false,
}: ConfirmationCardProps) {
  return (
    <div className="my-3 rounded-xl border border-amber-700/40 bg-amber-950/20 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-800/30 bg-amber-900/20">
        <span className="text-base">⚠️</span>
        <span className="text-[12px] sm:text-[13px] font-medium text-amber-300">
          {title}
        </span>
      </div>

      {/* Body */}
      {(detail || context) && (
        <div className="px-4 py-3 space-y-2">
          {detail && (
            <p className="text-[12px] sm:text-[13px] text-foreground leading-relaxed">
              {detail}
            </p>
          )}
          {context && (
            <pre className="text-[11px] text-muted-foreground bg-card/60 rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
              {context}
            </pre>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-amber-800/30 bg-amber-900/10">
        <button
          onClick={onApprove}
          disabled={disabled}
          className="text-[12px] px-4 py-1.5 rounded-lg bg-success text-success-foreground font-medium hover:bg-emerald-500 disabled:opacity-40 transition-colors"
        >
          ✓ Approve
        </button>
        <button
          onClick={onReject}
          disabled={disabled}
          className="text-[12px] px-4 py-1.5 rounded-lg bg-secondary text-foreground hover:bg-secondary disabled:opacity-40 transition-colors"
        >
          ✕ Reject
        </button>
        <span className="text-[10px] text-muted-foreground ml-auto">
          Agent is waiting for your decision
        </span>
      </div>
    </div>
  );
}
