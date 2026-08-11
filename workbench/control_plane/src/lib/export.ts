/**
 * The CSV download seam — one per app would be one too many.
 *
 * Two apps export a filtered list today (Projects, WS-27ae; the CRM,
 * WS-26i-export) and both need exactly the same two things once the fetch has
 * come back: the name the SERVER chose, and the bytes handed to the browser
 * without being decoded on the way. Both are small, both are subtle, and both
 * were written first inside `app/projects/lib/export.ts` — this is that pair
 * promoted, not copied (CLAUDE.md §4: a second implementation of an existing
 * seam is a defect, not a feature).
 *
 * What is NOT here: the query builders. `exportQuery`/`exportPath` are shaped
 * by each app's own filter vocabulary and belong beside it.
 *
 * ⚠️ **The export is fetched, not navigated to.** Pointing `window.location` at
 * an export endpoint would download the file, but both servers REFUSE a filter
 * wider than their row cap (422 rather than a truncated file), and a navigation
 * turns that refusal into a tab full of JSON. Fetching it means the refusal
 * arrives as a message the app can show — which is the entire point of refusing
 * rather than truncating.
 */

/**
 * The filename the SERVER chose, off `Content-Disposition`.
 *
 * Read back rather than composed here so there is one of it. A client-side
 * name would be a second opinion about what the file is called, and the two
 * would drift the first time either side gained a project slug or an entity
 * name.
 *
 * `fallback` is required rather than defaulted: a default here would be one
 * app's filename living in a shared module, silently naming the other app's
 * downloads after it the day a proxy dropped the header.
 */
export function filenameFromDisposition(
  header: string | null,
  fallback: string
): string {
  const quoted = /filename="([^"]+)"/.exec(header ?? "");
  if (quoted) return quoted[1];
  const bare = /filename=([^;]+)/.exec(header ?? "");
  return bare ? bare[1].trim() : fallback;
}

/**
 * Hand a fetched CSV to the browser as a download.
 *
 * ⚠️ **It takes a `Blob`, and that is not a detail.** The obvious version reads
 * `await res.text()` and wraps the string — and `Response.text()` decodes UTF-8
 * with `TextDecoder`, which **strips a leading byte order mark**. The gateway
 * emits that BOM for exactly one reason: without it Excel reads the file as the
 * system code page and every non-ASCII name arrives mojibake. So the text path
 * silently undid the server's fix, and the file downloaded from a running
 * browser was measurably different from the bytes the endpoint produced.
 * Keeping the body as bytes end to end is what makes them the same file.
 *
 * ⚠️ Untested by construction: `vitest.config.ts` runs `environment: "node"`
 * with `include: ["src/**\/*.test.ts"]`, so there is no `document` here and
 * adding jsdom to cover six lines of DOM plumbing is a larger change than the
 * thing covered. Everything with a decision in it — the query, the filename,
 * the refusal path — is a pure function and IS tested; the BOM is pinned on the
 * server side (`test_projects_export`, `test_crm_export`) and was caught in a
 * real browser.
 */
export function saveCsv(body: Blob, filename: string): void {
  const url = URL.createObjectURL(body);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
