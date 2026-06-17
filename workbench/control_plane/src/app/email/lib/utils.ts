import { Email } from "./types";

/**
 * Format a date for email list display.
 * - < 24h ago: time only (e.g. "2:30 PM")
 * - < 48h ago: "Yesterday"
 * - older: short date (e.g. "Jun 15")
 */
export function timeLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const hours = diffMs / (1000 * 60 * 60);

  if (hours < 24) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (hours < 48) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Format full date for email detail view.
 * e.g. "Wednesday, June 17, 2026 at 2:30 PM"
 */
export function fullDateLabel(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString([], {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Get initials from a name for avatar display.
 * e.g. "Alex Morgan" → "AM", "Priya Sharma" → "PS"
 */
export function initials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Get the folder label for display.
 */
export function folderLabel(folder: string): string {
  const map: Record<string, string> = {
    inbox: "Inbox",
    starred: "Starred",
    sent: "Sent",
    drafts: "Drafts",
    archive: "Archive",
    spam: "Spam",
    trash: "Trash",
  };
  return map[folder] || folder;
}

/**
 * Truncate text with ellipsis.
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "…";
}

/**
 * Check if an email is unread.
 */
export function isUnread(email: Email): boolean {
  return !email.isRead;
}
