import { describe, expect, it } from "vitest";
import {
  activeChip,
  applyChip,
  canSortBy,
  chipsFor,
  hasPipeline,
  listQuery,
  queryString,
  SORTS,
} from "./filters";
import { DEFAULT_VIEW } from "./urlState";
import { ENTITIES, type Status } from "./types";

const LANES: Status[] = [
  {
    id: "s2",
    name: "Proposal",
    color: "amber",
    position: 30,
    type: "ongoing",
    is_default: false,
  },
  {
    id: "s1",
    name: "New",
    color: "gray",
    position: 10,
    type: "open",
    is_default: true,
  },
];

describe("listQuery", () => {
  it("never sends ?status_id to an entity without a pipeline", () => {
    // The gateway answers 422 rather than ignoring it, precisely because a
    // shared list component across four entities is what would send it. The
    // client's half of that rule is not asking.
    const view = { ...DEFAULT_VIEW, statusId: "s1" };
    expect(listQuery("contacts", view).status_id).toBeUndefined();
    expect(listQuery("organizations", view).status_id).toBeUndefined();
    expect(listQuery("deals", view).status_id).toBe("s1");
    expect(listQuery("leads", view).status_id).toBe("s1");
  });

  it("only offers the converted filter where converted means something", () => {
    const view = { ...DEFAULT_VIEW, includeConverted: true };
    expect(listQuery("leads", view).include_converted).toBe(true);
    expect(listQuery("deals", view).include_converted).toBeUndefined();
  });

  it("caps page_size at the gateway's own ceiling", () => {
    expect(listQuery("deals", DEFAULT_VIEW, 1, 10_000).page_size).toBe(100);
  });

  it("trims the search box and omits it when empty", () => {
    expect(listQuery("deals", { ...DEFAULT_VIEW, q: "  bosch " }).q).toBe("bosch");
    expect(listQuery("deals", { ...DEFAULT_VIEW, q: "   " }).q).toBeUndefined();
  });

  it("sends the sorted column and its direction", () => {
    // The header used to flip its own arrow and issue an unchanged request.
    const query = listQuery("deals", {
      ...DEFAULT_VIEW,
      sort: "amount",
      dir: "asc",
    });
    expect(query.sort).toBe("amount");
    expect(query.dir).toBe("asc");
  });

  it("omits dir when no column is sorted", () => {
    // On its own it orders nothing; sending it would put a parameter on every
    // list request that changes no answer.
    const query = listQuery("deals", DEFAULT_VIEW);
    expect(query.sort).toBeUndefined();
    expect(query.dir).toBeUndefined();
  });

  it("drops a sort key the gateway does not allowlist for this entity", () => {
    // `?tab=leads&sort=amount` is one paste away, and an unknown key is a 422
    // that empties the list rather than a silent fall back to the default.
    const stale = { ...DEFAULT_VIEW, tab: "leads" as const, sort: "amount" };
    expect(listQuery("leads", stale).sort).toBeUndefined();
    expect(canSortBy("leads", "amount")).toBe(false);
    expect(canSortBy("deals", "amount")).toBe(true);
  });
});

describe("queryString", () => {
  it("drops empties so the URL stays readable", () => {
    expect(queryString({ q: "", page: 1, owner: undefined })).toBe("?page=1");
    expect(queryString({})).toBe("");
  });

  it("serializes booleans the way FastAPI parses them", () => {
    expect(queryString({ include_converted: true })).toBe(
      "?include_converted=true"
    );
  });
});

describe("chipsFor", () => {
  it("leads with All and then the lanes in position order", () => {
    const chips = chipsFor("leads", LANES, DEFAULT_VIEW);
    expect(chips.map((c) => c.label)).toEqual([
      "All",
      "New",
      "Proposal",
      "Converted",
    ]);
  });

  it("offers the converted chip on leads only", () => {
    expect(
      chipsFor("deals", LANES, DEFAULT_VIEW).some((c) => c.id === "converted")
    ).toBe(false);
  });

  it("renders no chip row at all where there is no pipeline", () => {
    // A chip row that filters by nothing is furniture.
    expect(chipsFor("contacts", LANES, DEFAULT_VIEW)).toEqual([]);
    expect(chipsFor("organizations", LANES, DEFAULT_VIEW)).toEqual([]);
  });

  it("marks the converted chip when it is on", () => {
    const chips = chipsFor("leads", LANES, {
      ...DEFAULT_VIEW,
      includeConverted: true,
    });
    expect(chips.at(-1)!.label).toContain("✓");
  });
});

describe("applyChip", () => {
  it("selects a lane and clears back to All", () => {
    const selected = applyChip(DEFAULT_VIEW, "s1");
    expect(selected.statusId).toBe("s1");
    expect(applyChip(selected, "all").statusId).toBeNull();
    expect(activeChip(selected)).toBe("s1");
    expect(activeChip(DEFAULT_VIEW)).toBe("all");
  });

  it("toggles converted rather than selecting it", () => {
    // It is not a lane — it widens the set instead of narrowing it, so it has
    // to be able to go off again.
    const on = applyChip(DEFAULT_VIEW, "converted");
    expect(on.includeConverted).toBe(true);
    expect(applyChip(on, "converted").includeConverted).toBe(false);
  });

  it("leaves the lane selection alone when converted is toggled", () => {
    const view = { ...DEFAULT_VIEW, statusId: "s1" };
    expect(applyChip(view, "converted").statusId).toBe("s1");
  });
});

describe("SORTS", () => {
  it("covers every entity, so no list ships without sortable columns", () => {
    for (const entity of ENTITIES) {
      expect(SORTS[entity].length).toBeGreaterThan(0);
    }
  });

  it("only names keys the gateway allowlists", () => {
    // An unknown sort key is a 422 by design (never a silent fall back to the
    // default), so a column header offering one would be a dead button. This
    // list mirrors Entity.sorts in routes/crm/core.py.
    const allowlisted: Record<string, string[]> = {
      deals: [
        "name",
        "amount",
        "probability",
        "expected_close_date",
        "closed_at",
        "status_changed_at",
        "owner_email",
        "created_at",
        "updated_at",
        "last_activity_at",
      ],
      leads: [
        "lead_name",
        "email",
        "owner_email",
        "status_id",
        "annual_revenue",
        "converted_at",
        "created_at",
        "updated_at",
        "last_activity_at",
      ],
      contacts: [
        "first_name",
        "last_name",
        "email",
        "owner_email",
        "created_at",
        "updated_at",
        "last_activity_at",
      ],
      organizations: [
        "name",
        "owner_email",
        "created_at",
        "updated_at",
        "last_activity_at",
      ],
    };
    for (const entity of ENTITIES) {
      for (const { key } of SORTS[entity]) {
        expect(allowlisted[entity]).toContain(key);
      }
    }
  });
});

describe("hasPipeline", () => {
  it("names exactly the two entities with a status_id column", () => {
    expect(ENTITIES.filter(hasPipeline)).toEqual(["deals", "leads"]);
  });
});
