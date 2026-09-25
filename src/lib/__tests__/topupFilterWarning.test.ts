import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { topupFilterWarning } from "@/lib/topup";

/**
 * Nothing in the top-up path read the filter for any decision, so a customer
 * whose filter is forecast at one lead a month could buy five more for £75.
 * The fixture below is a real production row.
 */
type Row = Parameters<typeof topupFilterWarning>[0];

const base: Row = {
  filter_status: "active",
  gr_filter_status: "off",
  filter_expected_leads: 1,
  gr_filter_expected_leads: null,
  monthly_allocation: 20,
  gr_monthly_allocation: 10,
  lead_balance: 32,
  gr_lead_balance: 0,
};

const warn = (over: Partial<Row> = {}, lt: "management" | "guaranteed_rent" = "management") =>
  topupFilterWarning({ ...base, ...over }, lt, 5);

describe("topupFilterWarning", () => {
  it("says nothing when no filter is in force", () => {
    expect(warn({ filter_status: "off" })).toBeNull();
  });

  it("says nothing when there is no stored forecast", () => {
    // §58.3 measured 5 of 11 filtered customers carrying nulls. Inventing a
    // figure would be worse than staying quiet.
    expect(warn({ filter_expected_leads: null })).toBeNull();
  });

  it("says nothing when the forecast already covers the plan", () => {
    // Then the BALANCE is genuinely the constraint and a top-up is exactly
    // the right purchase — warning here would be noise on a good sale.
    expect(warn({ filter_expected_leads: 20 })).toBeNull();
    expect(warn({ filter_expected_leads: 25 })).toBeNull();
  });

  it("warns on the real under-plan row, naming forecast, plan and unspent credit", () => {
    const msg = warn();
    expect(msg).toContain("at least 1 lead a month");
    expect(msg).toContain("plan of 20");
    expect(msg).toContain("32 leads of credit unspent");
    expect(msg).toContain("adds 5 more");
  });

  it("drops the unspent clause when there is no banked credit", () => {
    const msg = warn({ lead_balance: 0 });
    expect(msg).not.toContain("unspent");
    expect(msg).toContain("plan of 20");
  });

  it("gets singulars right", () => {
    expect(warn({ lead_balance: 1 })).toContain("1 lead of credit unspent");
    expect(warn({ filter_expected_leads: 2 })).toContain("at least 2 leads a month");
  });

  it("⚠️ reads gr_ columns and only gr_ columns (invariant 6)", () => {
    // A management filter must never produce a GR warning, and vice versa.
    expect(warn({}, "guaranteed_rent")).toBeNull();
    const gr = warn(
      {
        gr_filter_status: "active",
        gr_filter_expected_leads: 2,
        gr_monthly_allocation: 10,
        gr_lead_balance: 7,
        // management side deliberately hostile — must not leak in
        filter_expected_leads: 99,
        monthly_allocation: 1,
        lead_balance: 500,
      },
      "guaranteed_rent"
    );
    expect(gr).toContain("at least 2 leads a month");
    expect(gr).toContain("plan of 10");
    expect(gr).toContain("7 leads of credit unspent");
    expect(gr).not.toContain("500");
  });

  it("treats pending_lift as in force", () => {
    // The lift only executes at the next renewal, so the filter still filters.
    expect(warn({ filter_status: "pending_lift" })).toContain("plan of 20");
  });

  it("warns without refusing, and promises nothing", () => {
    const msg = warn()!;
    expect(msg.toLowerCase()).not.toContain("cannot");
    expect(msg.toLowerCase()).not.toContain("guarantee");
    expect(msg.toLowerCase()).not.toContain("refus");
    expect(msg).toContain("widening your filter");
  });
});

/**
 * ⚠️ A warning that is computed and never rendered is the §42.8 shape: a
 * boundary asserted in a pull request and not actually written. These read the
 * real files rather than restating what they should contain.
 *
 * Comments are stripped first — both files explain the rule, and explaining it
 * means naming `filterWarning`, so a raw substring check passes on the
 * explanation and trains the next person to delete the explanation (§51.11).
 * Whitespace is collapsed for the same reason: Prettier wraps JSX freely.
 */
describe("the warning actually reaches the screen", () => {
  const source = (file: string) =>
    readFileSync(resolve(__dirname, "..", "..", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ");

  const PAGE = "app/dashboard/topup/page.tsx";
  const PANEL = "components/dashboard/TopupPurchasePanel.tsx";

  it("the page computes it and hands it to the panel", () => {
    const src = source(PAGE);
    expect(src).toContain("topupFilterWarning(customer, leadType, TOPUP_CREDITS)");
    expect(src).toContain("filterWarning={card.filterWarning}");
  });

  it("the panel renders it, not merely accepts the prop", () => {
    const src = source(PANEL);
    expect(src).toContain("{filterWarning && ");
    expect(src).toContain("{filterWarning}");
  });

  it("⚠️ renders it BEFORE the charge, which is the whole point", () => {
    // Told only after paying, it is information rather than a decision.
    const src = source(PANEL);
    const warning = src.indexOf("{filterWarning && ");
    const confirm = src.indexOf("Confirm {priceLabel}");
    expect(warning).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(confirm);
  });

  it("offers the way out rather than a dead end", () => {
    // ⚠️ Written first as a bare `toContain("/dashboard/filtering")` on the
    // whole file, which PASSED with the link deleted — the success branch
    // carries its own "Review your lead filter" link and that is what it
    // found. Scoped to the warning block, the mutation fails. (§50.9)
    const src = source(PANEL);
    const block = src.slice(
      src.indexOf("{filterWarning && "),
      src.indexOf("{blockedReason ?")
    );
    expect(block).toContain("/dashboard/filtering");
  });
});
