/**
 * The reads behind /admin/retention. No arithmetic — that is all in
 * ./retention, so it is unit-testable under vitest.config.mts's
 * "PURE UNITS ONLY" rule.
 *
 * NO MIGRATION BACKS THIS FEATURE. Every table read here already exists, which
 * is why the page ships with no schema change, no production apply and no
 * migration-before-merge step (CLAUDE.md §1.1).
 *
 * ⚠️ DEGRADE, NEVER THROW. serviceHealth.ts:288-297's posture, for the reason it
 * states: "/admin is the page an admin opens when something is wrong, so it is
 * the last page that should break." Each block carries its own `unavailable`
 * flag and the page renders an explanatory card, as /admin/outcomes does.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildLifecycle,
  type CustomerLifecycleInput,
  type PaymentInput,
  type CancellationInput,
  type PauseInput,
  type PlanChangeInput,
  type EngagementInput,
  type LifecycleRow,
} from "@/lib/retention";

/**
 * Only these columns, never select("*"). The lifecycle needs a specific and
 * stable set, and naming them keeps a future column off a page that has no use
 * for it.
 */
const CUSTOMER_COLUMNS = [
  "id",
  "business_name",
  "email",
  "created_at",
  "is_active",
  "account_status",
  "subscription_status",
  "gr_subscription_status",
  "paused_at",
  "pause_resumes_at",
  "cancelled_at",
  "gr_cancelled_at",
  "lapsed_at",
  "gr_lapsed_at",
  "cancel_at_period_end",
  "gr_cancel_at_period_end",
  "cancel_effective_at",
  "gr_cancel_effective_at",
  "cancellation_feedback",
  "cancellation_comment",
].join(", ");

/**
 * How far back a churn may sit and still contribute to the engagement
 * comparison.
 *
 * ⚠️ This bounds the snapshot read, which is the only unbounded table on the
 * page: customer_engagement_snapshots grows daily per customer per product, and
 * PostgREST cannot express "the latest row per group". Recent churn is also the
 * actionable question — a departure from two years ago describes a different
 * product. Every OTHER figure (retention, the reason cross-tab, the churn list)
 * uses the full history and is not windowed by this.
 *
 * If this ever needs to cover more, the replacement is a SECURITY DEFINER
 * function returning one row per (customer, product), not a bigger number here.
 */
export const ENGAGEMENT_CHURN_LOOKBACK_DAYS = 180;

/** Days of snapshot history read before the earliest churn in the window. */
const ENGAGEMENT_LEAD_IN_DAYS = 35;

/** Days of recent snapshots read for customers who are still with us. */
const ENGAGEMENT_STAYER_DAYS = 7;

export interface SupportTicketRow {
  id: string;
  reference: number | null;
  customerId: string | null;
  kind: string | null;
  status: string | null;
  subject: string | null;
  submittedAt: string | null;
}

export interface RetentionData {
  asOf: string;
  lifecycle: LifecycleRow[];
  payments: PaymentInput[];
  planChanges: PlanChangeInput[];
  snapshots: EngagementInput[];
  tickets: SupportTicketRow[];
  /** The core read failed — the page has nothing to show. */
  unavailable: boolean;
  /** A supporting read failed; the core figures are still good. */
  partial: string[];
}

function ymdMinusDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function getRetentionData(): Promise<RetentionData> {
  const admin = createAdminClient();
  const asOfDate = new Date();
  const asOf = asOfDate.toISOString();
  const partial: string[] = [];

  const empty: RetentionData = {
    asOf,
    lifecycle: [],
    payments: [],
    planChanges: [],
    snapshots: [],
    tickets: [],
    unavailable: true,
    partial,
  };

  // ------------------------------------------------------------------
  // Phase 1 — everything the lifecycle needs.
  //
  // ⚠️ Subscription payments ONLY. `topup` and `lead_analysis` are one-off
  // income and would make the stability figure jump; they are not revenue a
  // tenure band can describe. Reported separately by the page if wanted.
  // ------------------------------------------------------------------
  const [customersRes, paymentsRes, cancellationsRes, pausesRes] = await Promise.all([
    admin.from("customers").select(CUSTOMER_COLUMNS),
    admin
      .from("payments")
      .select("customer_id, payment_type, status, amount_pence, created_at")
      .eq("status", "paid")
      .in("payment_type", ["subscription", "gr_subscription"])
      .order("created_at", { ascending: true }),
    admin
      .from("subscription_cancellations")
      .select("customer_id, lead_type, reasons, note, stripe_feedback, requested_at, reverted_at"),
    admin
      .from("subscription_pauses")
      .select("customer_id, reasons, note, months, paused_at, resumes_at, ended_at"),
  ]);

  if (customersRes.error || paymentsRes.error) {
    console.error("[retention] unavailable", {
      customers: customersRes.error?.message,
      payments: paymentsRes.error?.message,
    });
    return empty;
  }

  if (cancellationsRes.error) partial.push("cancellation reasons");
  if (pausesRes.error) partial.push("pause reasons");

  const customers = (customersRes.data ?? []) as unknown as CustomerLifecycleInput[];
  const payments = (paymentsRes.data ?? []) as unknown as PaymentInput[];
  const cancellations = (cancellationsRes.data ?? []) as unknown as CancellationInput[];
  const pauses = (pausesRes.data ?? []) as unknown as PauseInput[];

  const lifecycle = buildLifecycle({
    customers,
    payments,
    cancellations,
    pauses,
    asOf: asOfDate,
  });

  // ------------------------------------------------------------------
  // Phase 2 — the supporting reads. Each failure degrades one section.
  // ------------------------------------------------------------------
  const churnCutoff = ymdMinusDays(asOf, ENGAGEMENT_CHURN_LOOKBACK_DAYS);
  const recentChurn = lifecycle.filter(
    (r) => r.endedAt !== null && r.endedAt.slice(0, 10) >= churnCutoff
  );
  const churnIds = Array.from(new Set(recentChurn.map((r) => r.customerId)));
  const endDates = recentChurn.map((r) => (r.endedAt as string).slice(0, 10)).sort();

  const stayerFrom = ymdMinusDays(asOf, ENGAGEMENT_STAYER_DAYS);
  const churnFrom = endDates.length
    ? ymdMinusDays(`${endDates[0]}T00:00:00Z`, ENGAGEMENT_LEAD_IN_DAYS)
    : stayerFrom;
  const churnTo = endDates.length ? endDates[endDates.length - 1] : stayerFrom;

  const snapshotSelect =
    "customer_id, lead_type, captured_on, worked_rate, open_rate, contact_rate, assignments_delivered, assignments_worked, days_since_last_activity";

  const [planChangesRes, ticketsRes, stayerSnapsRes, churnSnapsRes] = await Promise.all([
    admin
      .from("subscription_plan_changes")
      .select("customer_id, lead_type, from_allocation, to_allocation, applied_at")
      .not("applied_at", "is", null),
    // ⚠️ ORDERED AND READ ON submitted_at, NEVER created_at. Nine of the ten
    // rows in production are backfilled to one identical created_at, which makes
    // a customer look like they filed tickets after they cancelled.
    admin
      .from("support_tickets")
      .select("id, reference, customer_id, kind, status, subject, submitted_at")
      .order("submitted_at", { ascending: false }),
    admin.from("customer_engagement_snapshots").select(snapshotSelect).gte("captured_on", stayerFrom),
    churnIds.length > 0
      ? admin
          .from("customer_engagement_snapshots")
          .select(snapshotSelect)
          .in("customer_id", churnIds)
          .gte("captured_on", churnFrom)
          .lte("captured_on", churnTo)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (planChangesRes.error) partial.push("plan changes");
  if (ticketsRes.error) partial.push("support tickets");
  if (stayerSnapsRes.error || churnSnapsRes.error) partial.push("engagement snapshots");

  // Both windows, deduped — a customer who churned inside the stayer window
  // would otherwise appear twice and double-weight the average.
  const seen = new Set<string>();
  const snapshots: EngagementInput[] = [];
  for (const row of [
    ...((churnSnapsRes.data ?? []) as unknown as EngagementInput[]),
    ...((stayerSnapsRes.data ?? []) as unknown as EngagementInput[]),
  ]) {
    const key = `${row.customer_id}:${row.lead_type}:${row.captured_on}`;
    if (seen.has(key)) continue;
    seen.add(key);
    snapshots.push(row);
  }

  const ticketRows = (ticketsRes.data ?? []) as unknown as {
    id: string;
    reference: number | null;
    customer_id: string | null;
    kind: string | null;
    status: string | null;
    subject: string | null;
    submitted_at: string | null;
  }[];

  return {
    asOf,
    lifecycle,
    payments,
    planChanges: (planChangesRes.data ?? []) as unknown as PlanChangeInput[],
    snapshots,
    tickets: ticketRows.map((t) => ({
      id: t.id,
      reference: t.reference,
      customerId: t.customer_id,
      kind: t.kind,
      status: t.status,
      subject: t.subject,
      submittedAt: t.submitted_at,
    })),
    unavailable: false,
    partial,
  };
}
