/**
 * Churn, retention and income stability arithmetic.
 *
 * WHAT BREAKS IN PRODUCTION IF THESE FAIL
 * ---------------------------------------
 * /admin/retention is the page the business reads to decide whether customers
 * are leaving and whether the income is stable. Every figure on it is computed
 * here, so a fault in this file is a wrong number an owner acts on — and none of
 * it is visible as an error: a retention rate built on the wrong denominator, or
 * a churn filed under the wrong reason, looks exactly like a fact.
 *
 * Six assertions below are load-bearing enough to have been MUTATION-TESTED
 * before being kept (this codebase records seven assertions that were once
 * written weak enough to survive the very mutation they existed to catch —
 * CLAUDE.md §50.9 twice, §53, §55, §57, §65). They are marked ⚠️ MUTATION.
 */

import { describe, it, expect } from "vitest";
import {
  TENURE_BANDS,
  MIN_COHORT,
  RETENTION_CHECKPOINTS,
  OUR_KEY_TO_THEME,
  STRIPE_FEEDBACK_TO_THEME,
  bandForMonths,
  monthsBetween,
  addMonthsYmd,
  daysBetweenYmd,
  londonYmdOf,
  productOfPaymentType,
  buildLifecycle,
  renewalRetention,
  churnedBeforePaying,
  bandedMrr,
  mrrInForceDaily,
  revenueMovement,
  reasonCrossTab,
  engagementComparison,
  approachingCheckpoint,
  dataQuality,
  visibleMilestones,
  type CustomerLifecycleInput,
  type PaymentInput,
  type CancellationInput,
  type PauseInput,
  type EngagementInput,
} from "../retention";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-24T10:00:00Z");

function customer(over: Partial<CustomerLifecycleInput> = {}): CustomerLifecycleInput {
  return {
    id: "c1",
    business_name: "Acme Lettings",
    email: "acme@example.com",
    created_at: "2026-07-01T09:00:00Z",
    is_active: true,
    account_status: "active",
    subscription_status: "active",
    gr_subscription_status: "inactive",
    paused_at: null,
    pause_resumes_at: null,
    cancelled_at: null,
    gr_cancelled_at: null,
    lapsed_at: null,
    gr_lapsed_at: null,
    cancel_at_period_end: false,
    gr_cancel_at_period_end: false,
    cancel_effective_at: null,
    gr_cancel_effective_at: null,
    cancellation_feedback: null,
    cancellation_comment: null,
    ...over,
  };
}

function pay(over: Partial<PaymentInput> = {}): PaymentInput {
  return {
    customer_id: "c1",
    payment_type: "subscription",
    status: "paid",
    amount_pence: 15_000,
    created_at: "2026-08-08T13:18:00Z",
    ...over,
  };
}

function build(
  customers: CustomerLifecycleInput[],
  payments: PaymentInput[] = [],
  cancellations: CancellationInput[] = [],
  pauses: PauseInput[] = [],
  asOf: Date = NOW
) {
  return buildLifecycle({ customers, payments, cancellations, pauses, asOf });
}

/** The real production shape: one invoice paid, cancelled at exactly 31 days. */
const ONE_CYCLE_CHURNER = {
  customers: [
    customer({
      id: "churn31",
      account_status: "cancelled",
      subscription_status: "canceled",
      cancelled_at: "2026-09-08T13:19:00Z",
      cancellation_feedback: "other",
      cancellation_comment: "Pausing for the moment",
    }),
  ],
  payments: [pay({ customer_id: "churn31", created_at: "2026-08-08T13:18:00Z" })],
};

// ---------------------------------------------------------------------------

describe("date arithmetic", () => {
  it("bands on half-open bounds so every value lands in exactly one", () => {
    expect(bandForMonths(0)).toBe("m0_1");
    expect(bandForMonths(0.99)).toBe("m0_1");
    expect(bandForMonths(1)).toBe("m1_3");
    expect(bandForMonths(2.99)).toBe("m1_3");
    expect(bandForMonths(3)).toBe("m3_6");
    expect(bandForMonths(5.99)).toBe("m3_6");
    // The boundary the plan calls out: month 6.0 is m6_12, never m3_6.
    expect(bandForMonths(6)).toBe("m6_12");
    expect(bandForMonths(11.99)).toBe("m6_12");
    expect(bandForMonths(12)).toBe("m12_plus");
    expect(bandForMonths(400)).toBe("m12_plus");
  });

  it("treats a negative or non-finite month count as zero", () => {
    expect(bandForMonths(-5)).toBe("m0_1");
    expect(bandForMonths(Number.NaN)).toBe("m0_1");
  });

  it("every band is reachable and the bounds are contiguous", () => {
    const keys = TENURE_BANDS.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (let i = 1; i < TENURE_BANDS.length; i += 1) {
      expect(TENURE_BANDS[i].fromMonths).toBe(TENURE_BANDS[i - 1].toMonths);
    }
    expect(TENURE_BANDS[TENURE_BANDS.length - 1].toMonths).toBeNull();
  });

  it("measures whole calendar months exactly, not in 30.44-day steps", () => {
    // ⚠️ MUTATION: the production case. 8 Aug → 8 Sep is 31 DAYS but exactly
    // ONE MONTH; a ms/30.44 implementation returns 1.018 and a /30 one 1.033.
    expect(monthsBetween("2026-08-08T13:18:00Z", "2026-09-08T13:19:00Z")).toBe(1);
    expect(monthsBetween("2026-02-10T00:00:00Z", "2026-03-10T00:00:00Z")).toBe(1);
    expect(monthsBetween("2026-01-31T00:00:00Z", "2026-07-31T00:00:00Z")).toBe(6);
  });

  it("returns a fraction part-way through an anniversary month", () => {
    const m = monthsBetween("2026-08-08T00:00:00Z", "2026-09-23T00:00:00Z");
    expect(m).toBeGreaterThan(1.4);
    expect(m).toBeLessThan(1.6);
  });

  it("is zero when reversed or identical", () => {
    expect(monthsBetween("2026-09-01T00:00:00Z", "2026-08-01T00:00:00Z")).toBe(0);
    expect(monthsBetween("2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z")).toBe(0);
  });

  it("anchors on Europe/London, not UTC, across both clock changes", () => {
    // BST: 23:30 UTC on 31 July is 00:30 on 1 August in London.
    expect(londonYmdOf("2026-07-31T23:30:00Z")).toBe("2026-08-01");
    // GMT: the same wall-clock time in winter does NOT roll over.
    expect(londonYmdOf("2026-01-31T23:30:00Z")).toBe("2026-01-31");
    // Either side of the spring forward.
    expect(londonYmdOf("2026-03-28T23:30:00Z")).toBe("2026-03-28");
    expect(londonYmdOf("2026-03-29T23:30:00Z")).toBe("2026-03-30");
    // Either side of the autumn back.
    expect(londonYmdOf("2026-10-24T23:30:00Z")).toBe("2026-10-25");
    expect(londonYmdOf("2026-10-25T23:30:00Z")).toBe("2026-10-25");
  });

  it("clamps a month addition to the end of a shorter month", () => {
    expect(addMonthsYmd("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsYmd("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsYmd("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonthsYmd("2026-12-15", 1)).toBe("2027-01-15");
  });

  it("counts calendar days across a DST boundary without losing one", () => {
    expect(daysBetweenYmd("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetweenYmd("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetweenYmd("2026-08-08", "2026-09-08")).toBe(31);
  });
});

describe("product attribution", () => {
  it("reads the product off payment_type, never lead_type", () => {
    expect(productOfPaymentType("subscription")).toBe("management");
    expect(productOfPaymentType("gr_subscription")).toBe("guaranteed_rent");
    expect(productOfPaymentType("topup")).toBeNull();
    expect(productOfPaymentType("lead_analysis")).toBeNull();
    expect(productOfPaymentType(null)).toBeNull();
  });
});

describe("buildLifecycle", () => {
  it("creates a row per product the customer has ever held, and no others", () => {
    const rows = build([customer()], [pay()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].leadType).toBe("management");
    expect(rows[0].key).toBe("c1:management");
  });

  it("gives a waitlisted prospect who never paid no row at all", () => {
    const rows = build([
      customer({ account_status: "waitlisted", subscription_status: "inactive" }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it("recognises a GR-only subscriber sitting at account_status waitlisted", () => {
    // The §18A end state: GR-only customers are waitlisted for management for
    // ever, so a management-column read would miss them entirely.
    const rows = build(
      [
        customer({
          account_status: "waitlisted",
          subscription_status: "inactive",
          gr_subscription_status: "active",
        }),
      ],
      [pay({ payment_type: "gr_subscription" })]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].leadType).toBe("guaranteed_rent");
  });

  it("accepts BOTH spellings of cancelled across the two column families", () => {
    // ⚠️ account_status uses British "cancelled"; subscription_status uses
    // Stripe's American "canceled". Testing one drops everyone in the other.
    const british = build([
      customer({ account_status: "cancelled", subscription_status: "inactive" }),
    ]);
    const american = build([
      customer({ account_status: "waitlisted", subscription_status: "canceled" }),
    ]);
    expect(british).toHaveLength(1);
    expect(american).toHaveLength(1);
  });

  it("excludes top-ups and lead analysis from the invoice count and the price", () => {
    // ⚠️ MUTATION: a top-up is one-off income. Counted as a subscription invoice
    // it fakes a renewal, and as the price it rewrites MRR to £75.
    const rows = build(
      [customer()],
      [
        pay({ created_at: "2026-08-08T00:00:00Z", amount_pence: 15_000 }),
        pay({ payment_type: "topup", amount_pence: 7_500, created_at: "2026-09-01T00:00:00Z" }),
        pay({ payment_type: "lead_analysis", amount_pence: 300, created_at: "2026-09-02T00:00:00Z" }),
      ]
    );
    expect(rows[0].invoicesPaid).toBe(1);
    expect(rows[0].mrrPence).toBe(15_000);
  });

  it("ignores a failed payment when counting invoices", () => {
    const rows = build(
      [customer()],
      [
        pay({ created_at: "2026-08-08T00:00:00Z" }),
        pay({ created_at: "2026-09-08T00:00:00Z", status: "failed" }),
      ]
    );
    expect(rows[0].invoicesPaid).toBe(1);
  });

  it("prices MRR from the LATEST paid invoice, so a downgrade is reflected", () => {
    const rows = build(
      [customer()],
      [
        pay({ created_at: "2026-07-24T00:00:00Z", amount_pence: 30_000 }),
        pay({ created_at: "2026-08-24T00:00:00Z", amount_pence: 15_000 }),
      ]
    );
    expect(rows[0].mrrPence).toBe(15_000);
  });

  it("marks a churner with no invoice as never_paid rather than guessing", () => {
    const rows = build([
      customer({
        id: "nopay",
        account_status: "cancelled",
        subscription_status: "canceled",
        cancelled_at: "2026-09-23T12:32:00Z",
      }),
    ]);
    expect(rows[0].tenureBasis).toBe("never_paid");
    expect(rows[0].firstPaidAt).toBeNull();
    expect(rows[0].invoicesPaid).toBe(0);
  });

  it("marks a live subscription with no invoice as signup_estimated", () => {
    const rows = build([customer()]);
    expect(rows[0].tenureBasis).toBe("signup_estimated");
    expect(rows[0].tenureAnchor).toBe("2026-07-01T09:00:00Z");
  });

  it("resolves state in precedence order", () => {
    const lapsed = build([customer({ lapsed_at: "2026-09-01T00:00:00Z" })], [pay()]);
    expect(lapsed[0].state).toBe("lapsed");
    const cancelled = build([customer({ cancelled_at: "2026-09-01T00:00:00Z" })], [pay()]);
    expect(cancelled[0].state).toBe("cancelled");
    const paused = build([customer({ paused_at: "2026-08-17T00:00:00Z" })], [pay()]);
    expect(paused[0].state).toBe("paused");
    const cancelling = build(
      [customer({ cancel_at_period_end: true, cancel_effective_at: "2026-09-28T00:00:00Z" })],
      [pay()]
    );
    expect(cancelling[0].state).toBe("cancelling");
    expect(cancelling[0].cancelEffectiveAt).toBe("2026-09-28T00:00:00Z");
    expect(build([customer()], [pay()])[0].state).toBe("active");
  });

  it("takes the earlier of a cancellation and a write-off as the end", () => {
    const rows = build(
      [
        customer({
          cancelled_at: "2026-09-10T00:00:00Z",
          lapsed_at: "2026-09-02T00:00:00Z",
        }),
      ],
      [pay()]
    );
    expect(rows[0].endedAt).toBe("2026-09-02T00:00:00Z");
    expect(rows[0].endKind).toBe("lapsed");
  });

  it("never reads paused_at on the GR side (invariant 6)", () => {
    const rows = build(
      [
        customer({
          gr_subscription_status: "active",
          paused_at: "2026-08-17T00:00:00Z",
        }),
      ],
      [pay({ payment_type: "gr_subscription" })]
    );
    const gr = rows.find((r) => r.leadType === "guaranteed_rent");
    expect(gr?.pausedAt).toBeNull();
    expect(gr?.state).toBe("active");
  });

  it("puts the one-cycle churner at exactly one month of tenure", () => {
    const rows = build(ONE_CYCLE_CHURNER.customers, ONE_CYCLE_CHURNER.payments);
    expect(rows[0].tenureMonths).toBe(1);
    expect(rows[0].band).toBe("m1_3");
    expect(rows[0].invoicesPaid).toBe(1);
  });
});

describe("reason resolution", () => {
  const ended = {
    id: "c1",
    account_status: "cancelled",
    subscription_status: "canceled",
    cancelled_at: "2026-09-13T11:06:00Z",
  } as Partial<CustomerLifecycleInput>;

  function cancellation(over: Partial<CancellationInput> = {}): CancellationInput {
    return {
      customer_id: "c1",
      lead_type: "management",
      reasons: ["lead_quality"],
      note: null,
      stripe_feedback: "low_quality",
      requested_at: "2026-08-24T09:18:00Z",
      reverted_at: null,
      ...over,
    };
  }

  it("prefers our own cancel form over Stripe's feedback", () => {
    const rows = build(
      [customer({ ...ended, cancellation_feedback: "too_expensive" })],
      [pay()],
      [cancellation({ reasons: ["lead_quality"] })]
    );
    expect(rows[0].reasonSource).toBe("cancellation_row");
    expect(rows[0].reasonThemes).toEqual(["lead_quality"]);
  });

  it("falls back to Stripe's feedback when a portal cancellation left no row", () => {
    // 2 of the 6 real cancellation events are this shape.
    const rows = build([customer({ ...ended, cancellation_feedback: "other" })], [pay()]);
    expect(rows[0].reasonSource).toBe("stripe_feedback");
    expect(rows[0].reasonThemes).toEqual(["not_recorded"]);
    expect(rows[0].reasonRaw).toEqual(["other"]);
  });

  it("⚠️ MUTATION: keeps Stripe's low_quality in its own ambiguous theme", () => {
    // CANCEL_REASON_TO_STRIPE_FEEDBACK sends BOTH lead_quality and
    // not_enough_leads to Stripe as low_quality, so a Stripe-only row cannot say
    // which. Collapsing it into lead_quality invents a sourcing problem out of a
    // supply problem.
    const rows = build([customer({ ...ended, cancellation_feedback: "low_quality" })], [pay()]);
    expect(rows[0].reasonThemes).toEqual(["lead_quality_or_volume"]);
    expect(rows[0].reasonThemes).not.toContain("lead_quality");
    expect(STRIPE_FEEDBACK_TO_THEME.low_quality).toBe("lead_quality_or_volume");
  });

  it("ignores a reverted cancellation row and a row for the other product", () => {
    const reverted = build(
      [customer(ended)],
      [pay()],
      [cancellation({ reverted_at: "2026-08-25T00:00:00Z" })]
    );
    expect(reverted[0].reasonSource).toBe("none");
    const otherProduct = build(
      [customer(ended)],
      [pay()],
      [cancellation({ lead_type: "guaranteed_rent" })]
    );
    expect(otherProduct[0].reasonSource).toBe("none");
  });

  it("uses a recent pause reason when nothing else was stated", () => {
    const rows = build(
      [customer({ ...ended, cancelled_at: "2026-09-23T12:32:00Z" })],
      [pay()],
      [],
      [
        {
          customer_id: "c1",
          reasons: ["at_capacity"],
          note: "swamped",
          months: 3,
          paused_at: "2026-08-17T00:00:00Z",
          resumes_at: "2026-11-17T00:00:00Z",
          ended_at: null,
        },
      ]
    );
    expect(rows[0].reasonSource).toBe("pause_reason");
    expect(rows[0].reasonThemes).toEqual(["own_capacity"]);
    expect(rows[0].reasonNote).toBe("swamped");
  });

  it("ignores a pause taken far too long before the cancellation", () => {
    const rows = build(
      [customer({ ...ended, cancelled_at: "2026-09-23T12:32:00Z" })],
      [pay()],
      [],
      [
        {
          customer_id: "c1",
          reasons: ["at_capacity"],
          note: null,
          months: 3,
          paused_at: "2025-01-01T00:00:00Z",
          resumes_at: null,
          ended_at: null,
        },
      ]
    );
    expect(rows[0].reasonSource).toBe("none");
  });

  it("⚠️ MUTATION: files a write-off as payment_failed, not not_recorded", () => {
    // A write-off is churn with no stated reason, and that IS the finding.
    // Folding it into not_recorded files a billing failure as a silent departure.
    const rows = build([customer({ lapsed_at: "2026-09-05T00:00:00Z" })], [pay()]);
    expect(rows[0].reasonThemes).toEqual(["payment_failed"]);
    expect(rows[0].reasonSource).toBe("write_off");
  });

  it("records no reason at all for a customer who has not left", () => {
    const rows = build([customer()], [pay()]);
    expect(rows[0].reasonThemes).toEqual([]);
    expect(rows[0].reasonSource).toBe("none");
  });

  it("maps the four shared pause/cancel keys identically", () => {
    // cancelOptions.ts:11-15 records that these four are deliberately the same
    // string in both vocabularies so the two signals can be counted together.
    for (const key of ["too_expensive", "not_enough_leads", "lead_quality", "at_capacity"]) {
      expect(OUR_KEY_TO_THEME[key]).toBeDefined();
    }
    expect(OUR_KEY_TO_THEME.not_enough_leads).toBe("lead_volume");
    expect(OUR_KEY_TO_THEME.lead_quality).toBe("lead_quality");
    expect(OUR_KEY_TO_THEME.unknown_pre_0077).toBe("not_recorded");
  });
});

describe("renewalRetention", () => {
  const oneMonth = RETENTION_CHECKPOINTS[0];
  const threeMonth = RETENTION_CHECKPOINTS[1];
  const sixMonth = RETENTION_CHECKPOINTS[2];

  /** n customers who first paid `monthsAgo` and have paid `invoices` in total. */
  function cohort(n: number, firstPaid: string, invoices: number, endedAt?: string) {
    const customers: CustomerLifecycleInput[] = [];
    const payments: PaymentInput[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = `c${firstPaid}-${i}`;
      customers.push(
        customer({
          id,
          cancelled_at: endedAt ?? null,
          account_status: endedAt ? "cancelled" : "active",
          subscription_status: endedAt ? "canceled" : "active",
        })
      );
      for (let k = 0; k < invoices; k += 1) {
        payments.push({
          customer_id: id,
          payment_type: "subscription",
          status: "paid",
          amount_pence: 15_000,
          created_at: addMonthsYmd(firstPaid, k) + "T12:00:00Z",
        });
      }
    }
    return { customers, payments };
  }

  it("⚠️ MUTATION: only counts customers who had the OPPORTUNITY to renew", () => {
    // A customer who first paid 20 days ago cannot tell you anything about the
    // 3-month checkpoint. Counting them puts them in the denominator as a
    // failure and understates retention permanently.
    const fresh = cohort(6, "2026-09-04", 1);
    const at1 = renewalRetention(build(fresh.customers, fresh.payments), oneMonth, NOW);
    const at3 = renewalRetention(build(fresh.customers, fresh.payments), threeMonth, NOW);
    expect(at1.eligible).toBe(0);
    expect(at3.eligible).toBe(0);
    expect(at3.churned).toBe(0);
  });

  it("⚠️ MUTATION: withholds the percentage below MIN_COHORT rather than printing one", () => {
    // Fewer than MIN_COHORT is a report on named individuals with the names
    // removed, and it reads as a rate when it is not one. null, never 0.
    const thin = cohort(MIN_COHORT - 1, "2026-06-01", 1, "2026-07-02T00:00:00Z");
    const result = renewalRetention(build(thin.customers, thin.payments), oneMonth, NOW);
    expect(result.eligible).toBe(MIN_COHORT - 1);
    expect(result.suppressed).toBe(true);
    expect(result.pct).toBeNull();
    expect(result.pct).not.toBe(0);
  });

  it("publishes the percentage at MIN_COHORT and above", () => {
    const wide = cohort(MIN_COHORT, "2026-06-01", 3);
    const result = renewalRetention(build(wide.customers, wide.payments), oneMonth, NOW);
    expect(result.eligible).toBe(MIN_COHORT);
    expect(result.suppressed).toBe(false);
    expect(result.pct).toBe(1);
  });

  it("names the date a not-yet-measurable checkpoint becomes measurable", () => {
    const fresh = cohort(3, "2026-08-08", 2);
    const result = renewalRetention(build(fresh.customers, fresh.payments), sixMonth, NOW);
    expect(result.eligible).toBe(0);
    expect(result.measurableFrom).toBe("2027-02-08");
  });

  it("⚠️ MUTATION: keeps `unclear` out of `renewed` when an invoice failed", () => {
    // Seven failed subscription payments exist in the book. A customer who is
    // eligible, still with us, and whose next invoice has not cleared is neither
    // renewed nor churned — counting them as renewed inflates retention.
    const customers = [customer({ id: "stuck" })];
    const payments = [
      pay({ customer_id: "stuck", created_at: "2026-08-01T00:00:00Z" }),
      pay({ customer_id: "stuck", created_at: "2026-09-01T00:00:00Z", status: "failed" }),
    ];
    const result = renewalRetention(build(customers, payments), oneMonth, NOW);
    expect(result.eligible).toBe(1);
    expect(result.renewed).toBe(0);
    expect(result.churned).toBe(0);
    expect(result.unclear).toBe(1);
  });

  it("⚠️ MUTATION: takes a paused customer OUT of the denominator", () => {
    // Stripe voids a paused subscription's invoices, so WE are the reason the
    // renewal never landed. Counting them as `unclear` blames a payment failure
    // that never happened and understates retention by the size of the paused
    // book — six of nineteen live management subscriptions when this shipped.
    const customers = [customer({ id: "held", paused_at: "2026-08-20T00:00:00Z" })];
    const payments = [pay({ customer_id: "held", created_at: "2026-08-01T00:00:00Z" })];
    const result = renewalRetention(build(customers, payments), oneMonth, NOW);
    expect(result.paused).toBe(1);
    expect(result.eligible).toBe(0);
    expect(result.unclear).toBe(0);
    expect(result.churned).toBe(0);
  });

  it("still counts a customer who renewed and THEN paused as renewed", () => {
    // The pause only removes a checkpoint they had not already cleared.
    const customers = [customer({ id: "held", paused_at: "2026-09-10T00:00:00Z" })];
    const payments = [
      pay({ customer_id: "held", created_at: "2026-07-01T00:00:00Z" }),
      pay({ customer_id: "held", created_at: "2026-08-01T00:00:00Z" }),
    ];
    const result = renewalRetention(build(customers, payments), oneMonth, NOW);
    expect(result.renewed).toBe(1);
    expect(result.eligible).toBe(1);
    expect(result.paused).toBe(0);
  });

  it("counts the one-cycle churner as churned at the 1-month checkpoint", () => {
    const rows = build(ONE_CYCLE_CHURNER.customers, ONE_CYCLE_CHURNER.payments);
    const result = renewalRetention(rows, oneMonth, NOW);
    expect(result.eligible).toBe(1);
    expect(result.renewed).toBe(0);
    expect(result.churned).toBe(1);
    expect(result.unclear).toBe(0);
  });

  it("excludes a never-paid churner from every checkpoint and reports it apart", () => {
    const rows = build([
      customer({
        id: "nopay",
        account_status: "cancelled",
        subscription_status: "canceled",
        cancelled_at: "2026-09-23T12:32:00Z",
      }),
    ]);
    for (const checkpoint of RETENTION_CHECKPOINTS) {
      const result = renewalRetention(rows, checkpoint, NOW);
      expect(result.eligible).toBe(0);
      expect(result.churned).toBe(0);
    }
    expect(churnedBeforePaying(rows)).toHaveLength(1);
  });

  it("pairs each month checkpoint with the invoice that clears it", () => {
    expect(RETENTION_CHECKPOINTS.map((c) => [c.months, c.invoice])).toEqual([
      [1, 2],
      [3, 4],
      [6, 7],
      [12, 13],
    ]);
  });
});

describe("bandedMrr", () => {
  it("bands live revenue and reports the stable share", () => {
    const rows = build(
      [
        customer({ id: "old" }),
        customer({ id: "new", created_at: "2026-09-20T00:00:00Z" }),
      ],
      [
        pay({ customer_id: "old", created_at: "2026-01-08T00:00:00Z", amount_pence: 30_000 }),
        pay({ customer_id: "new", created_at: "2026-09-20T00:00:00Z", amount_pence: 15_000 }),
      ]
    );
    const mrr = bandedMrr(rows);
    expect(mrr.totalPence).toBe(45_000);
    expect(mrr.customers).toBe(2);
    expect(mrr.stablePence).toBe(30_000);
    expect(mrr.stableSharePct).toBeCloseTo(30_000 / 45_000);
  });

  it("⚠️ MUTATION: reports paused revenue BESIDE the total, never inside it", () => {
    // A paused customer is billing £0 — Stripe is voiding their invoices. Adding
    // them shows headroom and revenue that nobody is collecting (§21's "always
    // two numbers, never one").
    const rows = build(
      [
        customer({ id: "live" }),
        customer({ id: "onhold", paused_at: "2026-08-17T00:00:00Z" }),
      ],
      [
        pay({ customer_id: "live", created_at: "2026-08-01T00:00:00Z" }),
        pay({ customer_id: "onhold", created_at: "2026-08-01T00:00:00Z" }),
      ]
    );
    const mrr = bandedMrr(rows);
    expect(mrr.totalPence).toBe(15_000);
    expect(mrr.customers).toBe(1);
    expect(mrr.pausedPence).toBe(15_000);
    expect(mrr.pausedCustomers).toBe(1);
  });

  it("counts a pending cancellation as still paying", () => {
    const rows = build(
      [customer({ cancel_at_period_end: true })],
      [pay({ created_at: "2026-08-01T00:00:00Z" })]
    );
    expect(bandedMrr(rows).totalPence).toBe(15_000);
  });

  it("excludes a cancelled customer entirely", () => {
    const rows = build([customer({ cancelled_at: "2026-09-01T00:00:00Z" })], [pay()]);
    const mrr = bandedMrr(rows);
    expect(mrr.totalPence).toBe(0);
    expect(mrr.customers).toBe(0);
  });

  it("counts a live subscription with no invoice as unpriced rather than £0 revenue", () => {
    const mrr = bandedMrr(build([customer()]));
    expect(mrr.unpricedCustomers).toBe(1);
    expect(mrr.totalPence).toBe(0);
  });

  it("returns a null stable share rather than dividing by zero", () => {
    expect(bandedMrr([]).stableSharePct).toBeNull();
  });
});

describe("mrrInForceDaily", () => {
  it("runs a point per London day from the first invoice to today", () => {
    const payments = [pay({ created_at: "2026-09-20T09:00:00Z" })];
    const series = mrrInForceDaily(build([customer()], payments), payments, NOW);
    expect(series[0].date).toBe("2026-09-20");
    expect(series[series.length - 1].date).toBe("2026-09-24");
    expect(series).toHaveLength(5);
  });

  it("carries the latest invoice amount forward and picks up a downgrade", () => {
    const payments = [
      pay({ created_at: "2026-09-18T00:00:00Z", amount_pence: 30_000 }),
      pay({ created_at: "2026-09-22T00:00:00Z", amount_pence: 15_000 }),
    ];
    const series = mrrInForceDaily(build([customer()], payments), payments, NOW);
    const on = (d: string) => series.find((p) => p.date === d)?.totalPence;
    expect(on("2026-09-18")).toBe(30_000);
    expect(on("2026-09-21")).toBe(30_000);
    expect(on("2026-09-22")).toBe(15_000);
    expect(on("2026-09-24")).toBe(15_000);
  });

  it("drops a customer from the day they cancel", () => {
    const payments = [pay({ created_at: "2026-09-18T00:00:00Z" })];
    const rows = build([customer({ cancelled_at: "2026-09-21T00:00:00Z" })], payments);
    const series = mrrInForceDaily(rows, payments, NOW);
    expect(series.find((p) => p.date === "2026-09-20")?.totalPence).toBe(15_000);
    expect(series.find((p) => p.date === "2026-09-21")?.totalPence).toBe(0);
    expect(series.find((p) => p.date === "2026-09-24")?.totalPence).toBe(0);
  });

  it("⚠️ MUTATION: contributes nothing while a subscription is paused", () => {
    // Stripe voids a paused subscription's invoices, so counting it puts revenue
    // in the series that nobody collected.
    const payments = [pay({ created_at: "2026-09-18T00:00:00Z" })];
    const rows = build(
      [customer({ paused_at: "2026-09-21T00:00:00Z", pause_resumes_at: "2026-12-21T00:00:00Z" })],
      payments
    );
    const series = mrrInForceDaily(rows, payments, NOW);
    expect(series.find((p) => p.date === "2026-09-20")?.totalPence).toBe(15_000);
    expect(series.find((p) => p.date === "2026-09-22")?.totalPence).toBe(0);
    expect(series.find((p) => p.date === "2026-09-22")?.customers).toBe(0);
  });

  it("resumes a customer on the day their pause ends", () => {
    const payments = [pay({ created_at: "2026-09-18T00:00:00Z" })];
    const rows = build(
      [customer({ paused_at: "2026-09-19T00:00:00Z", pause_resumes_at: "2026-09-22T00:00:00Z" })],
      payments
    );
    const series = mrrInForceDaily(rows, payments, NOW);
    expect(series.find((p) => p.date === "2026-09-21")?.totalPence).toBe(0);
    expect(series.find((p) => p.date === "2026-09-22")?.totalPence).toBe(15_000);
  });

  it("splits the total across the band each customer was in that day", () => {
    const payments = [
      pay({ customer_id: "old", created_at: "2026-01-08T00:00:00Z", amount_pence: 30_000 }),
      pay({ customer_id: "new", created_at: "2026-09-22T00:00:00Z", amount_pence: 15_000 }),
    ];
    const rows = build(
      [customer({ id: "old" }), customer({ id: "new" })],
      payments
    );
    const series = mrrInForceDaily(rows, payments, NOW);
    const last = series[series.length - 1];
    expect(last.m6_12).toBe(30_000);
    expect(last.m0_1).toBe(15_000);
    expect(last.totalPence).toBe(45_000);
  });

  it("returns an empty series when nobody has ever paid", () => {
    expect(mrrInForceDaily(build([customer()]), [], NOW)).toEqual([]);
  });

  it("excludes top-ups from the series", () => {
    const payments = [
      pay({ created_at: "2026-09-22T00:00:00Z", amount_pence: 15_000 }),
      pay({ payment_type: "topup", created_at: "2026-09-23T00:00:00Z", amount_pence: 7_500 }),
    ];
    const series = mrrInForceDaily(build([customer()], payments), payments, NOW);
    expect(series[series.length - 1].totalPence).toBe(15_000);
  });
});

describe("revenueMovement", () => {
  it("separates upgrades from downgrades and nets them per month", () => {
    const months = revenueMovement([
      { customer_id: "a", lead_type: "management", from_allocation: 10, to_allocation: 20, applied_at: "2026-08-10T00:00:00Z" },
      { customer_id: "b", lead_type: "management", from_allocation: 20, to_allocation: 10, applied_at: "2026-08-20T00:00:00Z" },
      { customer_id: "c", lead_type: "management", from_allocation: 20, to_allocation: 10, applied_at: "2026-09-02T00:00:00Z" },
    ]);
    expect(months).toHaveLength(2);
    expect(months[0]).toMatchObject({ month: "2026-08", upPence: 15_000, downPence: 15_000, netPence: 0, upgrades: 1, downgrades: 1 });
    expect(months[1]).toMatchObject({ month: "2026-09", upPence: 0, downPence: 15_000, netPence: -15_000, downgrades: 1 });
  });

  it("ignores a change that never billed and one that moved no money", () => {
    const months = revenueMovement([
      { customer_id: "a", lead_type: "management", from_allocation: 10, to_allocation: 20, applied_at: null },
      { customer_id: "b", lead_type: "management", from_allocation: 10, to_allocation: 10, applied_at: "2026-08-10T00:00:00Z" },
    ]);
    expect(months).toEqual([]);
  });

  it("prices a GR change off the GR plan table", () => {
    const months = revenueMovement([
      { customer_id: "a", lead_type: "guaranteed_rent", from_allocation: 20, to_allocation: 10, applied_at: "2026-08-10T00:00:00Z" },
    ]);
    expect(months[0].downPence).toBe(15_000);
  });
});

describe("reasonCrossTab", () => {
  it("⚠️ MUTATION: counts each reason of a multi-reason cancellation once", () => {
    // reasons is a text[] and a customer may give several, so mentions exceed
    // events. Counting one reason per event silently drops the others.
    const rows = build(
      [
        customer({
          account_status: "cancelled",
          subscription_status: "canceled",
          cancelled_at: "2026-09-13T00:00:00Z",
        }),
      ],
      [pay()],
      [
        {
          customer_id: "c1",
          lead_type: "management",
          reasons: ["lead_quality", "too_expensive"],
          note: null,
          stripe_feedback: null,
          requested_at: "2026-09-01T00:00:00Z",
          reverted_at: null,
        },
      ]
    );
    const tab = reasonCrossTab(rows);
    expect(tab.events).toBe(1);
    expect(tab.mentions).toBe(2);
    expect(tab.rows.map((r) => r.theme).sort()).toEqual(["lead_quality", "price"]);
  });

  it("ignores customers who have not left", () => {
    const tab = reasonCrossTab(build([customer()], [pay()]));
    expect(tab.events).toBe(0);
    expect(tab.rows).toEqual([]);
  });

  it("places each churn in the band it reached", () => {
    const rows = build(ONE_CYCLE_CHURNER.customers, ONE_CYCLE_CHURNER.payments);
    const tab = reasonCrossTab(rows);
    expect(tab.rows[0].byBand.m1_3).toBe(1);
    expect(tab.rows[0].byBand.m0_1).toBe(0);
  });
});

describe("engagementComparison", () => {
  function snap(over: Partial<EngagementInput> = {}): EngagementInput {
    return {
      customer_id: "c1",
      lead_type: "management",
      captured_on: "2026-09-01",
      worked_rate: 0.5,
      open_rate: 0.8,
      contact_rate: 0.3,
      assignments_delivered: 10,
      assignments_worked: 5,
      days_since_last_activity: 2,
      ...over,
    };
  }

  it("⚠️ MUTATION: reads a churner's LAST snapshot BEFORE they left", () => {
    // Snapshots do not stop at cancellation — all six real churned customers
    // have rows through today. Picking "the latest row" reads their engagement
    // weeks after they left, when it is necessarily zero, and makes every
    // churner look disengaged.
    const rows = build(
      [
        customer({
          account_status: "cancelled",
          subscription_status: "canceled",
          cancelled_at: "2026-09-08T13:19:00Z",
        }),
      ],
      [pay()]
    );
    const comparison = engagementComparison(rows, [
      snap({ captured_on: "2026-09-07", worked_rate: 0.6, assignments_worked: 6 }),
      snap({ captured_on: "2026-09-20", worked_rate: 0, assignments_worked: 0 }),
      snap({ captured_on: "2026-09-24", worked_rate: 0, assignments_worked: 0 }),
    ]);
    expect(comparison.churned.customers).toBe(1);
    expect(comparison.churned.workedRate).toBe(0.6);
    expect(comparison.churned.worked).toBe(6);
  });

  it("reads a stayer's most recent snapshot", () => {
    const rows = build([customer()], [pay()]);
    const comparison = engagementComparison(rows, [
      snap({ captured_on: "2026-09-01", worked_rate: 0.1 }),
      snap({ captured_on: "2026-09-23", worked_rate: 0.9 }),
    ]);
    expect(comparison.stayed.customers).toBe(1);
    expect(comparison.stayed.workedRate).toBe(0.9);
    expect(comparison.churned.customers).toBe(0);
  });

  it("counts customers who were delivered leads and worked none", () => {
    const rows = build([customer()], [pay()]);
    const comparison = engagementComparison(rows, [
      snap({ assignments_delivered: 8, assignments_worked: 0 }),
    ]);
    expect(comparison.stayed.neverWorkedAny).toBe(1);
  });

  it("returns nulls rather than zero when there is nothing to average", () => {
    const comparison = engagementComparison(build([customer()], [pay()]), []);
    expect(comparison.stayed.workedRate).toBeNull();
    expect(comparison.stayed.customers).toBe(0);
  });

  it("never mixes one product's snapshots into the other's row", () => {
    const rows = build(
      [customer({ gr_subscription_status: "active" })],
      [pay(), pay({ payment_type: "gr_subscription", amount_pence: 15_000 })]
    );
    const comparison = engagementComparison(rows, [
      snap({ lead_type: "management", worked_rate: 1 }),
    ]);
    // Only the management row found a snapshot; the GR row contributes nothing.
    expect(comparison.stayed.customers).toBe(1);
    expect(comparison.stayed.workedRate).toBe(1);
  });
});

describe("approachingCheckpoint", () => {
  it("names who reaches a checkpoint inside the window", () => {
    const rows = build(
      [customer({ id: "soon" })],
      [pay({ customer_id: "soon", created_at: "2026-08-30T00:00:00Z" })]
    );
    const due = approachingCheckpoint(rows, NOW, 30);
    expect(due).toHaveLength(1);
    expect(due[0].checkpoint.months).toBe(1);
    expect(due[0].dueOn).toBe("2026-09-30");
    expect(due[0].daysAway).toBe(6);
  });

  it("excludes a checkpoint already passed and one beyond the window", () => {
    const rows = build(
      [customer({ id: "mid" })],
      [pay({ customer_id: "mid", created_at: "2026-08-01T00:00:00Z" })]
    );
    const due = approachingCheckpoint(rows, NOW, 30);
    // 1 month fell on 1 Sep (passed); 3 months falls on 1 Nov (too far).
    expect(due).toHaveLength(0);
  });

  it("never lists a customer who has already left", () => {
    const rows = build(
      [
        customer({
          id: "gone",
          account_status: "cancelled",
          cancelled_at: "2026-09-01T00:00:00Z",
        }),
      ],
      [pay({ customer_id: "gone", created_at: "2026-08-30T00:00:00Z" })]
    );
    expect(approachingCheckpoint(rows, NOW, 30)).toHaveLength(0);
  });

  it("lists a paused customer, whose renewal still arrives", () => {
    const rows = build(
      [customer({ id: "held", paused_at: "2026-09-01T00:00:00Z" })],
      [pay({ customer_id: "held", created_at: "2026-08-30T00:00:00Z" })]
    );
    expect(approachingCheckpoint(rows, NOW, 30)).toHaveLength(1);
  });
});

describe("dataQuality", () => {
  it("counts each tenure basis and the cohort depth", () => {
    const rows = build(
      [
        customer({ id: "paid" }),
        customer({ id: "livenopay" }),
        customer({
          id: "gonenopay",
          account_status: "cancelled",
          cancelled_at: "2026-09-01T00:00:00Z",
        }),
      ],
      [
        pay({ customer_id: "paid", created_at: "2026-07-24T00:00:00Z" }),
        pay({ customer_id: "paid", created_at: "2026-08-24T00:00:00Z" }),
      ]
    );
    const quality = dataQuality(rows);
    expect(quality.invoiceBacked).toBe(1);
    expect(quality.signupEstimated).toBe(1);
    expect(quality.neverPaid).toBe(1);
    expect(quality.cohorts).toBe(1);
    expect(quality.earliestFirstPaid).toBe("2026-07-24");
    expect(quality.maxTenureMonths).toBeGreaterThan(1.9);
  });

  it("counts one cohort per month in which somebody first paid", () => {
    const rows = build(
      [customer({ id: "a" }), customer({ id: "b" }), customer({ id: "c" })],
      [
        pay({ customer_id: "a", created_at: "2026-07-24T00:00:00Z" }),
        pay({ customer_id: "b", created_at: "2026-08-01T00:00:00Z" }),
        pay({ customer_id: "c", created_at: "2026-09-02T00:00:00Z" }),
      ]
    );
    expect(dataQuality(rows).cohorts).toBe(3);
  });
});

describe("visibleMilestones", () => {
  it("drops a marker outside the series so none can sit off the axis", () => {
    const payments = [pay({ created_at: "2026-09-20T00:00:00Z" })];
    const series = mrrInForceDaily(build([customer()], payments), payments, NOW);
    const markers = visibleMilestones(series);
    expect(markers.every((m) => m.date >= "2026-09-20" && m.date <= "2026-09-24")).toBe(true);
    expect(markers.some((m) => m.date === "2026-09-01")).toBe(false);
  });

  it("returns nothing for an empty series", () => {
    expect(visibleMilestones([])).toEqual([]);
  });
});
