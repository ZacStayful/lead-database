import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Close a customer's current pause episode (0077).
 *
 * Shared by the two resume paths — the daily cron and the Stripe webhook's
 * resume-detection block — because both must behave identically and neither is
 * allowed to fail the resume it belongs to.
 *
 * REPORTING ONLY. Nothing reads `ended_at` to decide whether a customer is
 * paused; `customers.paused_at` is the authority and both callers clear it
 * themselves. A failure here is a gap in the churn history, never a stuck pause,
 * which is why this logs and returns rather than throwing.
 *
 * Stamps the LATEST open episode by id rather than every open one. Because the
 * stamp is allowed to fail, a customer can be carrying an un-stamped episode
 * from an earlier pause; a blanket `is("ended_at", null)` update would close
 * that one too, with today's date, handing get_pause_outcomes() a pause window
 * that never happened.
 */
export async function stampEpisodeEnded(
  admin: SupabaseClient,
  customerId: string,
  source: string
): Promise<void> {
  const { data: open, error: findError } = await admin
    .from("subscription_pauses")
    .select("id")
    .eq("customer_id", customerId)
    .is("ended_at", null)
    .order("paused_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findError) {
    console.error(`[${source}] could not find open pause episode`, {
      customer: customerId,
      error: findError.message,
    });
    return;
  }
  // No open episode is normal: pauses that predate 0077 beyond the backfill, or
  // an episode insert that failed at pause time.
  if (!open) return;

  const { error: stampError } = await admin
    .from("subscription_pauses")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", open.id);

  if (stampError) {
    console.error(`[${source}] pause episode stamp failed`, {
      customer: customerId,
      episode: open.id,
      error: stampError.message,
    });
  }
}
