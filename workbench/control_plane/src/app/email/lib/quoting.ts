/**
 * Quoted / trailing-mail detection, shared by the message viewer (collapse the
 * quote behind a "•••" toggle) and the composers (keep the quote OUT of the
 * editable body so it's never edited — or fed to the AI drafter — by mistake).
 *
 * A reply/forward carries the whole earlier conversation quoted underneath the
 * new text. These helpers split a body into the *new* content and the *quoted
 * trailing* chain. The quote is preserved verbatim — it's separated, not lost.
 */

/** Does `el` have a preceding `<hr>` sibling (Outlook draws one above the quoted
 *  header)?  Skips empty wrappers Outlook sometimes inserts. */
function hrBefore(el: Element): Element | null {
  let p: Element | null = el.previousElementSibling;
  while (p && p.tagName !== "HR" && (p.textContent ?? "").trim() === "") {
    p = p.previousElementSibling;
  }
  return p && p.tagName === "HR" ? p : null;
}

/** Find the element that begins the quoted/trailing portion, if any. Ordered by
 *  how reliable each provider's marker is. */
function findQuoteBoundary(body: HTMLElement): Element | null {
  // Outlook (web): an empty marker div sits right before the divider + quote.
  const append = body.querySelector("#appendonsend");
  if (append) return hrBefore(append) || append;

  // Outlook (desktop): the reply/forward header div; pull in a preceding <hr>.
  const outlook = body.querySelector("#divRplyFwdMsg");
  if (outlook) return hrBefore(outlook) || outlook;

  // Gmail: outer container (newer markup) or the quote wrapper.
  const gmail =
    body.querySelector(".gmail_quote_container") ||
    body.querySelector(".gmail_quote");
  if (gmail) return gmail;

  // Thunderbird.
  const moz = body.querySelector(".moz-cite-prefix");
  if (moz) return moz;

  // Apple Mail / generic cited blockquote.
  const cite = body.querySelector("blockquote[type='cite']");
  if (cite) return cite;

  // A bare blockquote — only when it isn't the very first node (so we don't hide
  // a forward that is itself just a quote). The empty-main guard below is the
  // real backstop.
  const bq = body.querySelector("blockquote");
  if (bq && bq !== body.firstElementChild) return bq;

  return null;
}

/** Split raw HTML into the new content and the quoted trailing chain. Returns
 *  `quoted: null` when there's no quote (or splitting would leave nothing). */
export function splitQuotedHtml(raw: string): { main: string; quoted: string | null } {
  if (typeof window === "undefined" || typeof DOMParser === "undefined")
    return { main: raw, quoted: null };
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(raw, "text/html");
  } catch {
    return { main: raw, quoted: null };
  }
  const body = doc.body;
  if (!body) return { main: raw, quoted: null };
  const boundary = findQuoteBoundary(body);
  if (!boundary) return { main: raw, quoted: null };
  try {
    // Take the boundary node and everything after it (document order), keeping
    // wrapper structure intact — a Range handles the nested-wrapper case where
    // the quote header lives mid-way inside one big Outlook <div>.
    const range = doc.createRange();
    range.setStartBefore(boundary);
    range.setEnd(body, body.childNodes.length);
    const frag = range.cloneContents();
    range.deleteContents();
    const main = body.innerHTML;
    // If nothing meaningful is left outside the quote, don't collapse anything.
    const mainText = main.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
    if (mainText.length === 0 && !/<img/i.test(main))
      return { main: raw, quoted: null };
    const holder = doc.createElement("div");
    holder.appendChild(frag);
    const quoted = holder.innerHTML;
    return { main, quoted: quoted.trim() ? quoted : null };
  } catch {
    return { main: raw, quoted: null };
  }
}

/** Plain-text markers that begin a quoted block. */
const TEXT_BOUNDARY: RegExp[] = [
  /^>/,
  /^\s*On\b.+\bwrote:\s*$/i,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^_{5,}\s*$/,
  /^From:\s.+\S/i,
];

/** Split a plain-text body into new content + quoted trailing chain. */
export function splitQuotedText(text: string): { main: string; quoted: string | null } {
  if (!text) return { main: text, quoted: null };
  const lines = text.split("\n");
  let idx = -1;
  // Scanned from line 0, NOT line 1. If the first line is already inside a quote
  // the whole body is one (a bare forward), and the `idx < 1` guard below then
  // returns it whole. Starting at 1 skipped that check, so such a body was cut
  // at its SECOND line: the first quoted line became "new content" — handed to
  // the AI drafter as the user's text, and shown uncollapsed in the viewer.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TEXT_BOUNDARY.some((re) => re.test(line))) {
      // "From:" alone is a weak signal — only treat it as a quote boundary when
      // it heads a header block (a nearby Sent/Date/To/Subject line follows).
      if (/^From:\s/i.test(line)) {
        const ahead = "\n" + lines.slice(i, i + 5).join("\n");
        if (!/\n(Sent|Date|To|Subject):/i.test(ahead)) continue;
      }
      idx = i;
      break;
    }
  }
  if (idx < 1) return { main: text, quoted: null };
  const main = lines.slice(0, idx).join("\n").replace(/\s+$/, "");
  if (!main.trim()) return { main: text, quoted: null };
  const quoted = lines.slice(idx).join("\n").trim();
  return { main, quoted: quoted ? quoted : null };
}
