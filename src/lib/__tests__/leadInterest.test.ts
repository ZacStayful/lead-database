import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEAD_INTEREST, toLeadInterest } from "../monday";
import {
  mondayLeadInterestFor,
  mondayStatusLabelFor,
  type MondayStatusCandidate,
} from "../mondayStatus";

/**
 * "What kind of leads" — the value written to Monday's text_mm6c5qba (§46).
 *
 * Two things are being pinned, and the second is the one that matters. The
 * vocabulary has to agree with the CHECK constraint, because a drift there is
 * silent: the cell is still written, the CACHE update fails, and the cell is
 * rewritten on every subsequent event for ever. And "holds neither product" has
 * to stay NULL, because null is what the sync reads as "leave the cell alone" —
 * the only thing preserving a prospect's stated interest and a leaver's history.
 */

function customer(over: Partial<MondayStatusCandidate> = {}): MondayStatusCandidate {
  return {
    is_active: true,
    paused_at: null,
    account_status: "waitlisted",
    subscription_status: "inactive",
    gr_subscription_status: "inactive",
    cancel_at_period_end: false,
    gr_cancel_at_period_end: false,
    ...over,
  };
}

const MANAGEMENT: Partial<MondayStatusCandidate> = {
  account_status: "active",
  subscription_status: "active",
};

const GR: Partial<MondayStatusCandidate> = {
  gr_subscription_status: "active",
};

describe("toLeadInterest", () => {
  it("takes the hyphenated marketing spelling every ?product= link uses", () => {
    expect(toLeadInterest("guaranteed-rent")).toBe(LEAD_INTEREST.guaranteed_rent);
  });

  it("takes the underscored spelling the rest of the codebase uses", () => {
    expect(toLeadInterest("guaranteed_rent")).toBe(LEAD_INTEREST.guaranteed_rent);
  });

  it("round-trips its own labels, so a value read off the board survives", () => {
    for (const label of Object.values(LEAD_INTEREST)) {
      expect(toLeadInterest(label)).toBe(label);
    }
  });

  it("takes management and both", () => {
    expect(toLeadInterest("management")).toBe(LEAD_INTEREST.management);
    expect(toLeadInterest("both")).toBe(LEAD_INTEREST.both);
  });

  it("is case- and whitespace-tolerant", () => {
    expect(toLeadInterest("  Guaranteed-Rent ")).toBe(
      LEAD_INTEREST.guaranteed_rent
    );
  });

  it("returns null for anything else rather than guessing a product", () => {
    for (const bad of ["", "  ", "gr", "rent", "management leads", null, undefined, 7, {}]) {
      expect(toLeadInterest(bad)).toBeNull();
    }
  });
});

describe("the CHECK constraint and LEAD_INTEREST agree", () => {
  // Mechanically, the cancelOptions.ts precedent (§29) — a review reading both
  // and nodding is exactly what this replaces. Monday's column is free text and
  // validates nothing, so this constraint is the only enforcement anywhere.
  it("lists the same three values as the constant", () => {
    const sql = readFileSync(
      join(__dirname, "../../../supabase/migrations/0134_monday_lead_interest.sql"),
      "utf8"
    );
    const inClause = sql.match(
      /monday_lead_interest in \(([^)]*)\)/
    );
    expect(inClause).not.toBeNull();
    const fromSql = inClause![1]
      .split(",")
      .map((part) => part.trim().replace(/^'|'$/g, ""))
      .sort();
    expect(fromSql).toEqual([...Object.values(LEAD_INTEREST)].sort());
  });
});

describe("mondayLeadInterestFor", () => {
  it("says Management for a management subscriber", () => {
    expect(mondayLeadInterestFor(customer(MANAGEMENT))).toBe(
      LEAD_INTEREST.management
    );
  });

  it("says Guaranteed rent for a GR-only subscriber", () => {
    // The live shape: a GR-only customer sits at account_status 'waitlisted'
    // for ever (§18A), so anything reading the management columns would miss
    // them entirely.
    expect(mondayLeadInterestFor(customer(GR))).toBe(
      LEAD_INTEREST.guaranteed_rent
    );
  });

  it("says Both when they hold both — the transition the cache exists for", () => {
    expect(mondayLeadInterestFor(customer({ ...MANAGEMENT, ...GR }))).toBe(
      LEAD_INTEREST.both
    );
  });

  it("counts past_due as held on each side — a card problem is not a departure", () => {
    expect(
      mondayLeadInterestFor(
        customer({ account_status: "active", subscription_status: "past_due" })
      )
    ).toBe(LEAD_INTEREST.management);
    expect(
      mondayLeadInterestFor(customer({ gr_subscription_status: "past_due" }))
    ).toBe(LEAD_INTEREST.guaranteed_rent);
  });

  it("still says Management while a cancellation is only pending", () => {
    // They are still paying and still owed leads until the period ends.
    expect(
      mondayLeadInterestFor(
        customer({ ...MANAGEMENT, cancel_at_period_end: true })
      )
    ).toBe(LEAD_INTEREST.management);
  });

  it("still says Management for a paused customer", () => {
    expect(
      mondayLeadInterestFor(customer({ ...MANAGEMENT, paused_at: "2026-08-01" }))
    ).toBe(LEAD_INTEREST.management);
  });

  it("narrows to the surviving product when one is cancelled", () => {
    expect(
      mondayLeadInterestFor(
        customer({
          ...GR,
          account_status: "cancelled",
          subscription_status: "canceled",
        })
      )
    ).toBe(LEAD_INTEREST.guaranteed_rent);
  });

  // ---- the rule that stops the column being blanked -----------------------

  it("returns NULL, not a blank, for a prospect who holds nothing", () => {
    // Null means "leave the cell alone". Returning "" here would erase the
    // service they picked on the enquiry form on their next Stripe event.
    const verdict = mondayLeadInterestFor(customer());
    expect(verdict).toBeNull();
    expect(verdict).not.toBe("");
  });

  it("returns NULL for a customer who has left, keeping what they held", () => {
    expect(
      mondayLeadInterestFor(
        customer({
          account_status: "cancelled",
          subscription_status: "canceled",
        })
      )
    ).toBeNull();
  });

  it("returns NULL for an archived row (§18D), whatever it holds", () => {
    expect(
      mondayLeadInterestFor(customer({ ...MANAGEMENT, ...GR, is_active: false }))
    ).toBeNull();
  });
});

describe("the two rules cannot disagree about who to leave alone", () => {
  // syncCustomerMondayStatus returns early when the label is null, so an
  // interest that were non-null there would never be written and the bug would
  // be invisible. Asserted rather than reasoned about.
  const matrix: MondayStatusCandidate[] = [
    customer(),
    customer(MANAGEMENT),
    customer(GR),
    customer({ ...MANAGEMENT, ...GR }),
    customer({ ...MANAGEMENT, is_active: false }),
    customer({ account_status: "active", subscription_status: "past_due" }),
    customer({ gr_subscription_status: "past_due" }),
    customer({ ...MANAGEMENT, paused_at: "2026-08-01" }),
    customer({ ...MANAGEMENT, cancel_at_period_end: true }),
    customer({ ...GR, gr_cancel_at_period_end: true }),
    customer({ account_status: "cancelled", subscription_status: "canceled" }),
    customer({ gr_subscription_status: "canceled" }),
    customer({ account_status: "invited", subscription_status: "inactive" }),
  ];

  it("never has an interest to write where there is no label to write", () => {
    for (const c of matrix) {
      if (mondayStatusLabelFor(c) === null) {
        expect(mondayLeadInterestFor(c)).toBeNull();
      }
    }
  });
});
