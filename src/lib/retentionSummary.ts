/**
 * The retention summary JARVIS reads (§74) — the SHAPING only. No reads
 * (retentionData.ts) and no arithmetic (retention.ts); this file decides which
 * of the page's figures leave the building and under which names, so it is a
 * pure unit under vitest.config.mts's "PURE UNITS ONLY" rule, like
 * serviceHealth.ts and retention.ts itself.
 *
 * ⚠️ EVERY ROW IS BUILT FIELD BY FIELD. NEVER `{ ...row }`.
 * docs/public-api-phase1.md §0 records that the failure which actually ships
 * is a spread putting an internal column into a contract. LifecycleRow carries
 * `customerId`, `key`, `tenureAnchor`, `reasonRaw` and `reasonSource` — none
 * of them leave here. SUMMARY_ROW_KEYS is the whitelist and the test pins it.
 *
 * ⚠️ Per product, never per customer (invariant 6 / §18A). A customer on both
 * products is two rows here as it is on /admin/retention.
 *
 * The consumer is ZacStayful/Jarvis (`lib/retention/lead-db.ts`); its types
 * mirror these. Change a name here and change it there.
 */

import {
  LEAD_TYPES,
  LIFECYCLE_STATE_LABELS,
  REASON_THEME_LABELS,
  RETENTION_CHECKPOINTS,
  bandLabel,
  bandedMrr,
  churnedBeforePaying,
  dataQuality,
  isChurned,
  productLabel,
  reasonCrossTab,
  renewalRetention,
  type LifecycleRow,
  type LifecycleState,
  type ReasonTheme,
  type TenureBandKey,
  type TenureBasis,
} from "@/lib/retention";
import type { RetentionData } from "@/lib/retentionData";
import type { LeadType } from "@/lib/types";

export interface RetentionSummaryCheckpoint {
  months: number;
  label: string;
  eligible: number;
  renewed: number;
  churned: number;
  unclear: number;
  paused: number;
  /** renewed / eligible as a 0–1 share; null when suppressed (< MIN_COHORT) or nothing eligible. */
  pct: number | null;
  suppressed: boolean;
  measurableFrom: string | null;
}

export interface RetentionSummaryProduct {
  leadType: LeadType;
  label: string;
  /** Lifecycle rows for this product. */
  customers: number;
  active: number;
  paused: number;
  cancelling: number;
  /** Ever paid a subscription invoice — the churn denominator. */
  payingEver: number;
  /** Paid at least once, then left (cancelled or written off). */
  churned: number;
  /** Left having never paid. Reported apart; never in the rate (§70.5). */
  churnedNeverPaid: number;
  /** churned / payingEver as a percentage (1 dp); null when nobody has paid. */
  churnRatePct: number | null;
  mrr: {
    totalPence: number;
    stablePence: number;
    stableSharePct: number | null;
    pausedPence: number;
    pausedCustomers: number;
    bands: Array<{ band: TenureBandKey; label: string; customers: number; pence: number }>;
  };
  retention: RetentionSummaryCheckpoint[];
  reasons: Array<{ theme: ReasonTheme; label: string; count: number }>;
}

export interface RetentionSummaryRow {
  businessName: string;
  email: string;
  leadType: LeadType;
  state: LifecycleState;
  stateLabel: string;
  tenureBasis: TenureBasis;
  firstPaidAt: string | null;
  endedAt: string | null;
  endKind: "cancelled" | "lapsed" | null;
  cancelEffectiveAt: string | null;
  pausedAt: string | null;
  tenureMonths: number;
  band: TenureBandKey;
  invoicesPaid: number;
  mrrPence: number;
  reasonThemes: ReasonTheme[];
  reasonLabels: string[];
  reasonNote: string | null;
}

/** The only keys a lifecycle row may carry out. Pinned by the test. */
export const SUMMARY_ROW_KEYS: ReadonlyArray<keyof RetentionSummaryRow> = [
  "businessName",
  "email",
  "leadType",
  "state",
  "stateLabel",
  "tenureBasis",
  "firstPaidAt",
  "endedAt",
  "endKind",
  "cancelEffectiveAt",
  "pausedAt",
  "tenureMonths",
  "band",
  "invoicesPaid",
  "mrrPence",
  "reasonThemes",
  "reasonLabels",
  "reasonNote",
];

export interface RetentionSummary {
  asOf: string;
  /** The core customers/payments read failed; products and lifecycle are empty. */
  unavailable: boolean;
  /** Supporting reads that failed; the figures here are still good. */
  partial: string[];
  quality: {
    invoiceBacked: number;
    signupEstimated: number;
    neverPaid: number;
    cohorts: number;
    earliestFirstPaid: string | null;
    maxTenureMonths: number;
  };
  products: RetentionSummaryProduct[];
  lifecycle: RetentionSummaryRow[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function summariseRow(row: LifecycleRow): RetentionSummaryRow {
  return {
    businessName: row.businessName,
    email: row.email,
    leadType: row.leadType,
    state: row.state,
    stateLabel: LIFECYCLE_STATE_LABELS[row.state],
    tenureBasis: row.tenureBasis,
    firstPaidAt: row.firstPaidAt,
    endedAt: row.endedAt,
    endKind: row.endKind,
    cancelEffectiveAt: row.cancelEffectiveAt,
    pausedAt: row.pausedAt,
    tenureMonths: round1(row.tenureMonths),
    band: row.band,
    invoicesPaid: row.invoicesPaid,
    mrrPence: row.mrrPence,
    reasonThemes: [...row.reasonThemes],
    reasonLabels: row.reasonThemes.map((t) => REASON_THEME_LABELS[t]),
    reasonNote: row.reasonNote,
  };
}

export function summariseProduct(
  leadType: LeadType,
  rows: readonly LifecycleRow[],
  asOf: Date
): RetentionSummaryProduct {
  const payingEver = rows.filter((r) => r.firstPaidAt !== null).length;
  const churned = rows.filter((r) => isChurned(r) && r.firstPaidAt !== null).length;
  const mrr = bandedMrr(rows);
  const reasons = reasonCrossTab(rows);

  return {
    leadType,
    label: productLabel(leadType),
    customers: rows.length,
    active: rows.filter((r) => r.state === "active").length,
    paused: rows.filter((r) => r.state === "paused").length,
    cancelling: rows.filter((r) => r.state === "cancelling").length,
    payingEver,
    churned,
    churnedNeverPaid: churnedBeforePaying(rows).length,
    churnRatePct: payingEver > 0 ? round1((churned / payingEver) * 100) : null,
    mrr: {
      totalPence: mrr.totalPence,
      stablePence: mrr.stablePence,
      stableSharePct: mrr.stableSharePct,
      pausedPence: mrr.pausedPence,
      pausedCustomers: mrr.pausedCustomers,
      bands: mrr.entries.map((e) => ({
        band: e.band,
        label: bandLabel(e.band),
        customers: e.customers,
        pence: e.pence,
      })),
    },
    retention: RETENTION_CHECKPOINTS.map((checkpoint) => {
      const r = renewalRetention(rows, checkpoint, asOf);
      return {
        months: checkpoint.months,
        label: checkpoint.label,
        eligible: r.eligible,
        renewed: r.renewed,
        churned: r.churned,
        unclear: r.unclear,
        paused: r.paused,
        pct: r.pct,
        suppressed: r.suppressed,
        measurableFrom: r.measurableFrom,
      };
    }),
    reasons: reasons.rows.map((cell) => ({
      theme: cell.theme,
      label: REASON_THEME_LABELS[cell.theme],
      count: cell.total,
    })),
  };
}

export function summariseRetention(
  data: Pick<RetentionData, "asOf" | "lifecycle" | "unavailable" | "partial">,
  asOf: Date
): RetentionSummary {
  const lifecycle = data.unavailable ? [] : data.lifecycle;
  const quality = dataQuality(lifecycle);

  return {
    asOf: data.asOf,
    unavailable: data.unavailable,
    partial: [...data.partial],
    quality: {
      invoiceBacked: quality.invoiceBacked,
      signupEstimated: quality.signupEstimated,
      neverPaid: quality.neverPaid,
      cohorts: quality.cohorts,
      earliestFirstPaid: quality.earliestFirstPaid,
      maxTenureMonths: round1(quality.maxTenureMonths),
    },
    // Only products with customers, as /admin/retention renders them.
    products: LEAD_TYPES.map((leadType) => ({
      leadType,
      rows: lifecycle.filter((r) => r.leadType === leadType),
    }))
      .filter((p) => p.rows.length > 0)
      .map((p) => summariseProduct(p.leadType, p.rows, asOf)),
    lifecycle: lifecycle.map(summariseRow),
  };
}
