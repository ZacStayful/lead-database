import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StayfulPipelineItem } from "@/lib/monday";
import {
  STAYFUL_CONFLICT_MATCHED_BY,
  buildStayfulPipelineIndex,
  findStayfulConflict,
  isStayfulConflicted,
} from "@/lib/stayfulConflict";

/**
 * The pure half of §64: does this lead match a landlord in one of Stayful's
 * nine pipeline groups? Every branch of the match rule decided with the owner
 * — same item, OR same email (any address in a multi-address cell, lowercased),
 * OR same phone (last nine digits, the 0070 rule), precedence item → email →
 * phone, management only — is pinned here.
 */

const item = (
  id: string,
  over: Partial<StayfulPipelineItem> = {}
): StayfulPipelineItem => ({
  id,
  groupId: "group_mm1dtkdm",
  emails: [],
  phoneKeys: [],
  ...over,
});

const index = () =>
  buildStayfulPipelineIndex([
    item("100", { emails: ["landlord@example.com"], phoneKeys: ["700900123"] }),
    item("200", {
      groupId: "group_mksxb5m0",
      emails: ["first@example.com", "second@example.com"],
      phoneKeys: ["711387707"],
    }),
    item("300", { emails: [], phoneKeys: [] }),
  ]);

describe("findStayfulConflict — the match rule", () => {
  it("matches on the Monday item id", () => {
    expect(
      findStayfulConflict({ lead_type: "management", monday_item_id: "300" }, index())
    ).toEqual({ itemId: "300", groupId: "group_mm1dtkdm", matchedBy: "item" });
  });

  it("matches on email, case-insensitively", () => {
    expect(
      findStayfulConflict(
        { lead_type: "management", monday_item_id: "999", email: "LandLord@Example.com" },
        index()
      )
    ).toEqual({ itemId: "100", groupId: "group_mm1dtkdm", matchedBy: "email" });
  });

  it("matches ANY address in a multi-address cell, on either side", () => {
    // The board side: item 200 carries two addresses.
    expect(
      findStayfulConflict({ lead_type: "management", email: "second@example.com" }, index())
        ?.itemId
    ).toBe("200");
    // The lead side: one cell holding two addresses separated by a space.
    expect(
      findStayfulConflict(
        { lead_type: "management", email: "nobody@example.com landlord@example.com" },
        index()
      )?.itemId
    ).toBe("100");
  });

  it("matches on the last nine digits of the phone, whatever the prefix", () => {
    for (const phone of ["07700 900123", "+447700900123", "447700900123", "+44 (0)7700900123"]) {
      expect(findStayfulConflict({ lead_type: "management", phone }, index())).toEqual({
        itemId: "100",
        groupId: "group_mm1dtkdm",
        matchedBy: "phone",
      });
    }
  });

  it("never matches a placeholder or a too-short number", () => {
    expect(findStayfulConflict({ lead_type: "management", phone: "0000 0000000" }, index())).toBeNull();
    expect(findStayfulConflict({ lead_type: "management", phone: "123456" }, index())).toBeNull();
    expect(findStayfulConflict({ lead_type: "management", phone: "" }, index())).toBeNull();
    expect(findStayfulConflict({ lead_type: "management", phone: null }, index())).toBeNull();
  });

  it("records item over email over phone when more than one rule hits", () => {
    const all = {
      lead_type: "management",
      monday_item_id: "300",
      email: "landlord@example.com",
      phone: "07711387707",
    };
    expect(findStayfulConflict(all, index())?.matchedBy).toBe("item");
    expect(findStayfulConflict({ ...all, monday_item_id: null }, index())?.matchedBy).toBe("email");
    expect(
      findStayfulConflict({ ...all, monday_item_id: null, email: null }, index())?.matchedBy
    ).toBe("phone");
  });

  it("never checks a guaranteed-rent lead, even on an item hit (decision 2)", () => {
    expect(
      findStayfulConflict(
        {
          lead_type: "guaranteed_rent",
          monday_item_id: "300",
          email: "landlord@example.com",
          phone: "07700900123",
        },
        index()
      )
    ).toBeNull();
  });

  it("treats a missing lead_type as management — the row default", () => {
    expect(findStayfulConflict({ monday_item_id: "300" }, index())?.matchedBy).toBe("item");
  });

  it("returns null against an empty index and for a lead with nothing to match on", () => {
    const empty = buildStayfulPipelineIndex([]);
    expect(empty.size).toBe(0);
    expect(findStayfulConflict({ lead_type: "management", monday_item_id: "300" }, empty)).toBeNull();
    expect(findStayfulConflict({ lead_type: "management" }, index())).toBeNull();
  });
});

describe("buildStayfulPipelineIndex", () => {
  it("is deterministic: the lowest item id wins a shared key whatever order the board returned", () => {
    const a = buildStayfulPipelineIndex([
      item("9", { emails: ["dup@example.com"] }),
      item("1", { emails: ["dup@example.com"] }),
    ]);
    const b = buildStayfulPipelineIndex([
      item("1", { emails: ["dup@example.com"] }),
      item("9", { emails: ["dup@example.com"] }),
    ]);
    expect(a.byEmail.get("dup@example.com")?.id).toBe("1");
    expect(b.byEmail.get("dup@example.com")?.id).toBe("1");
  });

  it("never indexes an empty key", () => {
    const idx = buildStayfulPipelineIndex([item("1", { emails: [""], phoneKeys: [""] })]);
    expect(idx.byEmail.size).toBe(0);
    expect(idx.byPhone.size).toBe(0);
    expect(idx.byItem.size).toBe(1);
  });
});

describe("isStayfulConflicted", () => {
  it("reads the stamp and nothing else", () => {
    expect(isStayfulConflicted({ stayful_conflict_at: "2026-09-18T00:00:00Z" })).toBe(true);
    expect(isStayfulConflicted({ stayful_conflict_at: null })).toBe(false);
    expect(isStayfulConflicted({})).toBe(false);
  });
});

describe("the matched_by vocabulary is one contract with the SQL CHECK", () => {
  // A value written here that the CHECK refuses fails the flag RPC on every
  // match of that kind; a value the CHECK admits that this list lacks is a
  // row the admin panel cannot explain. The §29 arrangement for cancelOptions.
  it("equals the CHECK on leads.stayful_conflict_matched_by, parsed from 0155", () => {
    const sql = readFileSync("supabase/migrations/0155_stayful_pipeline_conflict.sql", "utf8");
    const m = sql.match(/stayful_conflict_matched_by in \(([^)]+)\)/);
    expect(m).not.toBeNull();
    const values = Array.from(m![1].matchAll(/'([a-z_]+)'/g), (x) => x[1]).sort();
    expect(values).toEqual([...STAYFUL_CONFLICT_MATCHED_BY].sort());
  });
});
