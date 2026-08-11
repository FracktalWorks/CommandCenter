/**
 * The shared CSV download seam, and the one thing that can silently undo it.
 *
 * Two halves:
 *
 *   1. BEHAVIOUR — `filenameFromDisposition` reads the name the server chose.
 *   2. THE INVARIANT — a static sweep of the BFF proxies that front an export
 *      endpoint. This half is the one that matters: the CRM proxy stamped
 *      `application/json` on every response, so a `text/csv` body arrived as
 *      `{}` with a 200 — a download that looks like a working request and
 *      produces no file. Projects hit exactly this and fixed it locally
 *      (WS-27ae); a local fix to a systemic shape is how the CRM inherited it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { filenameFromDisposition } from "@/lib/export";

// ---------------------------------------------------------------------------
// 1. The filename
// ---------------------------------------------------------------------------

describe("filenameFromDisposition", () => {
  it("reads the name the SERVER chose", () => {
    expect(
      filenameFromDisposition(
        'attachment; filename="projects-tasks-p1.csv"',
        "fallback.csv"
      )
    ).toBe("projects-tasks-p1.csv");
  });

  it("reads an unquoted name too", () => {
    expect(
      filenameFromDisposition("attachment; filename=export.csv", "fallback.csv")
    ).toBe("export.csv");
  });

  it("falls back rather than downloading a file called null", () => {
    expect(filenameFromDisposition(null, "crm-leads.csv")).toBe("crm-leads.csv");
    expect(filenameFromDisposition("attachment", "crm-leads.csv")).toBe(
      "crm-leads.csv"
    );
  });

  it("takes the caller's fallback, not one app's filename", () => {
    // A default here would name the CRM's downloads after Projects the day a
    // proxy dropped the header — which is precisely the failure below.
    expect(filenameFromDisposition(null, "projects-tasks.csv")).toBe(
      "projects-tasks.csv"
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The proxies a CSV has to survive
// ---------------------------------------------------------------------------

/** Every BFF proxy that fronts a `text/csv` export endpoint. */
const EXPORT_PROXIES = [
  "app/api/projects/[...path]/route.ts",
  "app/api/crm/[...path]/route.ts",
];

function proxySource(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./../${relative}`, import.meta.url)),
    "utf-8"
  );
}

describe.each(EXPORT_PROXIES)("%s", (relative) => {
  const source = proxySource(relative);

  it("passes the UPSTREAM content type through instead of stamping one", () => {
    // ⚠️ `NextResponse.json(body, …)` sets `application/json` unconditionally.
    // On a CSV that turns a download into a document: the browser renders the
    // bytes, or the client's `res.json()` yields `{}` with a 200 and nothing is
    // saved. Reading what upstream actually sent is what keeps a refusal (JSON)
    // and a file (CSV) both correct through one code path.
    expect(source).toContain('res.headers.get("content-type")');
  });

  it("forwards the Content-Disposition, because the filename is the server's", () => {
    expect(source).toContain('res.headers.get("content-disposition")');
    expect(source).toContain('"Content-Disposition"');
  });

  it("does not re-encode the forwarded body as JSON", () => {
    // `res.text()` keeps the bytes; `res.json()` + `NextResponse.json()` does
    // not, and a CSV is the case where that is not merely wasteful.
    expect(source).toContain("await res.text()");
    expect(source).not.toMatch(/return NextResponse\.json\(\s*resBody/);
  });
});
