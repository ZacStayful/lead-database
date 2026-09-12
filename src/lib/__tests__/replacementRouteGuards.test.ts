import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * File-text guards on the replacement routes (§53).
 *
 * ⚠️ THESE READ THE REAL FILES RATHER THAN RESTATING WHAT THEY SHOULD CONTAIN.
 * §42.8 lost 91 follow-up runs to a safety boundary asserted in a pull request
 * and never actually written, and to a scratch test that hand-wrote its own
 * copy of the query it was meant to be checking. Every assertion below anchors
 * on the source that ships.
 *
 * Comments are stripped first. §46 records a guard that matched its own
 * explanatory comment and so trained the next reader to delete the explanation.
 */
const strip = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SWAP = "src/app/api/customer/replacements/swap/route.ts";
const LIST = "src/app/api/customer/replacements/route.ts";
const PAGE = "src/app/dashboard/replacements/page.tsx";
const COMPONENT = "src/components/dashboard/ReplacementList.tsx";

describe("the swap route", () => {
  // ⚠️ §34/§35: the flag has to be SENT. An inferred or coalesced true would
  // silently place a lead outside the customer's own filter.
  it("reads allow_filter_mismatch with a strict === true", () => {
    expect(strip(SWAP)).toContain("body.allow_filter_mismatch === true");
  });

  // ⚠️ The same trap §52.3 pins for the credit route: both the eligibility read
  // and the commit must use the REASON's window, or the row lock re-asserts a
  // different rule from the one the route just applied — and the lock wins.
  it("derives the window from the reason, not from the fortnight constant", () => {
    const src = strip(SWAP);
    expect(src).toContain("windowDaysForReason(reason)");
    expect(src).not.toMatch(/p_window_days:\s*CLAIM_WINDOW_DAYS/);
    // Three call sites, not two: the eligibility read, the review claim on
    // the peer/under-review path, and the swap itself. All three must agree.
    expect(src.match(/p_window_days:\s*windowDays/g)?.length).toBe(3);
  });

  // ⚠️ The admin swap route passes error.message through verbatim on purpose,
  // for an admin who can act on it. Here the raises are internal codes and
  // races; a customer gets a sentence they can act on instead.
  it("never passes a raw database message to the customer", () => {
    const src = strip(SWAP);
    expect(src).not.toMatch(/message:\s*(swapError|error)\.message/);
    expect(src).toContain('code: "no_entitlement"');
    expect(src).toContain('code: "no_stock"');
  });

  // ⚠️ The original lead id cannot be re-derived after the swap: the assignment
  // is deleted and the claim's pointer is nulled. It comes back from the RPC.
  it("flags the ORIGINAL lead, from the RPC's own return", () => {
    expect(strip(SWAP)).toContain("result?.original_lead_id");
  });

  // The replacement is a delivery and goes out through the one follow-through
  // every other assignment uses, with sendThresholdWarnings false — no credit
  // moved, so the low-balance warnings would misfire.
  it("notifies through completeAssignment with warnings suppressed", () => {
    const src = strip(SWAP);
    expect(src).toContain("completeAssignment(");
    expect(src).toMatch(/result\.replacement_assignment_id,\s*false,?\s*\)/);
  });

  // ⚠️ The two safety valves survive the hard stop, and neither may explain
  // itself: §19.7 forbids a refusal that tells operator A what operator B is
  // doing. The route reuses the verdict's own neutral sentence.
  it("routes a review verdict without naming the peer", () => {
    const src = strip(SWAP);
    expect(src).toContain('p_decision: "review"');
    expect(src).toContain("message: verdict.message");
    expect(src).not.toMatch(/another operator (is|has)/i);
  });

  it("takes the customer from the session, never the body", () => {
    const src = strip(SWAP);
    expect(src).toContain("p_customer_id: customer.id");
    expect(src).not.toMatch(/p_customer_id:\s*body\./);
  });
});

describe("the candidates route", () => {
  it("scopes candidates to the signed-in customer", () => {
    const src = strip(LIST);
    expect(src).toContain("p_customer_id: customer.id");
    expect(src).not.toMatch(/p_customer_id:\s*(req|body|searchParams)/);
  });

  // ⚠️ The cap lives in SQL; the route must not be the only thing holding it.
  it("asks for a bounded page of candidates", () => {
    expect(strip(LIST)).toContain("p_limit: 20");
  });
});

describe("the client surfaces", () => {
  // ⚠️ §51.6: the list is a client component, and deadLeadPolicy.ts reaches
  // plans.ts through products.ts. It may import the copy module and nothing else
  // from that tree.
  it("import the copy module, never the policy module", () => {
    expect(strip(COMPONENT)).not.toContain("quality/deadLeadPolicy");
    expect(strip(COMPONENT)).toContain("quality/deadLeadCopy");
  });

  // ⚠️ A resold imported lead carries the UPLOADING operator's private working
  // notes in lead_profile (§32.8). Both readers scope it.
  it("scope every lead they render to the viewer", () => {
    expect(strip(PAGE)).toContain("viewerScopedLead(");
    expect(strip(LIST)).toContain("viewerScopedLead(");
  });

  // The number is published deliberately, and a silent removal would turn the
  // hard stop back into an unexplained refusal.
  it("renders the remaining count", () => {
    expect(strip(COMPONENT)).toContain("remainingSentence(");
  });
});
