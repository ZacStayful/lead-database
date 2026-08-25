import { describe, it, expect } from "vitest";
import { hasAnyContactDetail, leadSourceLabel, toRpcRow } from "../customerLeads";

describe("toRpcRow", () => {
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

  it("trims and stringifies everything, keeping phone text intact", () => {
    const row = toRpcRow({ name: "  Jane  ", phone: " 07700 900123 ", bedrooms: " 3 " });
    expect(row.name).toBe("Jane");
    // A leading zero survives because nothing here is ever coerced to a number.
    expect(row.phone).toBe("07700 900123");
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
  it("names an owned lead as the customer's own", () => {
    expect(leadSourceLabel({ lead: { owner_customer_id: "c1" } })).toBe("Added by you");
    expect(leadSourceLabel({ claimed_from_pool_at: "2026-01-01", lead: null })).toBe(
      "Claimed from expired leads"
    );
    expect(leadSourceLabel({ lead: null })).toBe("Allocated");
  });
});
