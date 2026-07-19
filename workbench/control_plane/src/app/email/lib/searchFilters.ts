/**
 * Search filter pills — the model behind the search bar's closable chips.
 *
 * A search is a text query PLUS a set of pills. Pills come from two places and
 * are the same thing either way:
 *   • typed  — "from:alice", "tag:Newsletter", "is:unread" are lifted out of the
 *              input on Enter and become chips (Gmail/Outlook grammar)
 *   • picked — chosen from the filter menu
 *
 * Keeping parse/label/serialize here (rather than in the component) means the
 * typed grammar and the picked chips can't drift apart, and the mapping to API
 * params has one home.
 */
import { SearchEmailsParams } from "./api";

export type SearchFilterKind =
  | "tag"
  | "from"
  | "to"
  | "unread"
  | "read"
  | "starred"
  | "attachments"
  /** Mail carrying none of the rule-engine labels. The complement of every tag
   *  pill, and the same definition the Email Cleaner's Uncategorized tab uses
   *  (core.UNCATEGORIZED_SQL) — one meaning of "uncategorized" per mailbox. */
  | "uncategorized";

export interface SearchFilter {
  kind: SearchFilterKind;
  /** The typed/picked value for tag/from/to. Unused by the flag pills. */
  value: string;
}

/** Flag pills carry no value — their presence IS the filter. */
const FLAG_KINDS: SearchFilterKind[] = [
  "unread", "read", "starred", "attachments", "uncategorized",
];

export function isFlagKind(kind: SearchFilterKind): boolean {
  return FLAG_KINDS.includes(kind);
}

/** Pills that contradict each other: adding one drops the other. */
const EXCLUSIVE_PAIRS: [SearchFilterKind, SearchFilterKind][] = [
  ["unread", "read"],
];

/**
 * Kinds that hold at most ONE value — a new one replaces the old.
 *
 * from/to map to a single from_addr/to_addr param, so a second `from:` pill
 * can't take effect: toSearchParams sends only one address. Rather than let two
 * "From:" chips sit in the bar while only one filters (a lie about what's
 * applied), adding a second replaces the first. Tags are NOT singleton — they
 * stack and AND together.
 */
const SINGLETON_KINDS = new Set<SearchFilterKind>(["from", "to"]);

/** `prefix:` → the pill it produces. Value-taking prefixes. */
const VALUE_PREFIXES: Record<string, SearchFilterKind> = {
  from: "from",
  to: "to",
  tag: "tag",
  label: "tag",
  category: "tag",
};

/** Whole tokens that map to a flag pill, e.g. `is:unread`. */
const FLAG_TOKENS: Record<string, SearchFilterKind> = {
  "is:unread": "unread",
  "is:uncategorized": "uncategorized",
  "is:untagged": "uncategorized",
  "is:read": "read",
  "is:starred": "starred",
  "has:attachment": "attachments",
  "has:attachments": "attachments",
};

const PILL_LABELS: Record<SearchFilterKind, string> = {
  tag: "Tag",
  from: "From",
  to: "To",
  unread: "Unread",
  read: "Read",
  starred: "Starred",
  attachments: "Has attachment",
  uncategorized: "Uncategorized",
};

/** Human text for a chip: "From: Fracktal Finance", "Unread". */
export function filterLabel(f: SearchFilter): string {
  return isFlagKind(f.kind) ? PILL_LABELS[f.kind] : `${PILL_LABELS[f.kind]}: ${f.value}`;
}

/** Identity of a pill, for dedupe. Flags are unique per kind; valued pills are
 *  unique per kind+value (case-insensitively — "from:Alice" == "from:alice"). */
export function filterKey(f: SearchFilter): string {
  return isFlagKind(f.kind) ? f.kind : `${f.kind}:${f.value.trim().toLowerCase()}`;
}

/**
 * Add a pill, dropping any duplicate or contradicting one.
 * Returns a new array (never mutates).
 */
export function addFilter(filters: SearchFilter[], next: SearchFilter): SearchFilter[] {
  const value = next.value.trim();
  if (!isFlagKind(next.kind) && !value) return filters; // "from:" with no value
  const candidate: SearchFilter = { kind: next.kind, value };
  const contradicts = new Set<SearchFilterKind>();
  for (const [a, b] of EXCLUSIVE_PAIRS) {
    if (candidate.kind === a) contradicts.add(b);
    if (candidate.kind === b) contradicts.add(a);
  }
  // A singleton kind (from/to) replaces any existing pill of the same kind, not
  // just an exact-value dupe — two "From:" chips can't both be in effect.
  const isDup = (f: SearchFilter) =>
    SINGLETON_KINDS.has(candidate.kind)
      ? f.kind === candidate.kind
      : filterKey(f) === filterKey(candidate);
  const kept = filters.filter((f) => !isDup(f) && !contradicts.has(f.kind));
  return [...kept, candidate];
}

/**
 * Split raw input into pills + the leftover text query.
 *
 * Recognises `from:`, `to:`, `tag:`/`label:`/`category:`, `is:unread|read|
 * starred` and `has:attachment(s)`. A value may be quoted to keep its spaces:
 * `from:"Fracktal Finance"`. Anything unrecognised stays as search text, so
 * typing a bare colon (or a URL) never silently eats part of the query.
 */
export function parseQuery(
  raw: string,
  existing: SearchFilter[] = []
): { filters: SearchFilter[]; text: string } {
  let filters = [...existing];
  const words: string[] = [];
  // Tokenise on whitespace, but keep "quoted values" together.
  const tokens = raw.match(/(?:[^\s"]+(?:"[^"]*")?|"[^"]*")+/g) ?? [];

  for (const token of tokens) {
    const flag = FLAG_TOKENS[token.toLowerCase()];
    if (flag) {
      filters = addFilter(filters, { kind: flag, value: "" });
      continue;
    }
    const idx = token.indexOf(":");
    if (idx > 0) {
      const prefix = token.slice(0, idx).toLowerCase();
      const kind = VALUE_PREFIXES[prefix];
      if (kind) {
        const value = unquote(token.slice(idx + 1));
        if (value) {
          filters = addFilter(filters, { kind, value });
          continue;
        }
      }
    }
    words.push(token);
  }
  return { filters, text: words.join(" ").trim() };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).trim();
  return t;
}

/**
 * Fold pills into the API params. Tag pills stack into `labels` (the server ANDs
 * them); the rest map onto their dedicated filters.
 */
export function toSearchParams(
  filters: SearchFilter[]
): Pick<
  SearchEmailsParams,
  | "labels"
  | "fromAddr"
  | "toAddr"
  | "isRead"
  | "isStarred"
  | "hasAttachments"
  | "uncategorized"
> {
  const labels = filters.filter((f) => f.kind === "tag").map((f) => f.value);
  // Multiple from:/to: pills would AND into nothing (one sender can't be two
  // people), so the last one wins — addFilter already dropped exact dupes.
  const last = (kind: SearchFilterKind) =>
    [...filters].reverse().find((f) => f.kind === kind)?.value;
  const has = (kind: SearchFilterKind) => filters.some((f) => f.kind === kind);

  return {
    labels: labels.length ? labels : undefined,
    fromAddr: last("from"),
    toAddr: last("to"),
    isRead: has("unread") ? false : has("read") ? true : undefined,
    isStarred: has("starred") ? true : undefined,
    hasAttachments: has("attachments") ? true : undefined,
    uncategorized: has("uncategorized") ? true : undefined,
  };
}

/** True when anything would narrow the list — text typed or any pill set. */
export function isSearchActive(text: string, filters: SearchFilter[]): boolean {
  return Boolean(text.trim()) || filters.length > 0;
}
