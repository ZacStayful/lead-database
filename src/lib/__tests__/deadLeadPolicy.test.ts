import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAIM_WINDOW_DAYS,
  DEAD_LEAD_REASONS,
  MIN_DETAIL_LENGTH,
  claimBudget,
  committedAllocation,
  decideDeadLeadClaim,
  earnedBonus,
  type ClaimCustomer,
  type DeadLeadClaimInputs,
} from "../quality/deadLeadPolicy";

/** A management subscriber on the £300/20 plan, no claims yet, no streak. */
const customer: ClaimCustomer = {
  account_status: "active",
  subscription_status: "active",
  gr_subscription_status: "inactive",
  monthly_allocation: 20,
  gr_monthly_allocation: 10,
  quality_allowance_pct: 0.1,
  quality_claims_this_cycle: 0,
  clean_leads_streak: 0,
  quality_review_required: false,
};

const input: DeadLeadClaimInputs = {
  customer,
  peers: [],
  reason: "already_with_operator",
  detail: "Said they signed with another agent a fortnight ago.",
  contactedOn: "2026-09-08",
};

describe("committedAllocation", () => {
  it("counts only the products the customer actually holds", () => {
    // gr_monthly_allocation defaults to 10 on every row (§17's trap), so a
    // management-only customer would otherwise be sized as if they held both.
    expect(committedAllocation(customer)).toBe(20);
  });

  it("counts a GR-only subscriber's GR allocation despite waitlisted status", () => {
    // Invariant 6 / §18A: a GR-only customer sits at account_status
    // 'waitlisted' for ever, and reading that column would give them nothing.
    expect(
      committedAllocation({
        ...customer,
        account_status: "waitlisted",
        subscription_status: "inactive",
        gr_subscription_status: "active",
      })
    ).toBe(10);
  });

  it("sums both products for a customer holding both", () => {
    expect(
      committedAllocation({ ...customer, gr_subscription_status: "active" })
    ).toBe(30);
  });

  it("gives a customer holding neither product nothing", () => {
    expect(
      committedAllocation({
        ...customer,
        account_status: "cancelled",
        subscription_status: "inactive",
        gr_subscription_status: "inactive",
      })
    ).toBe(0);
  });
});

describe("claimBudget", () => {
  it("is a tenth of the plan", () => {
    expect(claimBudget(customer)).toBe(2);
  });

  it("rounds a ten-lead plan up to one rather than to nothing", () => {
    // A £150/10 customer must be able to report a dead lead without a person
    // reading every one of them.
    expect(claimBudget({ ...customer, monthly_allocation: 10 })).toBe(1);
  });

  it("adds earned headroom for leads taken without claiming", () => {
    expect(earnedBonus({ ...customer, clean_leads_streak: 9 })).toBe(0);
    expect(earnedBonus({ ...customer, clean_leads_streak: 10 })).toBe(1);
    expect(claimBudget({ ...customer, clean_leads_streak: 25 })).toBe(4);
  });

  it("caps the earned half, so a long clean run cannot bank a year of claims", () => {
    expect(earnedBonus({ ...customer, clean_leads_streak: 500 })).toBe(2);
    expect(claimBudget({ ...customer, clean_leads_streak: 500 })).toBe(4);
  });

  it("treats a missing or nonsense percentage as no base budget", () => {
    expect(claimBudget({ ...customer, quality_allowance_pct: 0 })).toBe(0);
    expect(
      claimBudget({ ...customer, quality_allowance_pct: Number.NaN })
    ).toBe(0);
  });
});

describe("decideDeadLeadClaim — the submission itself", () => {
  it("refuses an unknown reason", () => {
    const v = decideDeadLeadClaim({ ...input, reason: "leads_are_rubbish" });
    expect(v.decision).toBe("ineligible");
    expect(v.code).toBe("reason_required");
  });

  it("accepts each of the three real reasons", () => {
    for (const reason of DEAD_LEAD_REASONS) {
      expect(decideDeadLeadClaim({ ...input, reason }).decision).toBe(
        "auto_uphold"
      );
    }
  });

  it("refuses a detail too short to trace the lead back", () => {
    const v = decideDeadLeadClaim({ ...input, detail: "gone" });
    expect(v.decision).toBe("ineligible");
    expect(v.code).toBe("detail_too_short");
  });

  it("counts the trimmed length, so whitespace cannot pad it out", () => {
    const padded = `${" ".repeat(40)}gone${" ".repeat(40)}`;
    expect(decideDeadLeadClaim({ ...input, detail: padded }).code).toBe(
      "detail_too_short"
    );
    expect("gone".length).toBeLessThan(MIN_DETAIL_LENGTH);
  });

  it("refuses a missing or malformed contact date", () => {
    expect(decideDeadLeadClaim({ ...input, contactedOn: null }).code).toBe(
      "contacted_on_required"
    );
    expect(
      decideDeadLeadClaim({ ...input, contactedOn: "last Tuesday" }).code
    ).toBe("contacted_on_required");
  });

  it("writes nothing on an ineligible claim", () => {
    // consumesAllowance false is what stops a malformed submit costing the
    // customer one of the claims they cannot see.
    const v = decideDeadLeadClaim({ ...input, detail: "" });
    expect(v.consumesAllowance).toBe(false);
    expect(v.corroboration).toBe("none");
  });
});

describe("decideDeadLeadClaim — the peers", () => {
  it("sends a claim to review when another operator has the lead live", () => {
    const v = decideDeadLeadClaim({
      ...input,
      peers: [{ status: "in_discussion", pipeline_stage: "viewing_booked" }],
    });
    expect(v.decision).toBe("review");
    expect(v.corroboration).toBe("peer_contradicts");
  });

  it("reads a stage past cold as live even when the status has not moved", () => {
    const v = decideDeadLeadClaim({
      ...input,
      peers: [{ status: "contacted", pipeline_stage: "meeting_booked" }],
    });
    expect(v.corroboration).toBe("peer_contradicts");
  });

  it("does not read a cold peer as live", () => {
    const v = decideDeadLeadClaim({
      ...input,
      peers: [{ status: "contacted", pipeline_stage: "cold" }],
    });
    expect(v.decision).toBe("auto_uphold");
    expect(v.corroboration).toBe("none");
  });

  it("upholds free when a peer's own claim was already settled", () => {
    const v = decideDeadLeadClaim({
      ...input,
      peers: [{ status: "contacted", claim_status: "upheld" }],
    });
    expect(v.decision).toBe("auto_uphold");
    expect(v.consumesAllowance).toBe(false);
    expect(v.corroboration).toBe("peer_agrees");
  });

  it("treats an auto-upheld peer claim as corroboration too", () => {
    const v = decideDeadLeadClaim({
      ...input,
      peers: [{ claim_status: "auto_upheld" }],
    });
    expect(v.consumesAllowance).toBe(false);
  });

  it("does NOT corroborate from a peer claim nobody has adjudicated", () => {
    // Two customers holding one lead must not be able to agree their way to
    // unlimited free credits without a person seeing either claim.
    const v = decideDeadLeadClaim({
      ...input,
      peers: [{ claim_status: "under_review" }],
    });
    expect(v.corroboration).toBe("none");
    expect(v.consumesAllowance).toBe(true);
  });

  it("does not corroborate from a declined peer claim", () => {
    const v = decideDeadLeadClaim({
      ...input,
      peers: [{ claim_status: "declined" }],
    });
    expect(v.corroboration).toBe("none");
  });

  it("lets contradiction beat corroboration", () => {
    const v = decideDeadLeadClaim({
      ...input,
      peers: [
        { claim_status: "upheld" },
        { status: "won", pipeline_stage: "won" },
      ],
    });
    expect(v.decision).toBe("review");
    expect(v.corroboration).toBe("peer_contradicts");
  });

  it("corroborates even when the budget is spent", () => {
    const v = decideDeadLeadClaim({
      ...input,
      customer: { ...customer, quality_claims_this_cycle: 99 },
      peers: [{ claim_status: "upheld" }],
    });
    expect(v.decision).toBe("auto_uphold");
    expect(v.consumesAllowance).toBe(false);
  });
});

describe("decideDeadLeadClaim — the hidden budget", () => {
  it("upholds inside the budget and spends one", () => {
    const v = decideDeadLeadClaim(input);
    expect(v.decision).toBe("auto_uphold");
    expect(v.consumesAllowance).toBe(true);
  });

  it("sends the claim past the budget to review rather than refusing it", () => {
    // An operator receiving genuinely dead leads is exactly who exceeds the
    // budget. Refusing them automatically would punish the customer this
    // feature exists for.
    const v = decideDeadLeadClaim({
      ...input,
      customer: { ...customer, quality_claims_this_cycle: 2 },
    });
    expect(v.decision).toBe("review");
    expect(v.consumesAllowance).toBe(false);
  });

  it("lets a clean streak buy headroom past the base budget", () => {
    const v = decideDeadLeadClaim({
      ...input,
      customer: {
        ...customer,
        quality_claims_this_cycle: 2,
        clean_leads_streak: 30,
      },
    });
    expect(v.decision).toBe("auto_uphold");
  });

  it("sends every claim to review while admin has the customer flagged", () => {
    const v = decideDeadLeadClaim({
      ...input,
      customer: { ...customer, quality_review_required: true },
    });
    expect(v.decision).toBe("review");
    expect(v.consumesAllowance).toBe(false);
  });

  it("puts the admin flag ahead of corroboration", () => {
    const v = decideDeadLeadClaim({
      ...input,
      customer: { ...customer, quality_review_required: true },
      peers: [{ claim_status: "upheld" }],
    });
    expect(v.decision).toBe("review");
  });
});

describe("the allowance stays unpublished", () => {
  /**
   * ⚠️ The mechanism only works while the number is discovered rather than
   * announced: an operator told they have two claims a month has been handed
   * the exact number of leads it is safe to write off without evidence. This
   * asserts it mechanically rather than trusting review.
   */
  const banned = ["allowance", "quota", "budget", "limit", "remaining"];

  const verdicts = [
    decideDeadLeadClaim(input),
    decideDeadLeadClaim({ ...input, detail: "no" }),
    decideDeadLeadClaim({ ...input, reason: "nonsense" }),
    decideDeadLeadClaim({ ...input, contactedOn: null }),
    decideDeadLeadClaim({
      ...input,
      customer: { ...customer, quality_claims_this_cycle: 99 },
    }),
    decideDeadLeadClaim({
      ...input,
      customer: { ...customer, quality_review_required: true },
    }),
    decideDeadLeadClaim({ ...input, peers: [{ claim_status: "upheld" }] }),
    decideDeadLeadClaim({ ...input, peers: [{ status: "won" }] }),
  ];

  it("never names it in any message", () => {
    for (const v of verdicts) {
      const message = v.message.toLowerCase();
      for (const word of banned) {
        expect(message).not.toContain(word);
      }
    }
  });

  it("never names it in any code", () => {
    for (const v of verdicts) {
      for (const word of banned) {
        expect(v.code).not.toContain(word);
      }
    }
  });

  it("says nothing different to a customer over the budget than one under it", () => {
    // Two operators comparing notes must not be able to infer the number from
    // the wording they each got.
    const overBudget = decideDeadLeadClaim({
      ...input,
      customer: { ...customer, quality_claims_this_cycle: 99 },
    });
    const flagged = decideDeadLeadClaim({
      ...input,
      customer: { ...customer, quality_review_required: true },
    });
    expect(overBudget.message).toBe(flagged.message);
  });
});

describe("the claim window", () => {
  it("is the one number this module and the SQL share", () => {
    // Passed into claimable_dead_lead_assignments rather than left to that
    // function's own default, so the two cannot disagree.
    expect(CLAIM_WINDOW_DAYS).toBe(14);
  });
});

describe("the claim form's imports stay out of the server's half", () => {
  /**
   * ⚠️ Anchored on the REAL FILES rather than on a restatement of them. §42.8
   * records what the alternative cost: a safety boundary the pull request
   * asserted in words, that a test checked by writing its own copy of the
   * query, and that did not exist — 91 follow-up runs destroyed within six
   * minutes of deploy.
   *
   * `deadLeadPolicy.ts` reaches `plans.ts` through `products.ts` for the
   * allowance arithmetic. `DeadLeadClaimCard` is a "use client" component, so
   * importing it there would put the plan tables and their env lookups into a
   * browser bundle — the trap §21.8 states for `featureRequest.ts`.
   */
  const read = (p: string) =>
    readFileSync(resolve(__dirname, "..", "..", p), "utf8");

  it("the copy module imports nothing at all", () => {
    const src = read("lib/quality/deadLeadCopy.ts");
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it("the claim form takes its copy from there, not from the policy", () => {
    const src = read("components/dashboard/DeadLeadClaimCard.tsx");
    expect(src).toContain('"@/lib/quality/deadLeadCopy"');
    expect(src).not.toContain('"@/lib/quality/deadLeadPolicy"');
  });

  it("and the policy still re-exports it, so there is one definition", () => {
    const src = read("lib/quality/deadLeadPolicy.ts");
    expect(src).toContain('export {');
    expect(src).toContain('from "@/lib/quality/deadLeadCopy"');
  });
});
