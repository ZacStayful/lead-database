/**
 * Giving back the £3 for a lead we could not analyse.
 *
 * A row is refundable when it is terminally dead: it exhausted its attempts, or
 * the analyser could only produce figures it told us not to trust. We took the
 * money for a property analysis and produced none, so it goes back.
 *
 * ── The doctrine, inverted ────────────────────────────────────────────
 *
 * The charge path releases a claim whose outcome is unknown, so an ambiguous
 * error can never take money and give nothing. A refund faces the same
 * ambiguity from the other side, and the safe direction is the opposite one: an
 * indeterminate refund is LEFT 'due' and re-attempted next run. Worst case we
 * refund twice — which the Stripe idempotency key and the partial unique index
 * on stripe_refund_id both prevent anyway. The failure we must never risk is
 * marking a refund done that never happened, because nothing would ever look at
 * it again.
 *
 * ── Why one refund per job, not per row ───────────────────────────────
 *
 * Three failed rows in a batch of twelve is one £9 line on the customer's
 * statement, not three £3 ones. The per-row breakdown lives in
 * lead_analysis_rows, where it can be read without going to Stripe.
 */

import type Stripe from "stripe";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface RefundResult {
  jobId: string;
  status: "refunded" | "deferred" | "skipped";
  amountPence?: number;
  reason?: string;
}

/**
 * Settle every refund that is owed.
 *
 * Called at the end of a worker run. Never throws: a refund that cannot be
 * issued must not take down the run that just produced somebody else's figures.
 */
export async function settleDueRefunds(
  admin: Admin,
  stripe: Stripe,
  opts: { jobIds?: string[]; limit?: number } = {}
): Promise<RefundResult[]> {
  let query = admin
    .from("lead_analysis_jobs")
    .select("id, customer_id, refund_pence, refund_status")
    .eq("refund_status", "due")
    .limit(opts.limit ?? 20);

  // Restricted to the jobs this run touched when asked; otherwise it also
  // sweeps up anything a previous run left deferred, which is what makes
  // "leave it due and try again" an actual recovery rather than a hope.
  if (opts.jobIds?.length) query = query.in("id", opts.jobIds);

  const { data, error } = await query;
  if (error) {
    console.error("settleDueRefunds: query failed", error);
    return [];
  }

  const results: RefundResult[] = [];
  for (const row of (data ?? []) as Array<{ id: string; refund_pence: number | null }>) {
    results.push(await refundJob(admin, stripe, row.id, row.refund_pence ?? 0));
  }
  return results;
}

async function refundJob(
  admin: Admin,
  stripe: Stripe,
  jobId: string,
  amountPence: number
): Promise<RefundResult> {
  if (amountPence <= 0) {
    return { jobId, status: "skipped", reason: "nothing owed" };
  }

  // The intent to refund against: the token records which payment paid for this
  // job, and the payment records the intent.
  const { data: tokenRow } = await admin
    .from("lead_analysis_tokens")
    .select("payment_id")
    .eq("job_id", jobId)
    .eq("charge_status", "paid")
    .maybeSingle();

  const paymentId = (tokenRow as { payment_id: string | null } | null)?.payment_id ?? null;
  if (!paymentId) {
    // Nothing was ever charged for this job, so there is nothing to give back.
    // Recorded rather than retried for ever.
    await admin
      .from("lead_analysis_jobs")
      .update({ refund_status: "none", refund_pence: 0 })
      .eq("id", jobId)
      .eq("refund_status", "due");
    return { jobId, status: "skipped", reason: "no paid charge for this job" };
  }

  const { data: paymentRow } = await admin
    .from("payments")
    .select("stripe_payment_intent_id")
    .eq("id", paymentId)
    .maybeSingle();

  const intentId =
    (paymentRow as { stripe_payment_intent_id: string | null } | null)
      ?.stripe_payment_intent_id ?? null;

  if (!intentId) {
    console.error("settleDueRefunds: paid charge has no payment intent", { jobId, paymentId });
    return { jobId, status: "deferred", reason: "no payment intent recorded" };
  }

  let refundId: string;
  try {
    const refund = await stripe.refunds.create(
      { payment_intent: intentId, amount: amountPence },
      // Derived from the job, so a re-run of this function returns the ORIGINAL
      // refund rather than issuing a second one.
      { idempotencyKey: `lead_analysis_refund_${jobId}` }
    );
    refundId = refund.id;
  } catch (err) {
    // Deliberately NOT marked failed. Leaving it 'due' costs us at worst
    // another attempt; marking it done when it is not costs the customer their
    // money with nothing left to notice.
    console.error("settleDueRefunds: refund failed, left due for the next run", {
      jobId,
      amountPence,
      err,
    });
    return { jobId, status: "deferred", reason: err instanceof Error ? err.message : "refund failed" };
  }

  const { error: recordError } = await admin.rpc("record_lead_analysis_refund", {
    p_job_id: jobId,
    p_refund_id: refundId,
    p_amount_pence: amountPence,
  });

  if (recordError) {
    // The money HAS gone back; only our record of it failed. Loud, because the
    // next run will try to refund again — and be handed the same refund by the
    // idempotency key rather than issuing a second one.
    console.error("REFUNDED BUT NOT RECORDED — record_lead_analysis_refund errored", {
      jobId,
      refundId,
      amountPence,
      error: recordError,
    });
    return { jobId, status: "deferred", reason: recordError.message };
  }

  return { jobId, status: "refunded", amountPence };
}
