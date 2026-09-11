import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOSE_REASONS } from "@/lib/closeReasons";
import { FIT_REASONS } from "@/lib/outcomeReasons";
import {
  CLAIM_WINDOW_DAYS,
  DEAD_LEAD_CONFIRM_CONSEQUENCE,
  DEAD_LEAD_PROMPT_BODY,
  DEAD_LEAD_PROMPT_HEADING,
  DEAD_LEAD_PROMPT_MIN_OPENS,
  DEAD_LEAD_PROMPT_PRIOR_OPENS,
  DEAD_LEAD_REASONS,
  DEAD_LEAD_REASON_LABELS,
  REASON_WINDOW_DAYS,
  REASON_DETAIL_PROMPT,
  windowDaysForReason,
  reasonAvailability,
  anyReasonAvailable,
  unavailableSummary,
  MIN_DETAIL_LENGTH,
  claimBudget,
  committedAllocation,
  decideDeadLeadClaim,
  earnedBonus,
  normaliseAllowancePct,
  shouldPromptDeadLead,
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
      }),
    ).toBe(10);
  });

  it("sums both products for a customer holding both", () => {
    expect(
      committedAllocation({ ...customer, gr_subscription_status: "active" }),
    ).toBe(30);
  });

  it("gives a customer holding neither product nothing", () => {
    expect(
      committedAllocation({
        ...customer,
        account_status: "cancelled",
        subscription_status: "inactive",
        gr_subscription_status: "inactive",
      }),
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
      claimBudget({ ...customer, quality_allowance_pct: Number.NaN }),
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
        "auto_uphold",
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
      "detail_too_short",
    );
    expect("gone".length).toBeLessThan(MIN_DETAIL_LENGTH);
  });

  it("refuses a missing or malformed contact date", () => {
    expect(decideDeadLeadClaim({ ...input, contactedOn: null }).code).toBe(
      "contacted_on_required",
    );
    expect(
      decideDeadLeadClaim({ ...input, contactedOn: "last Tuesday" }).code,
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
    expect(src).toContain("export {");
    expect(src).toContain('from "@/lib/quality/deadLeadCopy"');
  });
});

describe("the prompt at the top of a lead (§51.10)", () => {
  const ok = {
    claimable: true,
    claimStatus: null as string | null,
    priorOpens: 2,
    hasContactEvent: true,
  };

  it("fires on the third open, not the second", () => {
    expect(shouldPromptDeadLead({ ...ok, priorOpens: 1 })).toBe(false);
    expect(shouldPromptDeadLead({ ...ok, priorOpens: 2 })).toBe(true);
  });

  it("keeps the off-by-one tied to its cause", () => {
    /**
     * ⚠️ Asserting only the boundary above would survive somebody "fixing" the
     * threshold to 3 and the constant to 4 together — which silently costs
     * every operator a visit. LeadDetail records detail_opened in a mount
     * effect, AFTER the server component resolved, so on the Nth visit the
     * server sees N-1 rows.
     */
    expect(DEAD_LEAD_PROMPT_MIN_OPENS).toBe(3);
    expect(DEAD_LEAD_PROMPT_PRIOR_OPENS).toBe(DEAD_LEAD_PROMPT_MIN_OPENS - 1);
  });

  it("⚠️ requires an actual contact attempt, however many opens there are", () => {
    /**
     * The form asks "In their words" and "When did you speak to them?". An
     * operator with opens and no phone, WhatsApp or email click never rang, so
     * prompting them is asking them to invent a conversation — and invented
     * reasons poison the dataset the whole change exists to build. Of 126
     * assignments eligible to report on production, only 30 had any contact
     * event at all.
     */
    expect(shouldPromptDeadLead({ ...ok, hasContactEvent: false })).toBe(false);
    expect(
      shouldPromptDeadLead({ ...ok, priorOpens: 99, hasContactEvent: false }),
    ).toBe(false);
  });

  it("never offers what the route would refuse", () => {
    expect(shouldPromptDeadLead({ ...ok, claimable: false })).toBe(false);
  });

  it("never re-offers a claim that has already been made", () => {
    for (const status of [
      "under_review",
      "upheld",
      "auto_upheld",
      "declined",
    ]) {
      expect(shouldPromptDeadLead({ ...ok, claimStatus: status })).toBe(false);
    }
  });
});

describe("⚠️ the credit is named in one place and not the other", () => {
  /**
   * The split that keeps this honest, and it must be maintained:
   *
   * - The PROMPT is unsolicited — we raised it. Leading with a credit turns
   *   discovery into an inducement to fish, which is what §51.3's hidden
   *   allowance exists to prevent.
   * - The CONFIRMATION comes after the operator chose to report and wrote what
   *   the landlord said. Stating the outcome there is informed consent.
   */
  it("the prompt asks what happened and offers nothing", () => {
    for (const copy of [DEAD_LEAD_PROMPT_HEADING, DEAD_LEAD_PROMPT_BODY]) {
      expect(copy).not.toMatch(
        /credit|refund|free|money|£|back on your account/i,
      );
    }
  });

  it("the confirmation says plainly what happens if it stands up", () => {
    expect(DEAD_LEAD_CONFIRM_CONSEQUENCE).toMatch(/credit/i);
  });

  /**
   * ⚠️ THIS ASSERTION WAS REVERSED BY 0139, DELIBERATELY.
   *
   * It used to forbid the words outright — "and promises no replacement,
   * because neither refund route sends one" — on §39.1 and §51.5, which were
   * true when written: `resolution` had no such value, so the database could
   * not record having sent one. A swap is now a real outcome, and copy that
   * mentioned only the credit would be the same kind of untruth §51.11 had to
   * strip out of the published policy pages.
   *
   * What must not come back is a PROMISE. "We'll send you a replacement" turns
   * every report into a request for a better lead — the fishing §51.3's hidden
   * allowance exists to prevent — and management stock cannot absorb it: about
   * 70 leads carry a free slot and each swap consumes two of them.
   *
   * So the rule is now: name both, commit to neither.
   */
  it("names both outcomes, so it is not a half-truth about what can happen", () => {
    expect(DEAD_LEAD_CONFIRM_CONSEQUENCE).toMatch(/either/i);
    expect(DEAD_LEAD_CONFIRM_CONSEQUENCE).toMatch(/credit/i);
    expect(DEAD_LEAD_CONFIRM_CONSEQUENCE).toMatch(/different lead|replacement/i);
  });

  it("and commits to neither, so a report is never a request for a better lead", () => {
    expect(DEAD_LEAD_CONFIRM_CONSEQUENCE).not.toMatch(
      /we'?ll send you a replacement|you'?ll get a replacement|guaranteed|we will replace/i,
    );
  });

  it("never names the trigger, which would be the recipe for summoning it", () => {
    for (const copy of [DEAD_LEAD_PROMPT_HEADING, DEAD_LEAD_PROMPT_BODY]) {
      expect(copy).not.toMatch(/three|3 times|few times|opened|visit/i);
    }
  });
});

describe("the allowance stays unpublished in the COPY too", () => {
  /**
   * The block above this one asserts it over `decideDeadLeadClaim`'s verdicts —
   * server-side messages only. Every customer-facing string was unguarded until
   * §51.10, and the prompt added more of them.
   */
  const banned = ["allowance", "quota", "budget", "limit", "remaining"];
  const surfaces = [
    "lib/quality/deadLeadCopy.ts",
    "lib/leadOutcomes.ts",
    "lib/outcomeReasons.ts",
    "components/dashboard/DeadLeadClaimCard.tsx",
    "components/dashboard/LeadOutcomePanel.tsx",
  ];

  for (const file of surfaces) {
    it(`${file} names none of it`, () => {
      /**
       * ⚠️ Comments are stripped first. Every one of these files explains why
       * the allowance must stay unpublished, and explaining it means naming it
       * — so a naive substring check fails on the explanation and trains the
       * next person to delete the explanation. §46 hit exactly this trap.
       */
      const src = readFileSync(resolve(__dirname, "..", "..", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .toLowerCase();
      for (const word of banned) expect(src).not.toContain(word);
    });
  }
});

describe("the allowance is settable per customer without being floored", () => {
  /**
   * ⚠️ THE ONE DEFECT IN THIS FEATURE THAT WOULD BE SILENT IN PRODUCTION.
   *
   * Every other number on the admin allocation form is a whole count, and the
   * route puts each through `Math.max(0, Math.floor(x))`. This is a FRACTION.
   * Copying the field above it turns the default 0.10 into 0, which zeroes the
   * base budget of whoever was saved — with no error, no visible change on the
   * form, and no symptom until a genuine claim quietly goes to review instead
   * of being upheld.
   */
  it("keeps a raised allowance exactly as typed", () => {
    expect(normaliseAllowancePct(0.15)).toBe(0.15);
    expect(normaliseAllowancePct(0.1)).toBe(0.1);
    expect(normaliseAllowancePct(0.05)).toBe(0.05);
  });

  it("clamps to the 0..1 a share of an allocation can mean", () => {
    expect(normaliseAllowancePct(-1)).toBe(0);
    expect(normaliseAllowancePct(2)).toBe(1);
    expect(normaliseAllowancePct(0)).toBe(0);
    expect(normaliseAllowancePct(1)).toBe(1);
  });

  it("returns null for anything that is not a finite number", () => {
    // null means "leave the column alone", never "write a guess". An empty
    // number input submits NaN, which passes a bare typeof check.
    expect(normaliseAllowancePct(Number.NaN)).toBeNull();
    expect(normaliseAllowancePct(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normaliseAllowancePct("0.15")).toBeNull();
    expect(normaliseAllowancePct(undefined)).toBeNull();
    expect(normaliseAllowancePct(null)).toBeNull();
  });

  it("raising it to 0.15 buys one more claim on each plan", () => {
    // The worked example the admin form's caption states. Asserted here so the
    // caption cannot drift away from the arithmetic behind it.
    const at = (pct: number, allocation: number) =>
      claimBudget({ ...customer, quality_allowance_pct: pct, monthly_allocation: allocation });
    expect(at(0.1, 10)).toBe(1);
    expect(at(0.15, 10)).toBe(2);
    expect(at(0.1, 20)).toBe(2);
    expect(at(0.15, 20)).toBe(3);
  });

  it("the route uses the helper and never floors the fraction", () => {
    // Anchored on the real route file (§42.8). A `Math.floor` reintroduced on
    // this field is a one-token change no behavioural test here could catch,
    // because observing it needs a live Supabase write.
    const src = readFileSync(
      resolve(__dirname, "..", "..", "app/api/admin/customers/[id]/allocation/route.ts"),
      "utf8",
    ).replace(/\/\/[^\n]*/g, ""); // strip comments: they explain the ban by naming it
    expect(src).toContain("normaliseAllowancePct(body.quality_allowance_pct)");
    expect(src).not.toMatch(/Math\.floor\([^)]*quality_allowance_pct/);
  });
});

/**
 * The per-reason windows (0139, §51).
 *
 * The 7 is the whole rule for the competitor reason and the reason it was not
 * duplicated: a landlord who appointed someone else inside the first week means
 * the operator never really got to pitch, and after that they had their chance
 * and lost — a lost deal, chargeable under invariant 4.
 */
describe("how far back each reason reaches", () => {
  it("gives the competitor reason a week and everything else a fortnight", () => {
    expect(REASON_WINDOW_DAYS.already_with_operator).toBe(7);
    for (const reason of DEAD_LEAD_REASONS) {
      if (reason === "already_with_operator") continue;
      expect(REASON_WINDOW_DAYS[reason]).toBe(CLAIM_WINDOW_DAYS);
    }
  });

  /**
   * ⚠️ Exhaustive on purpose. A seventh reason added without a window would
   * otherwise read as `undefined` and compare false against every age, silently
   * making that reason always available.
   */
  it("has a window for every reason and no others", () => {
    expect(Object.keys(REASON_WINDOW_DAYS).sort()).toEqual(
      [...DEAD_LEAD_REASONS].sort(),
    );
  });

  it("asks something answerable for every reason", () => {
    expect(Object.keys(REASON_DETAIL_PROMPT).sort()).toEqual(
      [...DEAD_LEAD_REASONS].sort(),
    );
    // ⚠️ "In their words" is nonsense for wrong_details — that reason exists
    // precisely because there was no landlord to quote.
    expect(REASON_DETAIL_PROMPT.wrong_details).not.toMatch(/they say|their words/i);
  });

  it("windowDaysForReason is what the map says", () => {
    for (const reason of DEAD_LEAD_REASONS) {
      expect(windowDaysForReason(reason)).toBe(REASON_WINDOW_DAYS[reason]);
    }
  });
});

describe("which reasons a lead can be reported under", () => {
  const claimable = (ageDays: number) => ({
    claimable: true,
    claimStatus: null,
    ageDays,
  });

  it("offers all six inside the first week", () => {
    const r = reasonAvailability(claimable(6));
    for (const reason of DEAD_LEAD_REASONS) expect(r[reason].available).toBe(true);
    expect(anyReasonAvailable(r)).toBe(true);
    expect(unavailableSummary(r)).toBeNull();
  });

  it("still offers the competitor reason ON the seventh day", () => {
    expect(reasonAvailability(claimable(7)).already_with_operator.available).toBe(true);
  });

  it("withdraws it on the eighth, and explains why", () => {
    const r = reasonAvailability(claimable(8));
    expect(r.already_with_operator.available).toBe(false);
    expect(r.already_with_operator.because).toMatch(/lost deal|over a week/i);
    // The other five are untouched — this is a per-reason rule, not a cliff.
    for (const reason of DEAD_LEAD_REASONS) {
      if (reason === "already_with_operator") continue;
      expect(r[reason].available).toBe(true);
    }
  });

  it("keeps the rest available on the fourteenth day", () => {
    const r = reasonAvailability(claimable(14));
    expect(r.unreachable.available).toBe(true);
    expect(r.property_sold.available).toBe(true);
  });

  /**
   * ⚠️ An ineligible lead shows the control with a REASON rather than hiding
   * it. An operator who saw it last week and not this week reads it as broken,
   * and nobody learns the rule from a control that comes and goes.
   */
  it("explains an out-of-window lead as age, not as 'you never worked it'", () => {
    const r = reasonAvailability({ claimable: false, claimStatus: null, ageDays: 40 });
    expect(anyReasonAvailable(r)).toBe(false);
    expect(unavailableSummary(r)).toMatch(/14 days|too long/i);
  });

  it("explains an unworked lead as unworked", () => {
    const r = reasonAvailability({ claimable: false, claimStatus: null, ageDays: 2 });
    expect(anyReasonAvailable(r)).toBe(false);
    expect(unavailableSummary(r)).toMatch(/worked it/i);
  });

  it("says a reported lead has already been reported", () => {
    const r = reasonAvailability({
      claimable: false,
      claimStatus: "under_review",
      ageDays: 2,
    });
    expect(anyReasonAvailable(r)).toBe(false);
    expect(unavailableSummary(r)).toMatch(/already told us/i);
  });

  it("tolerates an unknown age rather than guessing", () => {
    const r = reasonAvailability({ claimable: true, claimStatus: null, ageDays: null });
    // Eligibility is the authoritative answer; a missing age narrows nothing.
    for (const reason of DEAD_LEAD_REASONS) expect(r[reason].available).toBe(true);
  });

  /**
   * ⚠️ §51.3 in its strongest form: none of this copy may name the hidden
   * per-customer allowance, and an operator over it must read exactly what an
   * operator under it reads.
   */
  it("never names the allowance in any explanation", () => {
    for (const ageDays of [2, 8, 40]) {
      for (const claim of [true, false]) {
        const r = reasonAvailability({ claimable: claim, claimStatus: null, ageDays });
        for (const reason of DEAD_LEAD_REASONS) {
          const because = (r[reason].because ?? "").toLowerCase();
          for (const word of ["allowance", "quota", "budget", "limit", "remaining"]) {
            expect(because).not.toContain(word);
          }
        }
      }
    }
  });
});

describe("⚠️ the competitor reason cannot be confused with the close reason", () => {
  /**
   * `CLOSE_REASONS.sorted_elsewhere` ("Already sorted with someone else") and
   * this reason are near-identical sentences with OPPOSITE money outcomes, one
   * a bad lead and one a lost deal. §51.10 found them a click apart and had to
   * add the timing to both.
   */
  it("keeps the timing in the label", () => {
    expect(DEAD_LEAD_REASON_LABELS.already_with_operator).toMatch(
      /before i got through|already/i,
    );
  });

  it("shares no wording with any other vocabulary", () => {
    const all = [
      ...Object.values(DEAD_LEAD_REASON_LABELS),
      ...Object.values(CLOSE_REASONS),
      ...Object.values(FIT_REASONS),
    ].map((l) => l.toLowerCase().trim());
    expect(new Set(all).size).toBe(all.length);
  });
});

/**
 * ⚠️ FILE-TEXT GUARDS ON THE ROUTES.
 *
 * §42.8 records what the alternative costs: a safety boundary asserted in a
 * pull request, checked by a test that wrote its own copy of the query, and
 * never actually present — 91 follow-up runs destroyed within six minutes of
 * deploy. These read the real files.
 *
 * Comments are stripped first. Both files explain these rules in prose and
 * necessarily contain the very tokens being banned, so a naive check fails on
 * the explanation and trains the next person to delete the explanation (§46).
 */
describe("the seven-day rule is actually wired into the route", () => {
  const strip = (p: string) =>
    readFileSync(resolve(__dirname, "..", "..", p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  const claimRoute = () => strip("app/api/customer/dead-lead-claim/route.ts");

  it("sends a per-reason window, not the fortnight", () => {
    const src = claimRoute();
    expect(src).toContain("windowDaysForReason(reason)");
    // ⚠️ Reverting either call site to the constant is a ONE-TOKEN change that
    // silently restores a fortnight to the reason that must not have one, and
    // no behavioural test in this suite could see it.
    expect(src).not.toMatch(/p_window_days:\s*CLAIM_WINDOW_DAYS/);
  });

  it("uses the same window for the commit as for the eligibility read", () => {
    const src = claimRoute();
    const uses = src.match(/p_window_days:\s*windowDays/g) ?? [];
    // Both call sites. One would mean the row lock re-asserts a different rule
    // from the one the route just applied, and the lock is the authority.
    expect(uses.length).toBe(2);
  });

  it("narrows the reason before it touches the database", () => {
    const src = claimRoute();
    const narrow = src.indexOf("isReason(body?.reason)");
    const firstRpc = src.indexOf("claimable_dead_lead_assignments");
    expect(narrow).toBeGreaterThan(-1);
    expect(firstRpc).toBeGreaterThan(-1);
    // An empty submit must cost no round trip and write nothing.
    expect(narrow).toBeLessThan(firstRpc);
  });
});

describe("the admin decision route settles a swap atomically", () => {
  const strip = (p: string) =>
    readFileSync(resolve(__dirname, "..", "..", p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  const adminRoute = () => strip("app/api/admin/quality-claims/[id]/route.ts");

  it("goes through the one transactional RPC", () => {
    expect(adminRoute()).toContain("resolve_dead_lead_claim_with_swap");
  });

  /**
   * ⚠️ Two HTTP calls cannot settle this. The swap deletes the assignment,
   * which nulls the claim's pointer; a failure in between leaves an
   * under_review claim, no assignment, and a free lead already delivered.
   */
  it("never posts to the standalone swap endpoint instead", () => {
    expect(adminRoute()).not.toContain("/api/admin/assignments");
  });

  it("requires the filter override to be sent explicitly", () => {
    // A truthy 1 must not place a lead the customer filtered out.
    expect(adminRoute()).toContain("body?.allow_filter_mismatch === true");
  });

  /**
   * ⚠️ `uphold` and `uphold_goodwill` differ only in whether the hidden
   * allowance is spent. An email that read differently between them would
   * publish the allowance to any two operators comparing notes, so the
   * distinction must not reach the send.
   */
  it("tells the customer nothing about which uphold verb fired", () => {
    const src = adminRoute();
    const send = src.slice(src.indexOf("async function notifyUpheld"));
    expect(send).not.toContain("goodwill");
    expect(send).not.toContain("consumesAllowance");
    expect(send).not.toContain("allowance_consumed");
  });
});
