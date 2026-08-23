import type { SupabaseClient } from "@supabase/supabase-js";
import { customerMrrPence } from "@/lib/mrr";
import type { Customer } from "@/lib/types";

/**
 * Capture this month's committed revenue, one row per customer per product.
 *
 * The half of the month-over-month series that cannot be derived (0099): plan,
 * status and MRR are current-state columns the Stripe webhook overwrites, and
 * /admin recomputes them live and stores nothing.
 *
 * ⚠️ WRITTEN IN TYPESCRIPT, NOT AS A SQL CAPTURE FUNCTION — deliberately, and
 * against the shape 0064 and 0072 use. Those snapshot SQL functions that
 * already existed. MRR has no SQL definition and never has, so a SQL capture
 * would have to hardcode £150/£300 beside the copy in plans.ts, creating the
 * duplication the convention exists to prevent (§1 on what three copies of a
 * price cost last time). src/lib/mrr.ts stays the single definition and this
 * writes what it returns.
 *
 * A row is written for EVERY customer and BOTH products, including zeros —
 * 0064's rule, and it is right: a zero is a measurement, a missing row is not.
 *
 * The CURRENT month's row is upserted on every run, so the month closes with
 * whatever the last successful capture said. A missed day degrades the closing
 * value by a day; a missed month-end cron would leave a permanent hole, which
 * is the failure mode 0072 and 0081 warn about and that capture-leaderboard has
 * already demonstrated (two captures against six expected Mondays).
 */
export interface CommercialCaptureResult {
  rows: number;
  monthStart: string;
}

/** First day of the month containing `d`, as an ISO date. */
export function monthStartIso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function captureCustomerCommercial(
  admin: SupabaseClient,
  now: Date = new Date()
): Promise<CommercialCaptureResult> {
  const monthStart = monthStartIso(now);
  const capturedOn = now.toISOString().slice(0, 10);

  const { data, error } = await admin.from("customers").select("*");
  if (error) throw error;
  const customers = (data ?? []) as Customer[];

  const rows = customers.flatMap((c) => {
    const m = customerMrrPence(c);
    return [
      {
        customer_id: c.id,
        lead_type: "management",
        month_start: monthStart,
        captured_on: capturedOn,
        mrr_pence: m.managementPence,
        paused_mrr_pence: m.pausedManagementPence,
        // past_due counts as held (§17) — a billing problem to fix in the
        // portal, not a customer who has gone.
        holds_product:
          c.subscription_status === "active" || c.subscription_status === "past_due",
        paused: c.paused_at != null,
        monthly_allocation: c.monthly_allocation,
        subscription_status: c.subscription_status,
        account_status: c.account_status,
        cancel_at_period_end: c.cancel_at_period_end ?? false,
        cancelled_at: c.cancelled_at ?? null,
      },
      {
        customer_id: c.id,
        lead_type: "guaranteed_rent",
        month_start: monthStart,
        captured_on: capturedOn,
        mrr_pence: m.grPence,
        paused_mrr_pence: 0,
        holds_product:
          c.gr_subscription_status === "active" ||
          c.gr_subscription_status === "past_due",
        // paused_at is management-only (§3, invariant 6). GR keeps flowing to a
        // paused management customer, so this is always false and the CHECK on
        // the table enforces it.
        paused: false,
        monthly_allocation: c.gr_monthly_allocation ?? null,
        subscription_status: c.gr_subscription_status,
        // ⚠️ NULL on GR rows. account_status is a management state, and writing
        // it here is exactly how §18A's whole class of bug happens.
        account_status: null,
        cancel_at_period_end: c.gr_cancel_at_period_end ?? false,
        cancelled_at: c.gr_cancelled_at ?? null,
      },
    ];
  });

  if (rows.length === 0) return { rows: 0, monthStart };

  const { error: upsertError } = await admin
    .from("customer_commercial_snapshots")
    .upsert(rows, { onConflict: "customer_id,lead_type,month_start" });
  if (upsertError) throw upsertError;

  return { rows: rows.length, monthStart };
}
