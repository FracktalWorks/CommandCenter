/**
 * Signature-in-body helpers for the composers.
 *
 * The signature lives IN the editable draft body (so upstream-synced drafts
 * show it, and the user can edit around it) instead of a separate preview
 * card. The composers seed the SERVER's plain-text rendering
 * (`signature_text` from the assistant settings) so the backend's idempotent
 * draft-signing recognises it byte-for-byte — a client-side re-derivation
 * could drift by whitespace and end up double-signed.
 */

import { getAssistantSettings } from "./api";

// Signatures rarely change within a session; cache per account so every
// composer open doesn't re-fetch the settings row.
const _cache = new Map<string, string>();

/** Client-side fallback rendering for older gateways that don't return
 *  `signature_text` — mirrors the server's html_to_text (br/block tags →
 *  newlines, tags stripped, entities unescaped, blank runs collapsed). */
export function signatureHtmlToText(html: string): string {
  let s = (html || "").replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\/\s*(p|div|tr|li|h[1-6]|table)\s*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  if (typeof document !== "undefined") {
    const el = document.createElement("textarea");
    el.innerHTML = s;
    s = el.value;
  }
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** The account's signature as plain text ("" when unset / on failure). */
export async function getSignatureText(
  accountId?: string | null,
): Promise<string> {
  if (!accountId) return "";
  const hit = _cache.get(accountId);
  if (hit !== undefined) return hit;
  try {
    const s = await getAssistantSettings(accountId);
    const sig =
      (s?.signature_text ?? "").trim() ||
      signatureHtmlToText((s?.signature || "").trim());
    _cache.set(accountId, sig);
    return sig;
  } catch {
    return ""; // no seed — the backend still signs the draft on save
  }
}

/** Body with the signature appended (blank line between) — idempotent, so a
 *  reopened or re-seeded draft never accumulates copies. */
export function appendSignature(body: string, sig: string): string {
  if (!sig) return body;
  if ((body || "").includes(sig)) return body;
  const base = (body || "").replace(/\s+$/, "");
  return base ? `${base}\n\n${sig}` : sig;
}

/** Body without the signature block (first occurrence), blank runs collapsed.
 *  Used to judge whether the user has actually written anything ("Draft" vs
 *  "Improve" in the AI bar) — the backend strips it again server-side. */
export function stripSignature(body: string, sig: string): string {
  const b = body || "";
  if (!sig || !b.includes(sig)) return b;
  const idx = b.indexOf(sig);
  return (b.slice(0, idx) + b.slice(idx + sig.length))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The seed for a fresh reply body: two blank lines to type into, then the
 *  signature — caret goes to the top (Gmail-style). "" when no signature. */
export function seededBody(sig: string): string {
  return sig ? `\n\n${sig}` : "";
}
