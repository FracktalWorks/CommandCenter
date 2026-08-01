/**
 * Shared persona builder for the email-assistant chat.
 *
 * Used by BOTH entry points so the agent gets the SAME context regardless of
 * where it runs:
 *   • the email app (EmailAssistantChat) — passes the connected accounts, the
 *     currently-selected account, and the open email;
 *   • the main chat app (chat/page.tsx) — passes the connected accounts only
 *     (there is no "open email" concept there).
 *
 * Keeping one builder means "run the email assistant in the chat app" feels the
 * same as "run it in the email app" — it's account-aware in both, and only the
 * open-email context (inherently email-app-only) differs.
 */

export interface PersonaAccount {
  id: string;
  label?: string | null;
  /** Email-store shape (camelCase). */
  emailAddress?: string | null;
  /** Gateway/API shape (snake_case). */
  email_address?: string | null;
}

export interface PersonaOpenEmail {
  id: string;
  subject?: string | null;
  from?: { name?: string | null; email?: string | null } | null;
}

/**
 * The ACTIVE account's own assistant configuration (email_assistant_settings).
 *
 * Every one of these is stored per account, and the drafting pipeline already
 * loads them by account_id — so a draft written for the work mailbox already
 * differs from one written for the personal mailbox. The CHAT assistant was the
 * one surface that didn't see them: it knew which account_id to pass to tools,
 * but nothing about how the user wants that mailbox handled, so it conversed
 * identically on every account. Carrying them here is what makes switching
 * accounts in the UI actually change the assistant's behaviour.
 */
export interface PersonaAccountSettings {
  /** Who the user is, in this mailbox's context. */
  about?: string | null;
  /** Standing rules the user always wants followed on this account. */
  personal_instructions?: string | null;
  /** How replies from this account should read. */
  writing_style?: string | null;
  /** Auto-derived from how the user edits drafts on this account. */
  learned_writing_style?: string | null;
}

function addr(a: PersonaAccount): string {
  return a.emailAddress || a.email_address || "";
}

export function buildEmailAssistantPersona(opts: {
  accounts?: PersonaAccount[];
  selectedAccountId?: string | null;
  openEmail?: PersonaOpenEmail | null;
  /** The ACTIVE account's assistant settings. Omit where they aren't loaded —
   *  the persona degrades to account-awareness without the standing orders. */
  settings?: PersonaAccountSettings | null;
}): string {
  const accounts = opts.accounts ?? [];
  const parts: string[] = [
    "You are the Email Assistant, embedded in the user's email client. You can " +
      "read, search, query, categorize, draft, send, automate (rules), and " +
      "manage the inbox entirely by chat using your tools.",
  ];

  if (accounts.length > 0) {
    parts.push(
      "Connected accounts:\n" +
        accounts
          .map((a) => `• ${a.label || addr(a) || a.id} (account_id: ${a.id})`)
          .join("\n"),
    );
  }

  const active = accounts.find((a) => a.id === opts.selectedAccountId);
  if (active) {
    parts.push(
      `Active account: "${active.label || addr(active)}" (account_id: ` +
        `${active.id}). Use this account_id for account-scoped tools unless the ` +
        "user names a different account.",
    );
  } else if (opts.selectedAccountId) {
    parts.push(
      `Active account_id: ${opts.selectedAccountId}. Use it for account-scoped ` +
        "tools unless the user names a different account.",
    );
  } else if (accounts.length === 1) {
    parts.push(
      `Use account_id ${accounts[0].id} for account-scoped tools unless the ` +
        "user names a different account.",
    );
  } else if (accounts.length > 1) {
    parts.push(
      "No specific account is selected — use the relevant account_id from the " +
        "list above (ask the user if it's ambiguous) before account-scoped " +
        "actions.",
    );
  } else {
    parts.push(
      "No accounts are loaded here — call list_accounts before any " +
        "account-scoped action.",
    );
  }

  // How the ACTIVE account wants to be handled. Scoped to that account, so
  // switching mailboxes in the UI switches the assistant's standing orders with
  // it. Trimmed and bounded — this rides in the system context on every turn.
  const cfg = opts.settings;
  if (cfg) {
    const clip = (s: string, n: number) =>
      s.length > n ? `${s.slice(0, n)}…` : s;
    const block = (label: string, v?: string | null, n = 1200) => {
      const t = (v || "").trim();
      return t ? `${label}\n${clip(t, n)}` : "";
    };
    const cfgParts = [
      block("### About the user (this account)", cfg.about),
      // Standing instructions outrank the assistant's defaults — say so, or the
      // model treats them as background colour.
      block(
        "### Standing instructions for this account (follow these)",
        cfg.personal_instructions,
      ),
      block("### How the user writes from this account", cfg.writing_style),
      // Advisory: derived from edits, not stated by the user, so an explicit
      // writing_style must win where the two disagree.
      block(
        "### Observed writing style (auto-derived, advisory)",
        cfg.learned_writing_style,
        600,
      ),
    ].filter(Boolean);
    if (cfgParts.length) {
      parts.push(
        "## This account's assistant configuration\n" +
          "These are configured for the ACTIVE account only — if the user " +
          "switches accounts, they no longer apply.\n\n" +
          cfgParts.join("\n\n"),
      );
    }
  }

  const email = opts.openEmail;
  if (email) {
    const from = email.from?.name
      ? `${email.from.name} <${email.from.email}>`
      : email.from?.email || "";
    parts.push(
      'The user currently has this email open. When they say "this email", ' +
        '"this thread", "reply", or "summarize this", they mean it:\n' +
        `  • email_id: ${email.id}\n` +
        `  • subject: ${email.subject || "(no subject)"}\n` +
        `  • from: ${from}\n` +
        `Call read_email(email_id="${email.id}") to read its full body before ` +
        "acting.",
    );
  }

  return parts.join("\n\n");
}
