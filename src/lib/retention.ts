/**
 * Churn, retention and income stability — ALL of the arithmetic, and none of the
 * reads.
 *
 * WHY EVERYTHING LIVES HERE
 * -------------------------
 * vitest.config.mts is "PURE UNITS ONLY — no network, no database, no React",
 * and `npm run build` runs the suite first. So an expression inlined in the page
 * or the chart component is an expression no test can reach. This is the split
 * serviceHealth.ts already makes for oversupplyShortfall() and
 * withdrawalBasisOf(), each with a docblock naming the test config as the
 * reason. Keep it: if a figure appears on /admin/retention, it is computed by an
 * exported function in this file.
 *
 * NO MIGRATION BACKS THIS FEATURE, AND THAT IS THE POINT
 * -----------------------------------------------------
 * Every other trend in this codebase is a snapshot that CANNOT be backfilled
 * (service_capacity_snapshots, customer_engagement_snapshots,
 * operator_proof_snapshots — all three carry a real 3-day hole from the §18.3
 * outage). This one is different: `payments` is a ledger of cleared invoices and
 * cancellation dates are stamped once and never moved, so the whole history
 * recomputes from scratch on every render, with no capture job and no hole.
 *
 * ⚠️ WHAT IS *NOT* RECONSTRUCTABLE IS ALLOCATION-DERIVED MRR.
 * customers.monthly_allocation is current state AND is a lead count, not
 * currency — a customer who downgraded reads at today's tier for their whole
 * history. So MRR here always comes from the latest paid invoice's amount_pence,
 * which is also strictly better than /admin's existing planForAllocation()
 * inference, the thing CLAUDE.md §33 records as having hidden a £150/mo leak.
 * Do not add a historical allocation-derived line.
 */

import type { LeadType } from "@/lib/types";
import { londonDate } from "@/lib/pacing";
import { planForProductAllocation } from "@/lib/plans";

export const LEAD_TYPES: readonly LeadType[] = ["management", "guaranteed_rent"];

/** Human label for a product, for headings and table cells. */
export function productLabel(leadType: LeadType): string {
  return leadType === "guaranteed_rent" ? "Guaranteed Rent" : "Management";
}

// ---------------------------------------------------------------------------
// Tenure bands
// ---------------------------------------------------------------------------

export type TenureBandKey = "m0_1" | "m1_3" | "m3_6" | "m6_12" | "m12_plus";

export type StabilityLevel =
  | "trial"
  | "settling"
  | "established"
  | "stable"
  | "very_stable";

export interface TenureBand {
  key: TenureBandKey;
  /** Inclusive lower bound, in months since the first paid invoice. */
  fromMonths: number;
  /** EXCLUSIVE upper bound; null is open-ended. */
  toMonths: number | null;
  label: string;
  shortLabel: string;
  stability: StabilityLevel;
  stabilityLabel: string;
}

/**
 * The five bands, in order. Shared by the stability tiles, the chart's five
 * series and the retention table so the three cannot disagree about where a
 * customer sits.
 *
 * Bounds are HALF-OPEN — [from, to) — which is importedLeadMonths.ts's rule for
 * exactly the reason it gives there: a value on the boundary must belong to
 * exactly one bucket. Month 6.0 is `m6_12`, never `m3_6`.
 */
export const TENURE_BANDS: readonly TenureBand[] = [
  {
    key: "m0_1",
    fromMonths: 0,
    toMonths: 1,
    label: "Under 1 month",
    shortLabel: "0–1mo",
    stability: "trial",
    stabilityLabel: "Trial phase",
  },
  {
    key: "m1_3",
    fromMonths: 1,
    toMonths: 3,
    label: "1 to 3 months",
    shortLabel: "1–3mo",
    stability: "settling",
    stabilityLabel: "Settling",
  },
  {
    key: "m3_6",
    fromMonths: 3,
    toMonths: 6,
    label: "3 to 6 months",
    shortLabel: "3–6mo",
    stability: "established",
    stabilityLabel: "Establishing",
  },
  {
    key: "m6_12",
    fromMonths: 6,
    toMonths: 12,
    label: "6 to 12 months",
    shortLabel: "6–12mo",
    stability: "stable",
    stabilityLabel: "Stable",
  },
  {
    key: "m12_plus",
    fromMonths: 12,
    toMonths: null,
    label: "Over 12 months",
    shortLabel: "12mo+",
    stability: "very_stable",
    stabilityLabel: "Very stable",
  },
] as const;

/** The two bands that count toward the stable share of revenue. */
export const STABLE_BANDS: readonly TenureBandKey[] = ["m6_12", "m12_plus"];

export function bandForMonths(months: number): TenureBandKey {
  const m = Number.isFinite(months) && months > 0 ? months : 0;
  for (const band of TENURE_BANDS) {
    if (band.toMonths === null) return band.key;
    if (m < band.toMonths) return band.key;
  }
  return "m12_plus";
}

export function bandLabel(key: TenureBandKey): string {
  return TENURE_BANDS.find((b) => b.key === key)?.label ?? key;
}

function emptyBandTally(): Record<TenureBandKey, number> {
  return { m0_1: 0, m1_3: 0, m3_6: 0, m6_12: 0, m12_plus: 0 };
}

// ---------------------------------------------------------------------------
// London-anchored month arithmetic
// ---------------------------------------------------------------------------

function ymdParts(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return { y, m, d };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** YYYY-MM-DD plus n whole months, clamped to the end of the target month. */
export function addMonthsYmd(ymd: string, n: number): string {
  const { y, m, d } = ymdParts(ymd);
  const total = (y * 12 + (m - 1)) + n;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const day = Math.min(d, daysInMonth(ty, tm));
  return `${ty}-${String(tm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function ymdToUtcMs(ymd: string): number {
  const { y, m, d } = ymdParts(ymd);
  return Date.UTC(y, m - 1, d);
}

/** Whole calendar days between two YYYY-MM-DD strings. */
export function daysBetweenYmd(from: string, to: string): number {
  return Math.round((ymdToUtcMs(to) - ymdToUtcMs(from)) / 86_400_000);
}

/** YYYY-MM-DD in Europe/London for an ISO timestamp. */
export function londonYmdOf(iso: string): string {
  return londonDate(new Date(iso));
}

/**
 * Fractional months between two instants, measured on LONDON dates.
 *
 * Anchored on London rather than the server clock for sendWindow.ts's reason:
 * Vercel runs in UTC and Britain is an hour ahead for half the year, so a
 * payment at 00:30 BST belongs to the day the operator would call it.
 *
 * Whole months come from the calendar (so an 8 Aug → 8 Sep span is exactly 1.0,
 * not 31/30.44), and the remainder is the fraction of the way through the
 * current anniversary month. Returns 0 when reversed.
 */
export function monthsBetween(fromIso: string, toIso: string): number {
  const a = londonYmdOf(fromIso);
  const b = londonYmdOf(toIso);
  if (b <= a) return 0;

  const pa = ymdParts(a);
  const pb = ymdParts(b);
  let months = (pb.y - pa.y) * 12 + (pb.m - pa.m);
  if (pb.d < pa.d) months -= 1;
  if (months < 0) months = 0;

  const anniversary = addMonthsYmd(a, months);
  const nextAnniversary = addMonthsYmd(a, months + 1);
  const span = daysBetweenYmd(anniversary, nextAnniversary);
  const into = daysBetweenYmd(anniversary, b);
  const fraction = span > 0 ? Math.max(0, Math.min(1, into / span)) : 0;
  return months + fraction;
}

// ---------------------------------------------------------------------------
// Reason taxonomy
// ---------------------------------------------------------------------------

export type ReasonTheme =
  | "price"
  | "lead_volume"
  | "lead_quality"
  | "lead_quality_or_volume"
  | "own_capacity"
  | "left_market"
  | "product_gap"
  | "service"
  | "payment_failed"
  | "not_recorded";

export type ReasonSource =
  | "cancellation_row"
  | "stripe_feedback"
  | "pause_reason"
  | "write_off"
  | "none";

export const REASON_THEME_LABELS: Record<ReasonTheme, string> = {
  price: "Price",
  lead_volume: "Not enough leads",
  lead_quality: "Lead quality",
  // ⚠️ Its own theme, never folded into lead_quality — see OUR_KEY_TO_THEME.
  lead_quality_or_volume: "Lead quality or volume (from Stripe — cannot tell which)",
  own_capacity: "Their own capacity",
  left_market: "Left the market or switched",
  product_gap: "Missing or too complex",
  service: "Service",
  payment_failed: "Payment kept failing",
  not_recorded: "Not recorded",
};

export const REASON_SOURCE_LABELS: Record<ReasonSource, string> = {
  cancellation_row: "In-app cancel form",
  stripe_feedback: "Stripe billing portal",
  pause_reason: "Their earlier pause",
  write_off: "Written off — no reason asked",
  none: "None recorded",
};

/**
 * Our own vocabulary → themes. Deliberately covers the CANCEL and PAUSE keys in
 * one map, because cancelOptions.ts:11-15 records that the four overlapping keys
 * (too_expensive, not_enough_leads, lead_quality, at_capacity) are identical
 * ACROSS the two lists on purpose, so the two signals can be counted together.
 */
export const OUR_KEY_TO_THEME: Record<string, ReasonTheme> = {
  too_expensive: "price",
  not_enough_leads: "lead_volume",
  lead_quality: "lead_quality",
  at_capacity: "own_capacity",
  seasonal: "own_capacity",
  switched_provider: "left_market",
  closing_business: "left_market",
  other: "not_recorded",
  unknown_pre_0077: "not_recorded",
};

/**
 * Stripe's cancellation_details.feedback → themes.
 *
 * ⚠️ `low_quality` maps to its OWN theme and must never be collapsed into
 * lead_quality. CANCEL_REASON_TO_STRIPE_FEEDBACK sends BOTH our `lead_quality`
 * and our `not_enough_leads` to Stripe as `low_quality`, so a Stripe-only row
 * genuinely cannot say which one the customer meant. Collapsing it would invent
 * a sourcing problem out of a supply problem.
 */
export const STRIPE_FEEDBACK_TO_THEME: Record<string, ReasonTheme> = {
  too_expensive: "price",
  low_quality: "lead_quality_or_volume",
  unused: "own_capacity",
  switched_service: "left_market",
  missing_features: "product_gap",
  too_complex: "product_gap",
  customer_service: "service",
  other: "not_recorded",
};

function themesFromOurKeys(keys: readonly string[]): ReasonTheme[] {
  const seen: ReasonTheme[] = [];
  for (const key of keys) {
    const theme = OUR_KEY_TO_THEME[key] ?? "not_recorded";
    if (!seen.includes(theme)) seen.push(theme);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Inputs — narrow row shapes, so this module never imports supabase types
// ---------------------------------------------------------------------------

export interface CustomerLifecycleInput {
  id: string;
  business_name: string | null;
  email: string | null;
  created_at: string;
  is_active: boolean | null;
  account_status: string | null;
  subscription_status: string | null;
  gr_subscription_status: string | null;
  paused_at: string | null;
  pause_resumes_at: string | null;
  cancelled_at: string | null;
  gr_cancelled_at: string | null;
  lapsed_at: string | null;
  gr_lapsed_at: string | null;
  cancel_at_period_end: boolean | null;
  gr_cancel_at_period_end: boolean | null;
  cancel_effective_at: string | null;
  gr_cancel_effective_at: string | null;
  cancellation_feedback: string | null;
  cancellation_comment: string | null;
}

export interface PaymentInput {
  customer_id: string | null;
  payment_type: string | null;
  status: string | null;
  amount_pence: number | null;
  created_at: string | null;
}

export interface CancellationInput {
  customer_id: string;
  lead_type: string;
  reasons: string[] | null;
  note: string | null;
  stripe_feedback: string | null;
  requested_at: string | null;
  reverted_at: string | null;
}

export interface PauseInput {
  customer_id: string;
  reasons: string[] | null;
  note: string | null;
  months: number | null;
  paused_at: string;
  resumes_at: string | null;
  ended_at: string | null;
}

export interface PlanChangeInput {
  customer_id: string;
  lead_type: string;
  from_allocation: number;
  to_allocation: number;
  applied_at: string | null;
}

// ---------------------------------------------------------------------------
// Products a customer has a lifecycle for
// ---------------------------------------------------------------------------

/**
 * ⚠️ The subscription payment_type is the ONLY reliable product signal on a
 * payment row. `payments.lead_type` is null on 37 of 39 paid subscription rows
 * in production — 0041's backfill covered the two rows that existed at the time
 * and the Stripe webhook has never set it since. Reading it would attribute
 * almost all revenue to neither product.
 */
export function productOfPaymentType(paymentType: string | null): LeadType | null {
  if (paymentType === "subscription") return "management";
  if (paymentType === "gr_subscription") return "guaranteed_rent";
  return null;
}

/**
 * ⚠️ THE SPELLING DIFFERS BY COLUMN AND BOTH ARE CHECKED.
 * `account_status` uses British `cancelled`; the Stripe-mirrored
 * `subscription_status` / `gr_subscription_status` use American `canceled`.
 * Testing one spelling silently drops every customer recorded in the other.
 */
function holdsOrHeld(
  customer: CustomerLifecycleInput,
  leadType: LeadType,
  hasPaid: boolean
): boolean {
  if (hasPaid) return true;
  if (leadType === "management") {
    if (customer.cancelled_at || customer.lapsed_at) return true;
    if (customer.account_status === "active" || customer.account_status === "cancelled") {
      return true;
    }
    return ["active", "past_due", "canceled"].includes(
      customer.subscription_status ?? ""
    );
  }
  if (customer.gr_cancelled_at || customer.gr_lapsed_at) return true;
  return ["active", "past_due", "canceled"].includes(
    customer.gr_subscription_status ?? ""
  );
}

// ---------------------------------------------------------------------------
// The lifecycle row
// ---------------------------------------------------------------------------

export type TenureBasis = "invoice" | "signup_estimated" | "never_paid";

export type LifecycleState =
  | "active"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "lapsed";

export const LIFECYCLE_STATE_LABELS: Record<LifecycleState, string> = {
  active: "Active",
  paused: "Paused",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  lapsed: "Written off",
};

export interface LifecycleRow {
  /** `${customerId}:${leadType}` — the key every per-product map uses. */
  key: string;
  customerId: string;
  businessName: string;
  email: string;
  leadType: LeadType;
  isArchived: boolean;

  firstPaidAt: string | null;
  /** The instant tenure is measured from — firstPaidAt, else signup. */
  tenureAnchor: string;
  tenureBasis: TenureBasis;
  invoicesPaid: number;
  /** The most recent paid invoice for this product, in pence. 0 when none. */
  mrrPence: number;

  endedAt: string | null;
  endKind: "cancelled" | "lapsed" | null;
  /** Set when they have asked to leave but the period has not ended. */
  cancelEffectiveAt: string | null;
  pausedAt: string | null;
  pauseResumesAt: string | null;

  state: LifecycleState;
  tenureMonths: number;
  band: TenureBandKey;

  reasonThemes: ReasonTheme[];
  reasonSource: ReasonSource;
  reasonRaw: string[];
  reasonNote: string | null;
}

export interface BuildLifecycleInput {
  customers: readonly CustomerLifecycleInput[];
  payments: readonly PaymentInput[];
  cancellations: readonly CancellationInput[];
  pauses: readonly PauseInput[];
  /** "Now" — passed in so every figure on one render shares one clock. */
  asOf: Date;
}

/** How far back a pause may sit behind a cancellation and still explain it. */
const PAUSE_EXPLAINS_CANCEL_DAYS = 120;

export function buildLifecycle(input: BuildLifecycleInput): LifecycleRow[] {
  const { customers, payments, cancellations, pauses, asOf } = input;
  const nowIso = asOf.toISOString();

  // Paid subscription invoices only, per (customer, product), oldest first.
  const paidByKey = new Map<string, { iso: string; pence: number }[]>();
  for (const p of payments) {
    if (p.status !== "paid" || !p.customer_id || !p.created_at) continue;
    const product = productOfPaymentType(p.payment_type);
    if (!product) continue;
    const key = `${p.customer_id}:${product}`;
    const list = paidByKey.get(key) ?? [];
    list.push({ iso: p.created_at, pence: p.amount_pence ?? 0 });
    paidByKey.set(key, list);
  }
  paidByKey.forEach((list) => {
    list.sort((a, b) => a.iso.localeCompare(b.iso));
  });

  const rows: LifecycleRow[] = [];

  for (const c of customers) {
    for (const leadType of LEAD_TYPES) {
      const key = `${c.id}:${leadType}`;
      const paid = paidByKey.get(key) ?? [];
      if (!holdsOrHeld(c, leadType, paid.length > 0)) continue;

      const management = leadType === "management";
      const cancelledAt = management ? c.cancelled_at : c.gr_cancelled_at;
      const lapsedAt = management ? c.lapsed_at : c.gr_lapsed_at;
      const pendingCancel = management
        ? c.cancel_at_period_end === true
        : c.gr_cancel_at_period_end === true;
      const cancelEffectiveAt = management
        ? c.cancel_effective_at
        : c.gr_cancel_effective_at;

      // Whichever end came first is the end. Both can be set.
      const endCandidates: { iso: string; kind: "cancelled" | "lapsed" }[] = [];
      if (cancelledAt) endCandidates.push({ iso: cancelledAt, kind: "cancelled" });
      if (lapsedAt) endCandidates.push({ iso: lapsedAt, kind: "lapsed" });
      endCandidates.sort((a, b) => a.iso.localeCompare(b.iso));
      const ended = endCandidates[0] ?? null;

      // Pause is management-only (invariant 6): the GR side has no pause of its
      // own, and paused_at must never gate GR behaviour.
      const pausedAt = management ? c.paused_at : null;
      const pauseResumesAt = management ? c.pause_resumes_at : null;

      const firstPaidAt = paid[0]?.iso ?? null;
      const tenureAnchor = firstPaidAt ?? c.created_at;
      const tenureBasis: TenureBasis = firstPaidAt
        ? "invoice"
        : ended
          ? "never_paid"
          : "signup_estimated";

      let state: LifecycleState;
      if (ended?.kind === "lapsed") state = "lapsed";
      else if (ended) state = "cancelled";
      else if (pausedAt) state = "paused";
      else if (pendingCancel) state = "cancelling";
      else state = "active";

      const tenureMonths = monthsBetween(tenureAnchor, ended?.iso ?? nowIso);

      const resolved = resolveReason({
        customerId: c.id,
        leadType,
        ended,
        cancellations,
        pauses,
        stripeFeedback: management ? c.cancellation_feedback : null,
        stripeComment: management ? c.cancellation_comment : null,
      });

      rows.push({
        key,
        customerId: c.id,
        businessName: c.business_name?.trim() || c.email?.trim() || "(no name)",
        email: c.email?.trim() ?? "",
        leadType,
        isArchived: c.is_active === false,
        firstPaidAt,
        tenureAnchor,
        tenureBasis,
        invoicesPaid: paid.length,
        mrrPence: paid.length > 0 ? paid[paid.length - 1].pence : 0,
        endedAt: ended?.iso ?? null,
        endKind: ended?.kind ?? null,
        cancelEffectiveAt: pendingCancel ? cancelEffectiveAt : null,
        pausedAt,
        pauseResumesAt,
        state,
        tenureMonths,
        band: bandForMonths(tenureMonths),
        ...resolved,
      });
    }
  }

  rows.sort(
    (a, b) =>
      (b.endedAt ?? "").localeCompare(a.endedAt ?? "") ||
      a.businessName.localeCompare(b.businessName)
  );
  return rows;
}

interface ResolveReasonArgs {
  customerId: string;
  leadType: LeadType;
  ended: { iso: string; kind: "cancelled" | "lapsed" } | null;
  cancellations: readonly CancellationInput[];
  pauses: readonly PauseInput[];
  stripeFeedback: string | null;
  stripeComment: string | null;
}

interface ResolvedReason {
  reasonThemes: ReasonTheme[];
  reasonSource: ReasonSource;
  reasonRaw: string[];
  reasonNote: string | null;
}

/**
 * The precedence ladder, and every rung earns its place.
 *
 * ⚠️ A BILLING-PORTAL CANCELLATION WRITES NO ROW OF OURS.
 * src/lib/cancellations.ts:105-106 records that only the in-app flow inserts
 * subscription_cancellations; a portal cancellation leaves only
 * customers.cancellation_feedback. In production that is 2 of the 6 cancellation
 * events, so a resolver that read only our own table would report a third of
 * the book as "not recorded" when Stripe had the answer all along.
 *
 * ⚠️ A WRITE-OFF IS CHURN WITH NO STATED REASON, AND THAT IS ITSELF THE FINDING.
 * `payment_failed` is its own theme rather than folded into `not_recorded`,
 * which would file a billing failure as a silent departure.
 */
function resolveReason(args: ResolveReasonArgs): ResolvedReason {
  const { customerId, leadType, ended, cancellations, pauses } = args;
  if (!ended) {
    return {
      reasonThemes: [],
      reasonSource: "none",
      reasonRaw: [],
      reasonNote: null,
    };
  }

  // 1 — our own cancel form, richest and unambiguous.
  const ours = cancellations
    .filter(
      (r) =>
        r.customer_id === customerId &&
        r.lead_type === leadType &&
        !r.reverted_at &&
        (r.reasons?.length ?? 0) > 0
    )
    .sort((a, b) => (b.requested_at ?? "").localeCompare(a.requested_at ?? ""))[0];
  if (ours) {
    const raw = ours.reasons ?? [];
    return {
      reasonThemes: themesFromOurKeys(raw),
      reasonSource: "cancellation_row",
      reasonRaw: raw,
      reasonNote: ours.note?.trim() || null,
    };
  }

  // 2 — Stripe's own enum, management only (0084 discards it on the GR side).
  if (args.stripeFeedback) {
    const theme = STRIPE_FEEDBACK_TO_THEME[args.stripeFeedback] ?? "not_recorded";
    return {
      reasonThemes: [theme],
      reasonSource: "stripe_feedback",
      reasonRaw: [args.stripeFeedback],
      reasonNote: args.stripeComment?.trim() || null,
    };
  }

  // 3 — a pause they took shortly before leaving. Weaker evidence than either
  // of the above, stronger than nothing, and labelled as its own source so
  // nobody reads it as something the customer said on the way out.
  const pause = pauses
    .filter((p) => {
      if (p.customer_id !== customerId) return false;
      if ((p.reasons?.length ?? 0) === 0) return false;
      if (p.paused_at > ended.iso) return false;
      const gap = daysBetweenYmd(londonYmdOf(p.paused_at), londonYmdOf(ended.iso));
      return gap <= PAUSE_EXPLAINS_CANCEL_DAYS;
    })
    .sort((a, b) => b.paused_at.localeCompare(a.paused_at))[0];
  if (pause) {
    const raw = pause.reasons ?? [];
    return {
      reasonThemes: themesFromOurKeys(raw),
      reasonSource: "pause_reason",
      reasonRaw: raw,
      reasonNote: pause.note?.trim() || null,
    };
  }

  // 4 — written off for a failing card. Nobody was asked, so there is no reason
  // to find; the cause is the fact.
  if (ended.kind === "lapsed") {
    return {
      reasonThemes: ["payment_failed"],
      reasonSource: "write_off",
      reasonRaw: [],
      reasonNote: null,
    };
  }

  return {
    reasonThemes: ["not_recorded"],
    reasonSource: "none",
    reasonRaw: [],
    reasonNote: null,
  };
}

/** Churned, whichever way they went. */
export function isChurned(row: LifecycleRow): boolean {
  return row.endedAt !== null;
}

/** Still paying us this month — a pending cancellation is still paying. */
export function isPaying(row: LifecycleRow): boolean {
  return row.state === "active" || row.state === "cancelling";
}

// ---------------------------------------------------------------------------
// Renewal retention
// ---------------------------------------------------------------------------

export interface RetentionCheckpoint {
  /** Months of tenure this checkpoint sits at. */
  months: number;
  /** The invoice number a customer must have paid to have cleared it. */
  invoice: number;
  label: string;
}

/**
 * ⚠️ RETENTION IS COUNTED IN INVOICES, AND THAT IS WHAT KILLS THE BOUNDARY BUG.
 *
 * All three measurable churns in production sit at EXACTLY 31.0 days from their
 * first payment — every one cancelled the moment their second invoice came due.
 * A month-based band flips the headline on the boundary: defined as "up to 1
 * month" it reports 3 churns in month 1, defined as "under 1 month" it reports
 * 0 there and 3 in the 1–3 band. Neither is wrong and the reader cannot tell.
 *
 * Counting invoices cannot be gamed by a boundary. "Did they pay a 2nd invoice?"
 * has one answer, and for all three it is no. Months stay as the labels because
 * that is how the business thinks about tenure; the arithmetic underneath is the
 * invoice count.
 */
export const RETENTION_CHECKPOINTS: readonly RetentionCheckpoint[] = [
  { months: 1, invoice: 2, label: "1 month" },
  { months: 3, invoice: 4, label: "3 months" },
  { months: 6, invoice: 7, label: "6 months" },
  { months: 12, invoice: 13, label: "12 months" },
] as const;

/**
 * Below this many eligible customers a percentage is withheld rather than
 * printed. Mirrors get_engagement_benchmarks()'s existing suppression rule
 * (CLAUDE.md §10) — fewer than this is a report on named individuals with the
 * names removed, and it reads as a rate when it is not one.
 */
export const MIN_COHORT = 5;

export interface RetentionResult {
  checkpoint: RetentionCheckpoint;
  /** Had the OPPORTUNITY to reach this checkpoint. The denominator. */
  eligible: number;
  /** Actually paid the checkpoint's invoice. */
  renewed: number;
  /** Has an end date and never paid it. */
  churned: number;
  /**
   * Eligible, still with us, and the invoice has not landed — a failed or
   * in-flight payment. ⚠️ NEVER folded into `renewed`: seven failed
   * subscription payments exist in the book, and hiding them inflates retention.
   */
  unclear: number;
  /**
   * Reached the checkpoint's date while PAUSED and without having already
   * cleared its invoice — so excluded from `eligible` entirely.
   *
   * ⚠️ NOT A RENEWAL AND NOT A LOSS, and not `unclear` either. Stripe VOIDS a
   * paused subscription's invoices, so we are the reason the invoice never
   * landed; calling it unclear blames a payment failure that never happened and
   * understates retention by the size of the paused book (six of nineteen live
   * management subscriptions when this shipped). A customer who had already
   * cleared the checkpoint's invoice before pausing still counts as renewed.
   */
  paused: number;
  /** renewed / eligible, or null when suppressed or nothing is eligible. */
  pct: number | null;
  suppressed: boolean;
  /**
   * When nothing is eligible yet, the earliest date anything will be — so a
   * 6- or 12-month row reads as a countdown rather than a blank or a
   * confident zero.
   */
  measurableFrom: string | null;
}

export function renewalRetention(
  rows: readonly LifecycleRow[],
  checkpoint: RetentionCheckpoint,
  asOf: Date
): RetentionResult {
  const nowIso = asOf.toISOString();
  const withInvoice = rows.filter((r) => r.firstPaidAt !== null);

  let eligible = 0;
  let renewed = 0;
  let churned = 0;
  let unclear = 0;
  let paused = 0;
  let earliest: string | null = null;

  for (const row of withInvoice) {
    const anchor = row.firstPaidAt as string;
    const hadOpportunity = monthsBetween(anchor, nowIso) >= checkpoint.months;
    if (!hadOpportunity) {
      const due = addMonthsYmd(londonYmdOf(anchor), checkpoint.months);
      if (!earliest || due < earliest) earliest = due;
      continue;
    }
    const cleared = row.invoicesPaid >= checkpoint.invoice;
    // A pause we are voiding invoices under is not a missed renewal. Tested
    // AFTER `cleared`, so somebody who renewed and then paused still counts as
    // a renewal — the pause only removes a checkpoint they had not reached.
    if (!cleared && row.state === "paused") {
      paused += 1;
      continue;
    }
    eligible += 1;
    if (cleared) renewed += 1;
    else if (row.endedAt) churned += 1;
    else unclear += 1;
  }

  const suppressed = eligible < MIN_COHORT;
  return {
    checkpoint,
    eligible,
    renewed,
    churned,
    unclear,
    paused,
    pct: eligible > 0 && !suppressed ? renewed / eligible : null,
    suppressed,
    measurableFrom: eligible === 0 ? earliest : null,
  };
}

/**
 * Churned without ever paying — excluded from every checkpoint above, because
 * they never entered the renewal funnel, and counted here instead so they are
 * not simply lost. One such customer exists in production.
 */
export function churnedBeforePaying(rows: readonly LifecycleRow[]): LifecycleRow[] {
  return rows.filter((r) => r.endedAt !== null && r.firstPaidAt === null);
}

// ---------------------------------------------------------------------------
// Banded MRR — today's position
// ---------------------------------------------------------------------------

export interface BandedMrrEntry {
  band: TenureBandKey;
  pence: number;
  customers: number;
}

export interface BandedMrr {
  entries: BandedMrrEntry[];
  totalPence: number;
  customers: number;
  /** 6–12 plus 12+. */
  stablePence: number;
  stableSharePct: number | null;
  /**
   * ⚠️ Reported BESIDE the total and never added into it. A paused customer is
   * billing £0 — CLAUDE.md §21's "always two numbers, never one", the discipline
   * every other capacity and MRR figure here already follows.
   */
  pausedPence: number;
  pausedCustomers: number;
  /** Customers with a live subscription and no paid invoice to price it from. */
  unpricedCustomers: number;
}

export function bandedMrr(rows: readonly LifecycleRow[]): BandedMrr {
  const pence = emptyBandTally();
  const count = emptyBandTally();
  let totalPence = 0;
  let customers = 0;
  let pausedPence = 0;
  let pausedCustomers = 0;
  let unpricedCustomers = 0;

  for (const row of rows) {
    if (row.state === "paused") {
      pausedPence += row.mrrPence;
      pausedCustomers += 1;
      continue;
    }
    if (!isPaying(row)) continue;
    if (row.mrrPence === 0) unpricedCustomers += 1;
    pence[row.band] += row.mrrPence;
    count[row.band] += 1;
    totalPence += row.mrrPence;
    customers += 1;
  }

  const stablePence = STABLE_BANDS.reduce((sum, key) => sum + pence[key], 0);
  return {
    entries: TENURE_BANDS.map((band) => ({
      band: band.key,
      pence: pence[band.key],
      customers: count[band.key],
    })),
    totalPence,
    customers,
    stablePence,
    stableSharePct: totalPence > 0 ? stablePence / totalPence : null,
    pausedPence,
    pausedCustomers,
    unpricedCustomers,
  };
}

// ---------------------------------------------------------------------------
// The trend — daily MRR in force, banded by tenure
// ---------------------------------------------------------------------------

export interface MrrPoint {
  /** YYYY-MM-DD, Europe/London. */
  date: string;
  totalPence: number;
  m0_1: number;
  m1_3: number;
  m3_6: number;
  m6_12: number;
  m12_plus: number;
  customers: number;
}

/**
 * For each London day since the first paid invoice: every subscription that was
 * live that day contributes the amount of its most recent paid invoice on or
 * before that day, bucketed by how old that customer was THAT DAY.
 *
 * This is the one genuinely non-obvious computation on the page, and it is
 * exactly reconstructable — which is why /admin/retention needs no snapshot
 * table (see the file header). 61 points today, one more every day.
 *
 * ⚠️ A PAUSED SUBSCRIPTION CONTRIBUTES NOTHING. Stripe is voiding its invoices,
 * so it is billing £0; counting it would put revenue in the series that nobody
 * collected. It is reported separately by bandedMrr().
 */
export function mrrInForceDaily(
  rows: readonly LifecycleRow[],
  payments: readonly PaymentInput[],
  asOf: Date
): MrrPoint[] {
  const withInvoice = rows.filter((r) => r.firstPaidAt !== null);
  if (withInvoice.length === 0) return [];

  // Paid subscription invoices per key, oldest first, as London days.
  const paidByKey = new Map<string, { ymd: string; pence: number }[]>();
  for (const p of payments) {
    if (p.status !== "paid" || !p.customer_id || !p.created_at) continue;
    const product = productOfPaymentType(p.payment_type);
    if (!product) continue;
    const key = `${p.customer_id}:${product}`;
    const list = paidByKey.get(key) ?? [];
    list.push({ ymd: londonYmdOf(p.created_at), pence: p.amount_pence ?? 0 });
    paidByKey.set(key, list);
  }
  paidByKey.forEach((list) => list.sort((a, b) => a.ymd.localeCompare(b.ymd)));

  const today = londonDate(asOf);
  const start = withInvoice
    .map((r) => londonYmdOf(r.firstPaidAt as string))
    .reduce((min, d) => (d < min ? d : min));

  // One forward cursor per key: days ascend, so each invoice list is walked once.
  const cursor = new Map<string, number>();
  const current = new Map<string, number>();

  const series: MrrPoint[] = [];
  for (let day = start; day <= today; day = addDaysYmd(day, 1)) {
    const tally = emptyBandTally();
    let totalPence = 0;
    let customers = 0;

    for (const row of withInvoice) {
      const list = paidByKey.get(row.key) ?? [];
      let i = cursor.get(row.key) ?? 0;
      while (i < list.length && list[i].ymd <= day) {
        current.set(row.key, list[i].pence);
        i += 1;
      }
      cursor.set(row.key, i);

      const firstDay = londonYmdOf(row.firstPaidAt as string);
      if (day < firstDay) continue;
      if (row.endedAt && londonYmdOf(row.endedAt) <= day) continue;
      if (row.pausedAt && londonYmdOf(row.pausedAt) <= day) {
        const resumed = row.pauseResumesAt ? londonYmdOf(row.pauseResumesAt) : null;
        if (!resumed || resumed > day) continue;
      }

      const pence = current.get(row.key) ?? 0;
      const band = bandForMonths(monthsBetween(row.firstPaidAt as string, `${day}T12:00:00Z`));
      tally[band] += pence;
      totalPence += pence;
      customers += 1;
    }

    series.push({ date: day, totalPence, customers, ...tally });
  }
  return series;
}

function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(ymdToUtcMs(ymd));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Revenue movement — upgrades and downgrades
// ---------------------------------------------------------------------------

export interface RevenueMovementMonth {
  /** YYYY-MM. */
  month: string;
  upPence: number;
  downPence: number;
  netPence: number;
  upgrades: number;
  downgrades: number;
}

/**
 * A downgrade is retention, not churn: the customer stayed and the revenue
 * shrank. Reported beside churn so a month where three customers halve their
 * spend does not read as a perfect month — and upgrades are the clearest signal
 * the product is working.
 *
 * Only APPLIED changes count. A requested-then-reverted change never billed, and
 * subscription_plan_changes denormalises from_/to_allocation precisely so the row
 * still says what it moved between after the allocation was overwritten (0088).
 */
export function revenueMovement(
  changes: readonly PlanChangeInput[]
): RevenueMovementMonth[] {
  const byMonth = new Map<string, RevenueMovementMonth>();
  for (const change of changes) {
    if (!change.applied_at) continue;
    const month = londonYmdOf(change.applied_at).slice(0, 7);
    const from = planForProductAllocation(change.lead_type, change.from_allocation).priceGbp * 100;
    const to = planForProductAllocation(change.lead_type, change.to_allocation).priceGbp * 100;
    const delta = to - from;
    if (delta === 0) continue;
    const entry =
      byMonth.get(month) ??
      { month, upPence: 0, downPence: 0, netPence: 0, upgrades: 0, downgrades: 0 };
    if (delta > 0) {
      entry.upPence += delta;
      entry.upgrades += 1;
    } else {
      entry.downPence += -delta;
      entry.downgrades += 1;
    }
    entry.netPence += delta;
    byMonth.set(month, entry);
  }
  return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
}

// ---------------------------------------------------------------------------
// The reasons cross-tab
// ---------------------------------------------------------------------------

export interface ReasonBandCell {
  theme: ReasonTheme;
  byBand: Record<TenureBandKey, number>;
  total: number;
}

export interface ReasonCrossTab {
  rows: ReasonBandCell[];
  /** Churn events counted. */
  events: number;
  /**
   * Reason mentions counted. ⚠️ HIGHER THAN `events` ON PURPOSE — reasons is a
   * text[] and a customer may give several, so each counts once. The same
   * "per product, not per customer" discipline §18A applies to MRR.
   */
  mentions: number;
}

export function reasonCrossTab(rows: readonly LifecycleRow[]): ReasonCrossTab {
  const byTheme = new Map<ReasonTheme, Record<TenureBandKey, number>>();
  let events = 0;
  let mentions = 0;

  for (const row of rows) {
    if (!isChurned(row)) continue;
    events += 1;
    const themes = row.reasonThemes.length > 0 ? row.reasonThemes : ["not_recorded" as ReasonTheme];
    for (const theme of themes) {
      const tally = byTheme.get(theme) ?? emptyBandTally();
      tally[row.band] += 1;
      byTheme.set(theme, tally);
      mentions += 1;
    }
  }

  const order = Object.keys(REASON_THEME_LABELS) as ReasonTheme[];
  return {
    rows: order
      .filter((theme) => byTheme.has(theme))
      .map((theme) => {
        const byBand = byTheme.get(theme) as Record<TenureBandKey, number>;
        return {
          theme,
          byBand,
          total: TENURE_BANDS.reduce((sum, b) => sum + byBand[b.key], 0),
        };
      })
      .sort((a, b) => b.total - a.total),
    events,
    mentions,
  };
}

// ---------------------------------------------------------------------------
// Engagement beside the drop-off
// ---------------------------------------------------------------------------

export interface EngagementInput {
  customer_id: string;
  lead_type: string;
  captured_on: string;
  worked_rate: number | null;
  open_rate: number | null;
  contact_rate: number | null;
  assignments_delivered: number | null;
  assignments_worked: number | null;
  days_since_last_activity: number | null;
}

export interface EngagementAggregate {
  customers: number;
  workedRate: number | null;
  openRate: number | null;
  contactRate: number | null;
  delivered: number | null;
  worked: number | null;
  /** How many of these customers had NEVER worked a single lead. */
  neverWorkedAny: number;
}

export interface EngagementComparison {
  churned: EngagementAggregate;
  stayed: EngagementAggregate;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function aggregate(snapshots: EngagementInput[]): EngagementAggregate {
  const num = (pick: (s: EngagementInput) => number | null) =>
    mean(snapshots.map(pick).filter((v): v is number => typeof v === "number"));
  return {
    customers: snapshots.length,
    workedRate: num((s) => s.worked_rate),
    openRate: num((s) => s.open_rate),
    contactRate: num((s) => s.contact_rate),
    delivered: num((s) => s.assignments_delivered),
    worked: num((s) => s.assignments_worked),
    neverWorkedAny: snapshots.filter(
      (s) => (s.assignments_delivered ?? 0) > 0 && (s.assignments_worked ?? 0) === 0
    ).length,
  };
}

/**
 * The churners' LAST snapshot before they left, against the stayers' latest.
 *
 * This is the half that separates "the leads were bad" from "they never rang
 * anybody" — stated reasons alone cannot tell you which, and three of the four
 * reasons on record say lead quality.
 *
 * ⚠️ Snapshots do not stop at cancellation, so picking "the latest row" for a
 * churned customer would read their engagement WEEKS AFTER they left, when it is
 * necessarily zero, and make every churner look disengaged. The row must be
 * chosen relative to their own end date.
 */
export function engagementComparison(
  rows: readonly LifecycleRow[],
  snapshots: readonly EngagementInput[]
): EngagementComparison {
  const byKey = new Map<string, EngagementInput[]>();
  for (const s of snapshots) {
    const key = `${s.customer_id}:${s.lead_type}`;
    const list = byKey.get(key) ?? [];
    list.push(s);
    byKey.set(key, list);
  }
  byKey.forEach((list) => {
    list.sort((a, b) => a.captured_on.localeCompare(b.captured_on));
  });

  const churnedPick: EngagementInput[] = [];
  const stayedPick: EngagementInput[] = [];

  for (const row of rows) {
    const list = byKey.get(row.key);
    if (!list || list.length === 0) continue;
    if (isChurned(row)) {
      const cutoff = londonYmdOf(row.endedAt as string);
      const before = list.filter((s) => s.captured_on <= cutoff);
      const pick = before.length > 0 ? before[before.length - 1] : null;
      if (pick) churnedPick.push(pick);
    } else if (isPaying(row) || row.state === "paused") {
      stayedPick.push(list[list.length - 1]);
    }
  }

  return { churned: aggregate(churnedPick), stayed: aggregate(stayedPick) };
}

// ---------------------------------------------------------------------------
// The forward view
// ---------------------------------------------------------------------------

export interface ApproachingRow {
  row: LifecycleRow;
  checkpoint: RetentionCheckpoint;
  /** YYYY-MM-DD the checkpoint falls due. */
  dueOn: string;
  daysAway: number;
}

/**
 * Who reaches a checkpoint in the next `withinDays`.
 *
 * Stated rules only, no score: with four churn events on record there is nothing
 * to fit, which is the position get_customer_risk() and pauseOutlook.ts both
 * already take.
 *
 * ⚠️ get_customer_risk() is deliberately NOT reused here. Its WHERE clause
 * requires an active subscription, so it cannot see a churned customer at all —
 * and it answers "who has gone quiet", not "who is about to hit the cliff".
 */
export function approachingCheckpoint(
  rows: readonly LifecycleRow[],
  asOf: Date,
  withinDays = 30
): ApproachingRow[] {
  const today = londonDate(asOf);
  const out: ApproachingRow[] = [];

  for (const row of rows) {
    if (isChurned(row) || !row.firstPaidAt) continue;
    for (const checkpoint of RETENTION_CHECKPOINTS) {
      const dueOn = addMonthsYmd(londonYmdOf(row.firstPaidAt), checkpoint.months);
      const daysAway = daysBetweenYmd(today, dueOn);
      if (daysAway < 0 || daysAway > withinDays) continue;
      out.push({ row, checkpoint, dueOn, daysAway });
    }
  }
  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

// ---------------------------------------------------------------------------
// Chart milestones
// ---------------------------------------------------------------------------

export interface Milestone {
  /** YYYY-MM-DD. */
  date: string;
  label: string;
}

/**
 * Platform changes worth seeing against the line, so "churn improved" can become
 * "churn improved after we changed X".
 *
 * Hand-maintained on purpose: a handful of dates a month is not worth a table
 * and an admin screen, and this codebase already records definition-change dates
 * in prose for exactly this reason. Add a line when something ships that could
 * plausibly move retention.
 */
export const RETENTION_MILESTONES: readonly Milestone[] = [
  { date: "2026-09-01", label: "Contact plans + landlord intro" },
  { date: "2026-09-12", label: "One-a-day release · replacements" },
  { date: "2026-09-17", label: "Replacements carry over" },
] as const;

/** Only the markers inside the series, so a marker cannot sit off the axis. */
export function visibleMilestones(series: readonly MrrPoint[]): Milestone[] {
  if (series.length === 0) return [];
  const first = series[0].date;
  const last = series[series.length - 1].date;
  return RETENTION_MILESTONES.filter((m) => m.date >= first && m.date <= last);
}

// ---------------------------------------------------------------------------
// Data quality — stated, never hidden
// ---------------------------------------------------------------------------

export interface DataQuality {
  /** Tenure measured from a real invoice. */
  invoiceBacked: number;
  /** Live subscription, no paid invoice — tenure estimated from signup. */
  signupEstimated: number;
  /** Churned having never paid. Excluded from every retention checkpoint. */
  neverPaid: number;
  /** Distinct months in which somebody first paid. */
  cohorts: number;
  earliestFirstPaid: string | null;
  /** Longest tenure any customer has reached, in months. */
  maxTenureMonths: number;
}

/**
 * ⚠️ `payments` IS KNOWN-INCOMPLETE AND THE PAGE MUST SAY SO.
 * 0064's own header records 17 payment rows against 20 subscribers at the time;
 * today two nominally-active subscriptions have no paid invoice at all and one
 * churner has none. Their tenure falls back to signup. Hiding that makes the
 * bands quietly wrong for exactly the oldest customers the stability figure
 * leans on.
 */
export function dataQuality(rows: readonly LifecycleRow[]): DataQuality {
  const months = new Set<string>();
  let earliest: string | null = null;
  let maxTenure = 0;

  for (const row of rows) {
    if (row.firstPaidAt) {
      const ymd = londonYmdOf(row.firstPaidAt);
      months.add(ymd.slice(0, 7));
      if (!earliest || ymd < earliest) earliest = ymd;
    }
    if (row.tenureBasis === "invoice" && row.tenureMonths > maxTenure) {
      maxTenure = row.tenureMonths;
    }
  }

  return {
    invoiceBacked: rows.filter((r) => r.tenureBasis === "invoice").length,
    signupEstimated: rows.filter((r) => r.tenureBasis === "signup_estimated").length,
    neverPaid: rows.filter((r) => r.tenureBasis === "never_paid").length,
    cohorts: months.size,
    earliestFirstPaid: earliest,
    maxTenureMonths: maxTenure,
  };
}
