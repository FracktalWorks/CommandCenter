import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { CrmError } from "./api";

// ── The client goes through the BFF, and refusals keep their meaning ──────
//
// Migration 144 has not been applied anywhere, so what can be asserted here
// is the request shape and the error contract — the fixture level the ticket
// scopes this to. Live rendering, drag persistence and deep links are
// owner-verified after the migration applies.

type Fetch = typeof globalThis.fetch;

function stub(
  status: number,
  body: unknown
): { calls: [string, RequestInit | undefined][]; restore: () => void } {
  const calls: [string, RequestInit | undefined][] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(input), init]);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as Fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

afterEach(() => vi.restoreAllMocks());

describe("every request goes through /api/crm", () => {
  it("never addresses the gateway directly", async () => {
    // A top-level fetch at api.* carries no Bearer and no X-User-Email — the
    // session cookie is on this origin — so it 401s. That is the failure that
    // took out every email-account connection for six days.
    const { calls, restore } = stub(200, { rows: [], total: 0 });
    try {
      await api.listRecords("deals", { page: 2, page_size: 25 });
      await api.getPipeline("VJ@Fracktal.in");
      await api.listStatuses("deal");
    } finally {
      restore();
    }
    expect(calls.map(([url]) => url)).toEqual([
      "/api/crm/deals?page=2&page_size=25",
      "/api/crm/pipeline?owner=VJ%40Fracktal.in",
      "/api/crm/statuses/deal",
    ]);
  });

  it("issues the kanban drag as a PATCH of status_id", async () => {
    const { calls, restore } = stub(200, { id: "d1" });
    try {
      await api.moveDeal("d1", "s2");
    } finally {
      restore();
    }
    const [url, init] = calls[0];
    expect(url).toBe("/api/crm/deals/d1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ status_id: "s2" });
  });

  it("carries a lost reason alongside the move when one is required", async () => {
    // Entering a lost-type status without one is a 422 BEFORE any of the
    // transition's three effects, so the reason travels with the move rather
    // than in a second request that could land on its own.
    const { calls, restore } = stub(200, { id: "d1" });
    try {
      await api.moveDeal("d1", "lost-lane", {
        lost_reason_id: "r1",
        lost_note: "chose a competitor",
      });
    } finally {
      restore();
    }
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      status_id: "lost-lane",
      lost_reason_id: "r1",
      lost_note: "chose a competitor",
    });
  });

  it("addresses the deal-contacts endpoints WS-26c added", async () => {
    const { calls, restore } = stub(200, { rows: [] });
    try {
      await api.listDealContacts("d1");
      await api.addDealContact("d1", { contact_id: "c1", is_primary: true });
      await api.removeDealContact("d1", "c1");
    } finally {
      restore();
    }
    expect(calls.map(([url, init]) => `${init?.method ?? "GET"} ${url}`)).toEqual([
      "GET /api/crm/deals/d1/contacts",
      "POST /api/crm/deals/d1/contacts",
      "DELETE /api/crm/deals/d1/contacts/c1",
    ]);
  });
});

describe("refusals keep their status", () => {
  it("surfaces the gateway's own detail, not a generic failure", async () => {
    // The CRM says a great deal with its codes and its detail text — "this
    // status still holds 4 record(s)" is the whole of what the user needs.
    const { restore } = stub(409, {
      detail: "This status still holds 4 record(s).",
    });
    try {
      await expect(api.deleteRecord("deals", "d1")).rejects.toThrow(
        "This status still holds 4 record(s)."
      );
    } finally {
      restore();
    }
  });

  it("keeps the code, so the UI can tell a rule from a bug", async () => {
    const { restore } = stub(422, { detail: "Unknown sort key 'nope'." });
    try {
      await api.listRecords("deals", { sort: "nope" }).then(
        () => expect.unreachable("a 422 must not resolve"),
        (err: unknown) => {
          expect(err).toBeInstanceOf(CrmError);
          expect((err as CrmError).status).toBe(422);
        }
      );
    } finally {
      restore();
    }
  });

  it("renders FastAPI's validation array as words", async () => {
    // `detail` is a string for our own HTTPExceptions and an array of objects
    // for a Pydantic failure; "[object Object]" at the user turns a perfectly
    // clear refusal into gibberish.
    const { restore } = stub(422, {
      detail: [{ loc: ["body", "name"], msg: "field required" }],
    });
    try {
      await expect(
        api.createRecord("deals", {})
      ).rejects.toThrow("field required");
    } finally {
      restore();
    }
  });
});
