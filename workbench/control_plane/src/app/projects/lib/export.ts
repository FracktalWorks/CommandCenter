/**
 * Projects · the CSV export's client half (WS-27ae, P-26).
 *
 * The endpoint is `GET /api/projects/export/tasks.csv` and it exports **the
 * filter that is on screen**, with **the columns the view is showing**. So the
 * only thing this module does is hand the server the state the board is already
 * holding — through the SAME `toQuery`/`sortQuery` the list fetch uses, never a
 * second serialisation. Two of those would drift and then the file and the
 * table would disagree about what "my open bugs in Ops" means, which is the
 * whole bug class the one-builder rule exists for.
 *
 * ⚠️ **The export is fetched, not navigated to.** Pointing `window.location` at
 * the endpoint would download the file, but the server REFUSES a filter wider
 * than its row cap (422 rather than a truncated file), and a navigation turns
 * that refusal into a tab full of JSON. Fetching it means the refusal arrives
 * as a message the board can show — which is the entire point of refusing
 * rather than truncating.
 */

import { type Filters, toQuery } from "./grouping";
import { type TableSort, sortQuery } from "./table";

/** What the export needs to know, all of it already on screen. */
export interface ExportRequest {
  /** The selected project, or `null` for "everything I can see". */
  projectId: string | null;
  filters: Filters;
  /** The view's shown fields — the file's columns, in the table's order. */
  shownFields: readonly string[];
  /** The table's header sort, or `null` for the endpoint's default. */
  sort: TableSort | null;
}

/**
 * The query string for one export.
 *
 * `include_subtree` rides along with a project for the same reason the board's
 * fetch sends it: what you are looking at is the project AND its subprojects,
 * and an export of the parent alone would be missing most of the rows on
 * screen.
 *
 * An empty `shownFields` is sent as an empty parameter rather than omitted, so
 * "this view shows no columns" reaches the server as a choice — the same
 * absent-versus-explicitly-empty distinction `sanitizeShownFields` keeps.
 */
export function exportQuery(request: ExportRequest): Record<string, string> {
  const params: Record<string, string> = {
    ...toQuery(request.filters),
    ...sortQuery(request.sort),
    shown_fields: request.shownFields.join(","),
  };
  if (request.projectId) {
    params.project_id = request.projectId;
    params.include_subtree = "true";
  }
  return params;
}

/** `exportQuery` as the path the BFF proxy serves. */
export function exportPath(request: ExportRequest): string {
  const qs = new URLSearchParams(exportQuery(request));
  return `/api/projects/export/tasks.csv?${qs.toString()}`;
}

/**
 * The filename the SERVER chose, off `Content-Disposition`.
 *
 * Read back rather than composed here so there is one of it. A client-side
 * name would be a second opinion about what the file is called, and the two
 * would drift the first time either side gained a project slug.
 */
export function filenameFromDisposition(
  header: string | null,
  fallback = "projects-tasks.csv"
): string {
  const quoted = /filename="([^"]+)"/.exec(header ?? "");
  if (quoted) return quoted[1];
  const bare = /filename=([^;]+)/.exec(header ?? "");
  return bare ? bare[1].trim() : fallback;
}

/**
 * Whether the Export button does anything.
 *
 * Exporting "everything I can see" is a legitimate request the endpoint
 * answers, so this is NOT gated on a project — only on the board having
 * finished loading enough to describe itself.
 */
export function canExport(request: ExportRequest): boolean {
  return Array.isArray(request.shownFields);
}

/**
 * Hand a fetched CSV to the browser as a download.
 *
 * ⚠️ **It takes a `Blob`, and that is not a detail.** The obvious version reads
 * `await res.text()` and wraps the string — and `Response.text()` decodes UTF-8
 * with `TextDecoder`, which **strips a leading byte order mark**. The gateway
 * emits that BOM for exactly one reason: without it Excel reads the file as the
 * system code page and every non-ASCII task title arrives mojibake. So the text
 * path silently undid the server's fix, and the file downloaded from a running
 * browser was measurably different from the bytes the endpoint produced.
 * Keeping the body as bytes end to end is what makes them the same file.
 *
 * ⚠️ Untested by construction: `vitest.config.ts` runs `environment: "node"`
 * with `include: ["src/**\/*.test.ts"]`, so there is no `document` here and
 * adding jsdom to cover six lines of DOM plumbing is a larger change than the
 * thing covered. Everything with a decision in it — the query, the filename,
 * the refusal path — is a pure function above and IS tested; the BOM is pinned
 * on the server side (`test_projects_export`) and was caught in a real browser.
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
