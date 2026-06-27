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

function addr(a: PersonaAccount): string {
  return a.emailAddress || a.email_address || "";
}

export function buildEmailAssistantPersona(opts: {
  accounts?: PersonaAccount[];
  selectedAccountId?: string | null;
  openEmail?: PersonaOpenEmail | null;
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
