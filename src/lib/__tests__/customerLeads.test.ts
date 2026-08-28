import { describe, it, expect } from "vitest";
import {
  hasAnyContactDetail,
  isOwnedLead,
  leadSourceLabel,
  toRpcRow,
  viewerScopedLead,
} from "../customerLeads";

describe("toRpcRow", () => {
  /**
   * A customer should not have to know what shape we want. One spreadsheet
   * column holds all of these, and Excel will have eaten the leading zero off
   * at least one of them.
   */
  it("normalises a UK mobile however it was typed", () => {
    for (const raw of [
      "07700 900123",
      "07700900123",
      "+44 7700 900123",
      "+447700900123",
      "447700900123",
      "7700900123",
      "(07700) 900123",
    ]) {
      expect(toRpcRow({ phone: raw }).phone).toBe("07700900123");
    }
  });

  /**
   * ⚠️ THE NUMBER THAT BROKE THE FIRST LIVE SEND. +44778643769 is nine digits
   * after the country code where a UK mobile has ten, so TimelinesAI rejected
   * it with a bare http_400. It is stored EXACTLY as typed rather than blanked
   * or "corrected": the operator has to be able to see it to fix it.
   */
  it("keeps an unusable number exactly as typed, never blanking it", () => {
    expect(toRpcRow({ phone: "+44778643769" }).phone).toBe("+44778643769");
    expect(toRpcRow({ phone: "0117 496 0000" }).phone).toBe("0117 496 0000");
  });

  it("leaves an overseas number alone — abroad is a fact, not a mistake", () => {
    expect(toRpcRow({ phone: "+31 6 12345678" }).phone).toBe("+31 6 12345678");
  });

  it("stores an empty phone as an empty string, as before", () => {
    expect(toRpcRow({ name: "Amie" }).phone).toBe("");
  });

  it("reads the postcode out of the address, as it always has", () => {
    const row = toRpcRow({ address: "12 Bourneside Road, Bristol BS4 3AA" });
    expect(row.postcode).toBe("BS4 3AA");
    expect(row.postcode_area).toBe("BS");
    expect(row.address).toBe("12 Bourneside Road, Bristol BS4 3AA");
  });

  it("prefers an explicit postcode column — the customer who kept one meant it", () => {
    const row = toRpcRow({ address: "12 Bourneside Road, Bristol", postcode: "bs4 3aa" });
    expect(row.postcode).toBe("BS4 3AA");
    expect(row.postcode_area).toBe("BS");
  });

  it("appends a separate postcode to the address so the stored address is complete", () => {
    // Every other consumer in the app finds a postcode by looking in the
    // address, and an address missing its own postcode reads as incomplete to
    // the operator working the lead.
    const row = toRpcRow({ address: "12 Bourneside Road, Bristol", postcode: "BS4 3AA" });
    expect(row.address).toBe("12 Bourneside Road, Bristol, BS4 3AA");
  });

  it("does not append a postcode the address already carries", () => {
    const row = toRpcRow({ address: "12 Bourneside Road, Bristol BS4 3AA", postcode: "BS4 3AA" });
    expect(row.address).toBe("12 Bourneside Road, Bristol BS4 3AA");
  });

  it("keeps the address when the address is the only thing given", () => {
    const row = toRpcRow({ address: "Somewhere with no postcode" });
    expect(row.address).toBe("Somewhere with no postcode");
    expect(row.postcode).toBe("");
    expect(row.postcode_area).toBe("");
  });

  it("falls back to the postcode alone when there is no street", () => {
    const row = toRpcRow({ postcode: "BS4 3AA" });
    expect(row.address).toBe("BS4 3AA");
    expect(row.postcode).toBe("BS4 3AA");
  });

  it("ignores a postcode column holding something that is not a postcode", () => {
    const row = toRpcRow({ address: "12 Foo St, Bristol BS7 8PL", postcode: "n/a" });
    expect(row.postcode).toBe("BS7 8PL");
    expect(row.address).toBe("12 Foo St, Bristol BS7 8PL");
  });

  it("trims and stringifies everything", () => {
    const row = toRpcRow({ name: "  Jane  ", phone: " 07700 900123 ", bedrooms: " 3 " });
    expect(row.name).toBe("Jane");
    // The leading zero is still the thing that matters — nothing here is ever
    // coerced to a number, which is what would eat it. The internal space is
    // gone now because a recognised UK mobile is normalised to its national
    // form, so what is stored is what the send path can dial.
    expect(row.phone).toBe("07700900123");
    expect(row.bedrooms).toBe("3");
  });
});

describe("hasAnyContactDetail", () => {
  it("accepts a row with any way to identify or reach somebody", () => {
    expect(hasAnyContactDetail({ address: "12 Foo St" })).toBe(true);
    expect(hasAnyContactDetail({ phone: "07700 900123" })).toBe(true);
    expect(hasAnyContactDetail({ profile: "Nice place" })).toBe(false);
    expect(hasAnyContactDetail({})).toBe(false);
  });
});

describe("leadSourceLabel", () => {
  it("names a lead the reader added as their own", () => {
    expect(
      leadSourceLabel({ customer_id: "c1", lead: { owner_customer_id: "c1" } })
    ).toBe("Added by you");
  });

  it("names a lead the reader BOUGHT as allocated", () => {
    // THE regression this whole change exists to prevent. Since §32 an analysed
    // owned lead can be sold to one other operator, and read as a bare null
    // check the buyer would be told "Added by you" about a lead they paid £15
    // for — and told, in the badge's tooltip, that it is visible only to them.
    // "Allocated" is both true and silent about who brought it in (§19.7).
    expect(
      leadSourceLabel({ customer_id: "c2", lead: { owner_customer_id: "c1" } })
    ).toBe("Allocated");
  });

  it("still names a pool claim and an ordinary allocation", () => {
    expect(
      leadSourceLabel({ customer_id: "c1", claimed_from_pool_at: "2026-01-01", lead: null })
    ).toBe("Claimed from expired leads");
    expect(leadSourceLabel({ customer_id: "c1", lead: null })).toBe("Allocated");
  });

  it("does not claim ownership when the reader is unknown", () => {
    // A missing customer_id must not resolve to "yours". Fails safe toward the
    // label that reveals nothing.
    expect(leadSourceLabel({ lead: { owner_customer_id: "c1" } })).toBe("Allocated");
  });
});

describe("isOwnedLead", () => {
  it("is true only for the customer who added the lead", () => {
    expect(isOwnedLead({ owner_customer_id: "c1" }, "c1")).toBe(true);
    expect(isOwnedLead({ owner_customer_id: "c1" }, "c2")).toBe(false);
  });

  it("is false for a marketplace lead and for missing input", () => {
    expect(isOwnedLead({ owner_customer_id: null }, "c1")).toBe(false);
    expect(isOwnedLead(null, "c1")).toBe(false);
    expect(isOwnedLead(undefined, "c1")).toBe(false);
    expect(isOwnedLead({ owner_customer_id: "c1" }, null)).toBe(false);
    expect(isOwnedLead({ owner_customer_id: "c1" }, undefined)).toBe(false);
  });
});

describe("viewerScopedLead — contact-quality override metadata (0111)", () => {
  it("strips the override author and note for EVERY viewer", () => {
    const scoped = viewerScopedLead(
      {
        id: "l1",
        owner_customer_id: null,
        lead_quality_override_by: "zac@stayful.co.uk",
        lead_quality_override_note: "Rang it myself, number is fine",
      },
      "c1"
    );
    expect(scoped?.lead_quality_override_by).toBeNull();
    expect(scoped?.lead_quality_override_note).toBeNull();
  });

  it("strips them from the uploader of their own lead too", () => {
    const scoped = viewerScopedLead(
      {
        id: "l1",
        owner_customer_id: "c1",
        lead_quality_override_by: "zac@stayful.co.uk",
        lead_quality_override_note: null,
      },
      "c1"
    );
    // Still their lead — ownership is intact — but the admin's address is not
    // theirs to see.
    expect(scoped?.owner_customer_id).toBe("c1");
    expect(scoped?.lead_quality_override_by).toBeNull();
  });

  it("returns the row untouched when there is no override to strip", () => {
    const lead = { id: "l1", owner_customer_id: null };
    expect(viewerScopedLead(lead, "c1")).toBe(lead);
  });
});

describe("viewerScopedLead", () => {
  it("hides another customer's id from the reader", () => {
    const scoped = viewerScopedLead({ id: "l1", owner_customer_id: "c1" }, "c2");
    expect(scoped).toEqual({ id: "l1", owner_customer_id: null, lead_profile: null });
  });

  it("withholds the uploader's own working material from a buyer", () => {
    // lead_profile on an IMPORTED lead is whatever their spreadsheet had left
    // over — leadImport folds every unmapped column into it as "Header: value".
    // Margins, source attribution, "will take 12%, spoke to Dave". Handing that
    // to a competing operator is a different act from handing over a phone
    // number, and we cannot tell the useful lines from the private ones.
    const scoped = viewerScopedLead(
      { id: "l1", owner_customer_id: "c1", lead_profile: "Margin: 14%\nSource: Dave" },
      "c2"
    );
    expect(scoped?.lead_profile).toBeNull();
  });

  it("leaves the profile intact for the uploader and on a marketplace lead", () => {
    const mine = { id: "l1", owner_customer_id: "c1", lead_profile: "my notes" };
    expect(viewerScopedLead(mine, "c1")?.lead_profile).toBe("my notes");

    // Ours is written to be read by whoever holds the lead — that is the point
    // of it, and it must not be collateral damage.
    const market = { id: "l2", owner_customer_id: null, lead_profile: "qualified by us" };
    expect(viewerScopedLead(market, "c2")?.lead_profile).toBe("qualified by us");
  });

  it("leaves the owner's own lead, and a marketplace lead, untouched", () => {
    const mine = { id: "l1", owner_customer_id: "c1" };
    expect(viewerScopedLead(mine, "c1")).toBe(mine);
    const market = { id: "l2", owner_customer_id: null };
    expect(viewerScopedLead(market, "c1")).toBe(market);
  });

  it("does not mutate the row it was given", () => {
    const original = { id: "l1", owner_customer_id: "c1" };
    viewerScopedLead(original, "c2");
    expect(original.owner_customer_id).toBe("c1");
  });

  it("hides the id when the reader is unknown", () => {
    expect(viewerScopedLead({ id: "l1", owner_customer_id: "c1" }, null)).toEqual({
      id: "l1",
      owner_customer_id: null,
      lead_profile: null,
    });
  });

  it("passes a null lead straight through", () => {
    expect(viewerScopedLead(null, "c1")).toBeNull();
  });
});
