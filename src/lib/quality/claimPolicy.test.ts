import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowanceBudget,
  decideClaim,
  ineligibleMessage,
  CLEAN_STREAK_PER_CREDIT,
  EARNED_CEILING,
  QUALITY_CLAIM_WINDOW_DAYS,
  type ClaimCustomer,
  type ClaimInput,
  type PeerAssignment,
} from "./claimPolicy";

const NOW = new Date("2026-09-10T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function customer(overrides: Partial<ClaimCustomer> = {}): ClaimCustomer {
  return {
    monthly_allocation: 20,
    quality_allowance_pct: 0.1,
    quality_claims_this_cycle: 0,
    clean_leads_streak: 0,
    quality_review_required: false,
    ...overrides,
  };
}

function peer(overrides: Partial<PeerAssignment> = {}): PeerAssignment {
  return {
    status: "new",
    pipeline_stage: "cold",
    rejection_reason: null,
    claim_status: null,
    ...overrides,
  };
}

/** A claim that satisfies every eligibility gate, so each test can break one. */
function input(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    assignment: {
      assigned_at: daysAgo(3),
      status: "contacted",
      pipeline_stage: "cold",
      rejection_reason: null,
    },
    customer: customer(),
    peers: [],
    noteCount: 1,
    reason: "already_with_operator",
    detail: "Spoke to the landlord, they signed with another agent last week.",
    contactedOn: "2026-09-09",
    now: NOW,
    ...overrides,
  };
}

test("allowanceBudget is a share of the plan plus earned credits", () => {
  assert.equal(allowanceBudget(customer()), 2);
  assert.equal(allowanceBudget(customer({ monthly_allocation: 10 })), 1);
  assert.equal(
    allowanceBudget(customer({ clean_leads_streak: CLEAN_STREAK_PER_CREDIT })),
    3
  );
});

test("earned credits are capped, so a long streak cannot bank unlimited claims", () => {
  const streak = CLEAN_STREAK_PER_CREDIT * (EARNED_CEILING + 5);
  assert.equal(
    allowanceBudget(customer({ clean_leads_streak: streak })),
    2 + EARNED_CEILING
  );
});

test("a claim outside the window is ineligible", () => {
  const result = decideClaim(
    input({
      assignment: {
        assigned_at: daysAgo(QUALITY_CLAIM_WINDOW_DAYS + 1),
        status: "contacted",
        pipeline_stage: "cold",
        rejection_reason: null,
      },
    })
  );
  assert.equal(result.decision, "ineligible");
  assert.equal(result.code, "window_expired");
});

test("a lead nobody has worked is ineligible", () => {
  const result = decideClaim(
    input({
      assignment: {
        assigned_at: daysAgo(1),
        status: "new",
        pipeline_stage: "cold",
        rejection_reason: null,
      },
      noteCount: 0,
    })
  );
  assert.equal(result.decision, "ineligible");
  assert.equal(result.code, "not_worked");
});

test("a note alone is enough evidence of work", () => {
  const result = decideClaim(
    input({
      assignment: {
        assigned_at: daysAgo(1),
        status: "new",
        pipeline_stage: "cold",
        rejection_reason: null,
      },
      noteCount: 1,
    })
  );
  assert.equal(result.decision, "auto_uphold");
});

test("a thin detail or a missing contact date is ineligible", () => {
  assert.equal(decideClaim(input({ detail: "gone" })).code, "detail_too_short");
  assert.equal(
    decideClaim(input({ contactedOn: null })).code,
    "missing_contact_date"
  );
});

test("a customer under manual review never auto-upholds", () => {
  const result = decideClaim(
    input({ customer: customer({ quality_review_required: true }) })
  );
  assert.equal(result.decision, "review");
  assert.equal(result.code, "forced_review");
});

test("a peer who got engagement contradicts the claim", () => {
  const byStatus = decideClaim(input({ peers: [peer({ status: "won" })] }));
  assert.equal(byStatus.decision, "review");
  assert.equal(byStatus.corroboration, "peer_contradicts");

  const byStage = decideClaim(
    input({ peers: [peer({ pipeline_stage: "web_meeting_booked" })] })
  );
  assert.equal(byStage.corroboration, "peer_contradicts");
});

test("a peer who abandoned the lead does not contradict it", () => {
  const result = decideClaim(
    input({ peers: [peer({ pipeline_stage: "abandoned" })] })
  );
  assert.equal(result.decision, "auto_uphold");
  assert.equal(result.corroboration, "none");
});

test("an upheld peer claim corroborates and costs no allowance", () => {
  const result = decideClaim(
    input({
      customer: customer({ quality_claims_this_cycle: 99 }),
      peers: [
        peer({
          rejection_reason: "already_with_operator",
          claim_status: "upheld",
        }),
      ],
    })
  );
  assert.equal(result.decision, "auto_uphold");
  assert.equal(result.corroboration, "peer_agrees");
  assert.equal(result.consumesAllowance, false);
});

test("an unadjudicated peer claim does not corroborate", () => {
  const result = decideClaim(
    input({
      peers: [
        peer({
          rejection_reason: "already_with_operator",
          claim_status: "under_review",
        }),
      ],
    })
  );
  assert.equal(result.corroboration, "none");
  assert.equal(result.consumesAllowance, true);
});

test("contradiction beats corroboration", () => {
  const result = decideClaim(
    input({
      peers: [
        peer({ rejection_reason: "no_longer_interested", claim_status: "upheld" }),
        peer({ status: "in_discussion" }),
      ],
    })
  );
  assert.equal(result.decision, "review");
  assert.equal(result.corroboration, "peer_contradicts");
});

test("a claim within the budget is upheld and spends allowance", () => {
  const result = decideClaim(
    input({ customer: customer({ quality_claims_this_cycle: 1 }) })
  );
  assert.equal(result.decision, "auto_uphold");
  assert.equal(result.consumesAllowance, true);
  assert.equal(result.code, "within_allowance");
});

test("a claim over the budget goes to review, never a silent decline", () => {
  const result = decideClaim(
    input({ customer: customer({ quality_claims_this_cycle: 2 }) })
  );
  assert.equal(result.decision, "review");
  assert.equal(result.code, "over_allowance");
  assert.equal(result.consumesAllowance, false);
});

test("a clean streak buys headroom past the base budget", () => {
  const result = decideClaim(
    input({
      customer: customer({
        quality_claims_this_cycle: 2,
        clean_leads_streak: CLEAN_STREAK_PER_CREDIT,
      }),
    })
  );
  assert.equal(result.decision, "auto_uphold");
});

test("no ineligible message leaks the allowance", () => {
  const codes = [
    "window_expired",
    "not_worked",
    "detail_too_short",
    "missing_contact_date",
  ] as const;
  for (const code of codes) {
    const message = ineligibleMessage(code).toLowerCase();
    assert.ok(message.length > 0, `${code} has a message`);
    for (const leak of ["allowance", "quota", "budget", "limit", "credits left"]) {
      assert.ok(!message.includes(leak), `${code} must not mention "${leak}"`);
    }
  }
});
