/**
 * The retention summary JARVIS reads (§74).
 *
 * WHAT BREAKS IN PRODUCTION IF THESE FAIL
 * ---------------------------------------
 * JARVIS speaks these figures to Zac as "churn stands at N per cent". A wrong
 * denominator here is a wrong number said out loud with no error anywhere.
 * And the whitelist test is the one that keeps `customerId` — or whatever
 * column is added to LifecycleRow next — off a cross-app contract.
 */

import { describe, it, expect } from "vitest";
import type { LifecycleRow } from "../retention";
import {
  SUMMARY_ROW_KEYS,
  summariseProduct,
  summariseRetention,
  summariseRow,
} from "../retentionSummary";

const NOW = new Date("2026-10-09T12:00:00Z");

function row(over: Partial<LifecycleRow> & { customerId: string }): LifecycleRow {
  return {
    key: `${over.customerId}:${over.leadType ?? "management"}`,
    businessName: "Acme Lettings",
    email: "someone@example.com",
    leadType: "management",
    isArchived: false,
    firstPaidAt: "2026-07-24T10:40:00Z",
    tenureAnchor: "2026-07-24T10:40:00Z",
    tenureBasis: "invoice",
    invoicesPaid: 3,
    mrrPence: 15_000,
    endedAt: null,
    endKind: null,
    cancelEffectiveAt: null,
    pausedAt: null,
    pauseResumesAt: null,
    state: "active",
    tenureMonths: 2.5333,
    band: "m1_3",
    reasonThemes: [],
    reasonSource: "none",
    reasonRaw: [],
    reasonNote: null,
    ...over,
  };
}

const ROWS: LifecycleRow[] = [
  row({ customerId: "cust_active" }),
  row({
    customerId: "cust_churned",
    businessName: "Gone Stays",
    firstPaidAt: "2026-07-28T08:44:00Z",
    tenureAnchor: "2026-07-28T08:44:00Z",
    invoicesPaid: 1,
    mrrPence: 15_000,
    endedAt: "2026-08-28T08:44:00Z",
    endKind: "cancelled",
    state: "cancelled",
    tenureMonths: 1.0,
    band: "m1_3",
    reasonThemes: ["lead_quality"],
    reasonSource: "cancellation_row",
    reasonRaw: ["lead_quality"],
    reasonNote: "Too many tyre-kickers",
  }),
  row({
    customerId: "cust_never_paid",
    businessName: "Never Paid Ltd",
    firstPaidAt: null,
    tenureAnchor: "2026-09-01T00:00:00Z",
    tenureBasis: "never_paid",
    invoicesPaid: 0,
    mrrPence: 0,
    endedAt: "2026-09-10T00:00:00Z",
    endKind: "lapsed",
    state: "lapsed",
    tenureMonths: 0.3,
    band: "m0_1",
    reasonSource: "write_off",
  }),
  row({
    customerId: "cust_gr",
    leadType: "guaranteed_rent",
    businessName: "GR Operator",
    firstPaidAt: "2026-09-20T00:00:00Z",
    tenureAnchor: "2026-09-20T00:00:00Z",
    invoicesPaid: 1,
    tenureMonths: 0.6,
    band: "m0_1",
  }),
];

describe("summariseRetention", () => {
  const summary = summariseRetention(
    { asOf: NOW.toISOString(), lifecycle: ROWS, unavailable: false, partial: [] },
    NOW
  );

  it("reports per product, only products with customers", () => {
    expect(summary.products.map((p) => p.leadType)).toEqual(["management", "guaranteed_rent"]);
    const mgmt = summary.products[0];
    expect(mgmt.label).toBe("Management");
    expect(mgmt.customers).toBe(3);
    expect(mgmt.active).toBe(1);
    expect(mgmt.paused).toBe(0);
    expect(mgmt.cancelling).toBe(0);
  });

  it("churn rate is paid-then-left over ever-paid; never-paid churn is reported apart", () => {
    const mgmt = summary.products[0];
    expect(mgmt.payingEver).toBe(2);
    expect(mgmt.churned).toBe(1);
    expect(mgmt.churnedNeverPaid).toBe(1);
    expect(mgmt.churnRatePct).toBe(50);
    const gr = summary.products[1];
    expect(gr.payingEver).toBe(1);
    expect(gr.churned).toBe(0);
    expect(gr.churnRatePct).toBe(0);
  });

  it("carries the renewal checkpoints through unchanged, suppression included", () => {
    const mgmt = summary.products[0];
    const oneMonth = mgmt.retention.find((c) => c.months === 1)!;
    expect(oneMonth).toMatchObject({ label: "1 month", eligible: 2, renewed: 1, churned: 1, unclear: 0, paused: 0, suppressed: true, pct: null });
    const sixMonths = mgmt.retention.find((c) => c.months === 6)!;
    expect(sixMonths.eligible).toBe(0);
    expect(sixMonths.measurableFrom).toBe("2027-01-24");
  });

  it("MRR and reasons come from the page's own functions", () => {
    const mgmt = summary.products[0];
    expect(mgmt.mrr.totalPence).toBe(15_000);
    expect(mgmt.mrr.pausedPence).toBe(0);
    expect(mgmt.mrr.bands.find((b) => b.band === "m1_3")).toMatchObject({ label: "1 to 3 months", customers: 1, pence: 15_000 });
    expect(mgmt.reasons).toEqual(
      expect.arrayContaining([
        { theme: "lead_quality", label: "Lead quality", count: 1 },
        { theme: "not_recorded", label: "Not recorded", count: 1 },
      ])
    );
  });

  it("data quality is passed through", () => {
    expect(summary.quality).toMatchObject({ invoiceBacked: 3, signupEstimated: 0, neverPaid: 1, cohorts: 2, earliestFirstPaid: "2026-07-24" });
  });

  it("an unavailable read yields an empty, honest summary", () => {
    const empty = summariseRetention({ asOf: NOW.toISOString(), lifecycle: ROWS, unavailable: true, partial: ["payments"] }, NOW);
    expect(empty.unavailable).toBe(true);
    expect(empty.products).toEqual([]);
    expect(empty.lifecycle).toEqual([]);
    expect(empty.partial).toEqual(["payments"]);
  });
});

describe("summariseRow — the whitelist", () => {
  it("carries exactly SUMMARY_ROW_KEYS and nothing internal", () => {
    const out = summariseRow(ROWS[1]);
    expect(Object.keys(out).sort()).toEqual([...SUMMARY_ROW_KEYS].sort());
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/customerId|tenureAnchor|reasonRaw|reasonSource|"key"/);
    expect(json).not.toContain(ROWS[1].customerId);
    expect(out).toMatchObject({
      businessName: "Gone Stays",
      state: "cancelled",
      stateLabel: "Cancelled",
      tenureMonths: 1,
      invoicesPaid: 1,
      reasonThemes: ["lead_quality"],
      reasonLabels: ["Lead quality"],
      reasonNote: "Too many tyre-kickers",
    });
  });

  it("rounds tenure to one decimal", () => {
    expect(summariseRow(ROWS[0]).tenureMonths).toBe(2.5);
  });

  it("summariseProduct never includes a row of the other product", () => {
    const gr = summariseProduct("guaranteed_rent", ROWS.filter((r) => r.leadType === "guaranteed_rent"), NOW);
    expect(gr.customers).toBe(1);
    expect(gr.churnedNeverPaid).toBe(0);
  });
});
