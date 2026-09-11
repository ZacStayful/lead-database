/**
 * Guards on the admin side of the dead-lead queue and the grouped header
 * (CLAUDE.md §51, 0139).
 *
 * These read the real files rather than restating what they should contain.
 * §42.8 records what the alternative cost: a safety boundary asserted in a pull
 * request, checked by a test that wrote its own copy of the query, and never
 * actually present — 91 follow-up runs destroyed within six minutes of deploy.
 *
 * ⚠️ Comments are stripped first. Every one of these files explains the rule
 * being asserted and therefore contains the tokens being banned, so a naive
 * check fails on the explanation and trains the next person to delete the
 * explanation (§46 hit exactly this).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const strip = (p: string) =>
  readFileSync(resolve(__dirname, "..", "..", p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the review queue shows what the decision turns on", () => {
  const page = () => strip("app/admin/quality/page.tsx");

  it("reads effort from the function written for live assignments", () => {
    expect(page()).toContain("get_assignment_effort");
  });

  /**
   * ⚠️ `get_outcome_evidence` computes most of the same figures and is gated to
   * won/not_relevant/rejected. /admin/outcomes lists exactly what that filter
   * returns, so widening it to serve a live claimed assignment would silently
   * change an unrelated page.
   */
  it("does not reach for the terminal-status one instead", () => {
    expect(page()).not.toContain("get_outcome_evidence");
  });

  it("fetches effort once for the queue, not once per claim", () => {
    const calls = page().match(/get_assignment_effort/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it("distinguishes a replacement from a refund in the log", () => {
    expect(page()).toContain('"swap"');
    expect(page()).toContain("replaced");
  });
});

describe("the swap picker is reused, not reimplemented", () => {
  const actions = () => strip("components/admin/QualityClaimActions.tsx");

  it("renders the existing control", () => {
    // A second picker would be a fifth hand-written copy of the filter
    // predicate — the trap 0109 avoided with get_swap_candidates_for_assignment.
    expect(actions()).toContain("SwapLeadControl");
  });

  it("settles through the claim route, in one transaction", () => {
    expect(actions()).toContain("/api/admin/quality-claims/");
    expect(actions()).toContain("uphold_swap");
    // ⚠️ Two calls cannot settle this: the swap nulls the claim's pointer, so a
    // failure in between leaves an under_review claim and a free lead.
    expect(actions()).not.toContain("/api/admin/assignments/");
  });

  it("names the notes a swap destroys", () => {
    // A claimed lead is likelier than average to carry notes, because reporting
    // one requires having worked it — and the customer never sees this warning.
    expect(actions()).toMatch(/note.*deleted with it/is);
  });

  it("says no credit goes back", () => {
    expect(actions()).toMatch(/no credit/i);
  });
});

describe("the admin header is grouped and on one breakpoint", () => {
  const layout = () => strip("app/admin/layout.tsx");

  it("reuses the customer header's component", () => {
    expect(layout()).toContain("DesktopNav");
    expect(layout()).toContain("navGroups");
  });

  /**
   * ⚠️ The old row was `sm:flex` while MobileNav is `lg:hidden`, so between
   * those two widths BOTH navs rendered. DesktopNav is `lg:flex`, which puts
   * the pair back in step — re-introducing a hand-rolled `sm:flex` nav here
   * would bring the bug back.
   */
  it("no longer hand-rolls a nav at the wrong breakpoint", () => {
    expect(layout()).not.toContain("sm:flex");
  });

  it("still flattens for the mobile sheet", () => {
    // A full-height sheet has room for every link, so grouping there would add
    // a tap for nothing — the dashboard layout does exactly this.
    expect(layout()).toContain("navGroups.flatMap");
    expect(layout()).toContain("<MobileNav items={nav} />");
  });

  it("keeps every destination the flat list had", () => {
    const src = layout();
    for (const href of [
      "/admin",
      "/admin/customers",
      "/admin/leads",
      "/admin/imported-leads",
      "/admin/outcomes",
      "/admin/quality",
      "/admin/support",
      "/admin/pool",
      "/admin/offers",
      "/admin/training",
      "/admin/announcements",
      "/admin/messaging",
      "/admin/api",
      "/dashboard",
    ]) {
      expect(src).toContain(`"${href}"`);
    }
  });
});
