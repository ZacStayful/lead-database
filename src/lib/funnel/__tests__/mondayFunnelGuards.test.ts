/**
 * Guards on the REAL files behind the funnel's Monday writes (batch 03
 * Phase 2, §76). vitest.config.mts is PURE UNITS ONLY, so a route is never run
 * here; these read the files, comments stripped (§42.8), and pin the orderings
 * that make the writes safe.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const CRON = source("src/app/api/cron/funnel-discounts/route.ts");
const WEBHOOK = source("src/app/api/webhook/stripe/route.ts");
const MONDAY = source("src/lib/monday.ts");
const SYNC = source("src/lib/funnel/mondayFunnelSync.ts");
const ANSWERS = source("src/app/api/funnel/[token]/answers/route.ts");

const at = (src: string, needle: string, from = 0) => {
  const i = src.indexOf(needle, from);
  expect(i, `missing: ${needle}`).toBeGreaterThanOrEqual(0);
  return i;
};

/** The body of one top-level function, from its signature to the next one. */
function fn(src: string, name: string): string {
  const start = at(src, `function ${name}(`);
  const next = src.slice(start + 1).search(/\n(export )?(async )?function /);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

describe("the cron runs the Monday passes in the right place (E3)", () => {
  it("after the switch, before the coupon check and before the discount pass", () => {
    const passes = at(CRON, "await runFunnelMondayPasses(admin, { dryRun })");
    expect(at(CRON, 'skipped: "funnel_disabled"')).toBeLessThan(passes);
    expect(passes).toBeLessThan(at(CRON, "!process.env.STRIPE_POST_CALL_COUPON_ID"));
    expect(passes).toBeLessThan(at(CRON, "await issueFunnelDiscounts("));
  });

  it("a failed Monday run fails the cron run", () => {
    expect(CRON).toContain("result.ok && monday.ok ? 200 : 500");
  });
});

describe("the webhook writes Sign-up source once, safely (E4)", () => {
  it("one call site, after the management Monday push, never in the GR branch", () => {
    const calls = WEBHOOK.split("await pushSignupSourceCell(admin, customer.id, invoice)").length - 1;
    expect(calls).toBe(1);
    const call = at(WEBHOOK, "await pushSignupSourceCell(admin, customer.id, invoice)");
    expect(at(WEBHOOK, 'await pushMondayStatus(admin, customer.id, "invoice.paid/management")')).toBeLessThan(call);
    expect(at(WEBHOOK, 'pushMondayStatus(admin, customer.id, "invoice.paid/gr")')).toBeLessThan(
      at(WEBHOOK, "await completeFunnelPayment(")
    );
  });

  // ⚠️ at(), never a bare indexOf: indexOf is -1 for a missing needle, and -1
  // is "less than" anything, so an ordering check on it passes with the try
  // removed. The mutation run caught exactly that here.
  it("first paid invoice only, and its own try/catch (§23.6)", () => {
    const helper = fn(WEBHOOK, "pushSignupSourceCell");
    const call = at(helper, "await pushSignupSource(admin, customerId)");
    expect(at(helper, 'invoice.billing_reason !== "subscription_create"')).toBeLessThan(call);
    expect(at(helper, "try {")).toBeLessThan(call);
    expect(at(helper, "} catch (err) {")).toBeGreaterThan(call);
  });
});

describe("the Monday writers", () => {
  it("the status write is BY ID, and never creates a label (E10)", () => {
    const w = fn(MONDAY, "setEnquiryStatusById");
    expect(w).toContain("[ENQUIRY_STATUS_COLUMN]: { index: params.labelId }");
    expect(w).not.toMatch(/label:/);
    expect(w).toContain("create_labels_if_missing: false");
  });

  it("the Sign-up source write reads first, skips unchanged, and never creates a label", () => {
    const w = fn(MONDAY, "setEnquirySignupSource");
    const read = at(w, "items(ids: $ids)");
    const mutation = at(w, "change_multiple_column_values(");
    expect(read).toBeLessThan(mutation);
    expect(at(w, 'skipped: "unchanged"')).toBeLessThan(mutation);
    expect(at(w, 'skipped: "not_status_board"')).toBeLessThan(mutation);
    expect(w).toContain("create_labels_if_missing: false");
  });
});

describe("one status write: configured, claimed, guarded, then written", () => {
  const sync = fn(SYNC, "syncFunnelMondayStatus");

  it("checks the configuration and the item BEFORE claiming", () => {
    const claim = at(sync, "await claimFunnelMondayWrite(");
    expect(at(sync, "funnelStatusLabelId(transition, env)")).toBeLessThan(claim);
    expect(at(sync, "!env.MONDAY_API_TOKEN")).toBeLessThan(claim);
    expect(at(sync, 'reason: "no_item"')).toBeLessThan(claim);
  });

  it("claims BEFORE it reads or writes Monday", () => {
    const claim = at(sync, "await claimFunnelMondayWrite(");
    expect(claim).toBeLessThan(at(sync, "await fetchEnquiryItem("));
    expect(claim).toBeLessThan(at(sync, "await setEnquiryStatusById("));
  });

  it("applies the guard, and refuses another board, BEFORE writing", () => {
    const write = at(sync, "await setEnquiryStatusById(");
    expect(at(sync, "!mayWriteFunnelLabel(transition, current)")).toBeLessThan(write);
    expect(at(sync, "funnelLabelAlreadySet(transition, current)")).toBeLessThan(write);
    expect(at(sync, "read.item.boardId !== enquiryBoardId()")).toBeLessThan(write);
  });

  it("the take-over of a stale claim is conditional on its age and outcome", () => {
    const claim = fn(SYNC, "claimFunnelMondayWrite");
    expect(claim).toContain('.lt("claimed_at", retryBefore)');
    expect(claim).toContain('take.is("outcome", null)');
    expect(claim).toContain('take.eq("outcome", outcome)');
    expect(claim).toContain('inserted.error.code !== "23505"');
  });

  it("settling never overwrites a settled claim", () => {
    expect(fn(SYNC, "settleClaim")).toContain('.is("outcome", null)');
  });
});

describe("the answers route does not call Monday", () => {
  it("'started' is the cron's: a visitor's save never waits on Monday", () => {
    expect(ANSWERS).not.toContain("@/lib/monday");
    expect(ANSWERS).not.toContain("mondayFunnelSync");
  });
});
