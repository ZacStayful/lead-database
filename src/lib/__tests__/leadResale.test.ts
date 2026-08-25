import { describe, expect, it } from "vitest";
import {
  isCustomerOwnedLead,
  isResellable,
  shouldRaiseContentionCap,
  shouldRouteLead,
  type ResaleLeadFields,
} from "../leadResale";
import { CONTENDED_FILTERED_CUSTOMERS } from "../types";

const MARKETPLACE: ResaleLeadFields = {
  owner_customer_id: null,
  owner_resale_qualified_at: null,
};
const UNQUALIFIED: ResaleLeadFields = {
  owner_customer_id: "c1",
  owner_resale_qualified_at: null,
};
const QUALIFIED: ResaleLeadFields = {
  owner_customer_id: "c1",
  owner_resale_qualified_at: "2026-08-25T10:00:00Z",
};

describe("isCustomerOwnedLead", () => {
  it("separates a customer's own lead from ours", () => {
    expect(isCustomerOwnedLead(MARKETPLACE)).toBe(false);
    expect(isCustomerOwnedLead(UNQUALIFIED)).toBe(true);
    expect(isCustomerOwnedLead(QUALIFIED)).toBe(true);
  });

  it("treats a missing field as not owned", () => {
    expect(isCustomerOwnedLead({})).toBe(false);
  });
});

describe("isResellable", () => {
  it("is always true for a marketplace lead", () => {
    expect(isResellable(MARKETPLACE)).toBe(true);
    expect(isResellable({})).toBe(true);
  });

  it("is false for an owned lead that has not been analysed", () => {
    expect(isResellable(UNQUALIFIED)).toBe(false);
  });

  it("is true only once the owned lead has qualified", () => {
    expect(isResellable(QUALIFIED)).toBe(true);
  });
});

describe("shouldRouteLead", () => {
  it("lets autoAssignLead skip an owned lead until it qualifies", () => {
    expect(shouldRouteLead(MARKETPLACE)).toBe(true);
    expect(shouldRouteLead(UNQUALIFIED)).toBe(false);
    expect(shouldRouteLead(QUALIFIED)).toBe(true);
  });
});

describe("shouldRaiseContentionCap", () => {
  it("still raises the cap on a contended marketplace lead", () => {
    // The 0097 behaviour, unchanged. If this ever goes false, contended
    // marketplace leads silently stop opening their fourth slot.
    expect(
      shouldRaiseContentionCap(
        MARKETPLACE,
        CONTENDED_FILTERED_CUSTOMERS,
        CONTENDED_FILTERED_CUSTOMERS
      )
    ).toBe(true);
  });

  it("does not raise it below the threshold", () => {
    expect(
      shouldRaiseContentionCap(
        MARKETPLACE,
        CONTENDED_FILTERED_CUSTOMERS - 1,
        CONTENDED_FILTERED_CUSTOMERS
      )
    ).toBe(false);
  });

  it("NEVER raises it on a customer's own lead, qualified or not", () => {
    // THE cap-breach test. This update goes straight through PostgREST, so it
    // bypasses the row lock and every guard 0107 added — it is the one path
    // that could take an owned lead past its uploader plus one. And the
    // query's own `.lt("max_assignments", 4)` predicate is no protection: a
    // qualified owned lead sits at 2, which satisfies it.
    for (const lead of [UNQUALIFIED, QUALIFIED]) {
      expect(
        shouldRaiseContentionCap(lead, 99, CONTENDED_FILTERED_CUSTOMERS)
      ).toBe(false);
    }
  });
});
