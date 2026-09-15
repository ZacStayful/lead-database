import { describe, it, expect } from "vitest";
import { isJunkName } from "@/lib/leadQuality";
import { planKeyFromPreferredPlan } from "@/lib/plans";
import {
  decideEnquiryItem,
  enquiryJunkReason,
  ITEM_SETTLE_MS,
  MAX_CHASE_AGE_MS,
  INCOMPLETE_ITEM_GRACE_MS,
  type EnquiryItemFields,
} from "../enquiryItem";

const NOW = new Date("2026-09-15T14:00:00Z");
const CUTOFF = new Date("2026-09-15T00:00:00Z");

function fields(over: Partial<EnquiryItemFields> = {}): EnquiryItemFields {
  return {
    name: "Niall Byrne",
    email: "niall@wyndale.uk",
    mobile: "+447932557572",
    websiteUrl: "https://Wyndale.uk",
    propertiesManaged: "40",
    preferredPlan: "£300/mo — 20 leads",
    currentLeadSource: "Word of mouth",
    ...over,
  };
}

function decide(over: Partial<Parameters<typeof decideEnquiryItem>[0]> = {}) {
  return decideEnquiryItem({
    fields: fields(),
    statusLabel: "New Enquiries",
    createdAt: new Date(NOW.getTime() - 5 * 60_000),
    cutoff: CUTOFF,
    now: NOW,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// The constants themselves.
//
// ⚠️ PINNED TO LITERALS, DUPLICATED ON PURPOSE. Every other test in this file
// derives its timings from these constants, so all of them move together if a
// value changes — a mutation run proved it: setting ITEM_SETTLE_MS to 0 left
// the whole suite green. §27.2 makes the same call for the API field list ("a
// test deriving it from the same source would pass whatever changed"), and
// §50.9 records three assertions in this repo already written weak enough to
// survive the mutation they existed to catch. These three lines are what stop
// a fourth.
//
// Changing a value here is fine — change it in both places deliberately, and
// re-read what the constant is protecting before you do.
// ---------------------------------------------------------------------------
describe("the constants are the protection, so they are pinned", () => {
  it("settles for a minute before reading an item", () => {
    expect(ITEM_SETTLE_MS).toBe(60_000);
  });

  it("chases nothing older than six hours", () => {
    expect(MAX_CHASE_AGE_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("waits a day for a missing email cell", () => {
    expect(INCOMPLETE_ITEM_GRACE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// The junk filter, against the four items actually on the board.
// ---------------------------------------------------------------------------
describe("enquiryJunkReason — the Meta test lead is the case that matters", () => {
  // The exact strings from item 13049622496, read off the live board.
  const META = fields({
    name: "test lead: dummy data for full_name",
    email: "test@meta.com",
    mobile: "test lead: dummy data for contact_number",
    websiteUrl: "test lead: dummy data for website_link",
    propertiesManaged:
      "test lead: dummy data for how_many_properties_do_you_currently_manage_?",
    preferredPlan: "test lead: dummy data for prefered_plan",
    currentLeadSource: "test lead: dummy data for how_do_you_currently_get_leads_?",
  });

  it("catches Meta's test lead", () => {
    expect(enquiryJunkReason(META)).toBe("meta_dummy");
  });

  /**
   * ⚠️ THE PAIR IS THE POINT, AND IT IS WHY RULE 1 EXISTS AT ALL.
   *
   * The obvious implementation is "reuse isJunkName" — and it does not work.
   * Verified by running the real function: the string has no digits, no "@",
   * plenty of letters, no repeated run, is not a placeholder word, and the
   * no-vowel rule is skipped because ":" and "_" put it outside basic Latin.
   * Without this assertion somebody deletes the meta rule as redundant.
   */
  it("which isJunkName does NOT — hence the dedicated rule", () => {
    expect(isJunkName("test lead: dummy data for full_name")).toBe(false);
  });

  it("catches a partially populated test lead, from any cell", () => {
    expect(
      enquiryJunkReason(fields({ preferredPlan: "test lead: dummy data for x" }))
    ).toBe("meta_dummy");
  });

  it("catches a test domain even without the phrase", () => {
    expect(enquiryJunkReason(fields({ email: "someone@example.com" }))).toBe(
      "test_email"
    );
  });

  it("catches an email pasted into the name field", () => {
    expect(enquiryJunkReason(fields({ name: "natalyanaq@gmail.com" }))).toBe(
      "junk_name"
    );
  });

  it("passes the three real people on the board", () => {
    expect(enquiryJunkReason(fields({ name: "Niall Byrne" }))).toBeNull();
    expect(
      enquiryJunkReason(
        fields({ name: "Chloe Webster", email: "airluxemanagementltd@gmail.com" })
      )
    ).toBeNull();
    expect(
      enquiryJunkReason(
        fields({
          name: "Natalie Joseph-Lowry",
          email: "info@theopulentpropertyproject.co.uk",
        })
      )
    ).toBeNull();
  });

  // §36.3: 87 of 437 live leads are a lone first name. A rule demanding a
  // surname would discard a fifth of the book.
  it("passes a lone first name, which is the norm", () => {
    expect(enquiryJunkReason(fields({ name: "Mani" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The cutoff — fails closed.
// ---------------------------------------------------------------------------
describe("decideEnquiryItem — the cutoff fails closed", () => {
  it("ingests nothing when the cutoff is unreadable", () => {
    expect(decide({ cutoff: null })).toMatchObject({
      action: "skip",
      skip: "no_cutoff",
    });
  });

  it("ingests nothing when the cutoff is an invalid date", () => {
    expect(decide({ cutoff: new Date("not a date") })).toMatchObject({
      action: "skip",
      skip: "no_cutoff",
    });
  });

  it("skips an item created before the cutoff", () => {
    expect(
      decide({ createdAt: new Date(CUTOFF.getTime() - 1000) })
    ).toMatchObject({ action: "skip", skip: "before_cutoff" });
  });

  it("skips an item with no creation time rather than guessing", () => {
    expect(decide({ createdAt: null })).toMatchObject({
      action: "skip",
      skip: "before_cutoff",
    });
  });

  it("ingests one created after it", () => {
    expect(decide().action).toBe("ingest");
  });
});

// ---------------------------------------------------------------------------
// The settle delay and the late-cell defer.
// ---------------------------------------------------------------------------
describe("decideEnquiryItem — settling", () => {
  it("defers an item younger than the settle delay", () => {
    expect(
      decide({ createdAt: new Date(NOW.getTime() - (ITEM_SETTLE_MS - 1000)) })
    ).toMatchObject({ action: "defer", defer: "settling" });
  });

  it("reads one a second past it", () => {
    expect(
      decide({ createdAt: new Date(NOW.getTime() - (ITEM_SETTLE_MS + 1000)) })
        .action
    ).toBe("ingest");
  });

  /**
   * ⚠️ The structural half. A defer claims nothing, so the cell arriving late
   * is still picked up — which a time delay alone cannot guarantee.
   */
  it("defers rather than claims when the email cell has not arrived", () => {
    expect(decide({ fields: fields({ email: "" }) })).toMatchObject({
      action: "defer",
      defer: "missing_email",
    });
  });

  /**
   * ⚠️ Needs an older cutoff, and that is the code being right rather than the
   * test being awkward: an item past the 24h grace is also older than a
   * recently-seeded cutoff, and `before_cutoff` is checked first. So in
   * practice `stale_incomplete` is only reachable once the cutoff has some age
   * on it — which is exactly the ordering we want, since forward-only outranks
   * every judgement about the item itself.
   */
  it("gives up on a genuinely empty item after the grace window", () => {
    expect(
      decide({
        fields: fields({ email: "" }),
        cutoff: new Date("2026-09-01T00:00:00Z"),
        createdAt: new Date(NOW.getTime() - (INCOMPLETE_ITEM_GRACE_MS + 1000)),
      })
    ).toMatchObject({ action: "skip", skip: "stale_incomplete" });
  });

  it("but forward-only still outranks it", () => {
    expect(
      decide({
        fields: fields({ email: "" }),
        createdAt: new Date(NOW.getTime() - (INCOMPLETE_ITEM_GRACE_MS + 1000)),
      })
    ).toMatchObject({ action: "skip", skip: "before_cutoff" });
  });

  it("skips a malformed email, which waiting cannot fix", () => {
    expect(decide({ fields: fields({ email: "not-an-email" }) })).toMatchObject({
      action: "skip",
      skip: "bad_email",
    });
  });
});

// ---------------------------------------------------------------------------
// The status gate.
// ---------------------------------------------------------------------------
describe("decideEnquiryItem — the status gate is the only source signal we have", () => {
  it("ingests New Enquiries, where Facebook and the website both land", () => {
    expect(decide({ statusLabel: "New Enquiries" }).action).toBe("ingest");
  });

  it("ingests a blank cell, which a brand-new item can carry", () => {
    expect(decide({ statusLabel: "" }).action).toBe("ingest");
  });

  it("skips every label someone set by hand", () => {
    for (const label of [
      "Web meeting booked",
      "Web meeting sat",
      "In the future",
      "Abandoned",
      "Management Customer",
      "Cancelled",
      // Written by the chase itself once a ladder starts.
      "Chasing to book",
      "Chased no booking",
    ]) {
      expect(decide({ statusLabel: label })).toMatchObject({
        action: "skip",
        skip: "not_new_status",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// ⚠️ The bound that makes forward-only safe.
// ---------------------------------------------------------------------------
describe("decideEnquiryItem — the chase is bounded, the ingest is not", () => {
  it("chases a fresh item", () => {
    expect(decide().chase).toBe(true);
  });

  it("still creates an old one, but never chases it", () => {
    const old = decide({
      createdAt: new Date(NOW.getTime() - (MAX_CHASE_AGE_MS + 60_000)),
    });
    // The lead is not lost...
    expect(old.action).toBe("ingest");
    // ...but nothing is sent to it.
    expect(old.chase).toBe(false);
  });

  it("chases right up to the bound", () => {
    expect(
      decide({ createdAt: new Date(NOW.getTime() - (MAX_CHASE_AGE_MS - 1000)) })
        .chase
    ).toBe(true);
  });

  it("never chases anything it skipped or deferred", () => {
    expect(decide({ cutoff: null }).chase).toBe(false);
    expect(decide({ statusLabel: "Abandoned" }).chase).toBe(false);
    expect(decide({ fields: fields({ email: "" }) }).chase).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The plan cell.
// ---------------------------------------------------------------------------
describe("planKeyFromPreferredPlan", () => {
  it("reads the two strings actually on the board, em dash and all", () => {
    expect(planKeyFromPreferredPlan("£150/mo — 10 leads")).toBe("lead_10");
    expect(planKeyFromPreferredPlan("£300/mo — 20 leads")).toBe("lead_20");
  });

  it("does not care which dash, because the count is the fact", () => {
    expect(planKeyFromPreferredPlan("£150/mo – 10 leads")).toBe("lead_10");
    expect(planKeyFromPreferredPlan("£150/mo - 10 leads")).toBe("lead_10");
    expect(planKeyFromPreferredPlan("10 leads")).toBe("lead_10");
    expect(planKeyFromPreferredPlan("20 Leads a month")).toBe("lead_20");
  });

  it("survives a non-breaking space", () => {
    expect(planKeyFromPreferredPlan("£150/mo — 10 leads")).toBe(
      "lead_10"
    );
  });

  it("falls back to the price when the count is absent", () => {
    expect(planKeyFromPreferredPlan("£150 per month")).toBe("lead_10");
    expect(planKeyFromPreferredPlan("£300 per month")).toBe("lead_20");
  });

  // The same answer the website gives a form that posts no plan at all.
  it("falls back to the default on anything it cannot read", () => {
    expect(planKeyFromPreferredPlan("")).toBe("lead_20");
    expect(planKeyFromPreferredPlan(null)).toBe("lead_20");
    expect(planKeyFromPreferredPlan("test lead: dummy data for prefered_plan")).toBe(
      "lead_20"
    );
  });
});
