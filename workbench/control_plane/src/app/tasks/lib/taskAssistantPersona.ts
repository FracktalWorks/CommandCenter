/**
 * Persona builder for the task-manager assistant (mirror of
 * emailAssistantPersona.ts — one builder so the agent gets the same context
 * wherever it runs).
 *
 * Feeds the agent the user's live GTD state: connected workspaces, where the
 * user currently is in the app (view / open item), and the inbox pressure —
 * so "process my inbox" or "clarify this" work without the user repeating
 * ids the UI already knows.
 */

import type { GtdItem } from "./types";
import type { TaskAccount } from "./api";

export function buildTaskAssistantPersona(opts: {
  accounts?: TaskAccount[];
  items?: GtdItem[];
  selectedView?: string;
  openItem?: GtdItem | null;
}): string {
  const accounts = opts.accounts ?? [];
  const items = opts.items ?? [];
  const parts: string[] = [
    "You are the Task Manager assistant, embedded in the user's GTD app. " +
      "You capture thoughts, clarify the inbox (AI proposes, the human " +
      "decides), organize items to Local or a connected PM workspace, run " +
      "reviews, and track delegated work — entirely by chat using your " +
      "gtd_* tools.",
  ];

  if (accounts.length > 0) {
    parts.push(
      "Connected PM workspaces:\n" +
        accounts
          .map(
            (a) =>
              `• ${a.label || a.provider} (${a.provider}, account_id: ${a.id})`,
          )
          .join("\n"),
    );
  } else {
    parts.push(
      "No PM workspaces are connected — everything is LOCAL. The user can " +
        "connect ClickUp from Tasks → Connect workspace.",
    );
  }

  const inbox = items.filter((i) => i.disposition === "INBOX");
  const next = items.filter((i) => i.disposition === "NEXT");
  const waiting = items.filter((i) => i.disposition === "WAITING");
  parts.push(
    `Current state: ${inbox.length} in the inbox, ${next.length} next ` +
      `actions, ${waiting.length} waiting-for. Use gtd_list / ` +
      "gtd_inbox_insights for details instead of asking the user.",
  );

  if (opts.selectedView) {
    parts.push(`The user is looking at the "${opts.selectedView}" view.`);
  }
  if (opts.openItem) {
    parts.push(
      `The user has this item open: "${opts.openItem.title}" ` +
        `(item_id: ${opts.openItem.id}, disposition: ` +
        `${opts.openItem.disposition}). When they say "this task", they ` +
        "mean this item — use gtd_clarify / gtd_organize / gtd_update on " +
        "it directly.",
    );
  }

  parts.push(
    "GTD posture: AI proposes, the human decides. Never push a task to a " +
      "provider without the user's explicit go-ahead (staged items need " +
      "their push action). Prefer clarifying ONE item at a time; keep " +
      "momentum, avoid overwhelming the user.",
  );

  return parts.join("\n\n");
}
