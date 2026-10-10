import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { issuePostCallOffer } from "@/lib/postCallOfferIssue";
import { customersByEmail } from "@/lib/funnel/server";
import { isAlreadySetUp } from "@/lib/funnel/session";

/**
 * The funnel's discount (batch 02 Phase 5): somebody who previewed and has not
 * paid an hour later gets the same 24-hour, single-use `FOUNDING10-` code a
 * post-call prospect gets (locked decision 3), issued through the same path
 * (postCallOfferIssue.ts) with `source = 'funnel'`.
 *
 * ⚠️ ONE CODE PER PERSON, ACROSS BOTH ROUTES. The issuer returns a live code
 * the person already holds rather than making a second, and that code is then
 * linked to the session so the funnel's checkout applies it. A session is
 * linked once and never offered again, so a code that expires unused is not
 * replaced.
 *
 * Who qualifies: a session at `previewed` or `checkout_started`, unpaid, with
 * no code yet, quiet for at least an hour (updated_at is touched on every
 * answer and preview, 0165). And quiet for no more than a week: a session
 * abandoned long ago is not chased with a code, which also stops the first run
 * after switch-on from mailing everybody who ever previewed.
 *
 * The code reaches them through the existing reminders (12h, 4h and 1h before
 * expiry, post-call-offer-reminders), whose /pay links send a funnel offer
 * back through the funnel's own checkout, and on the funnel page itself.
 */

export const FUNNEL_DISCOUNT_AFTER_MS = 60 * 60 * 1000;
export const FUNNEL_DISCOUNT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const FUNNEL_DISCOUNT_BATCH = 25;

export const FUNNEL_DISCOUNT_STEPS = ["previewed", "checkout_started"] as const;

export interface DiscountCandidate {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  step: string;
  updated_at: string;
  paid_at: string | null;
  discount_offer_id: string | null;
}

/** The same rule the query applies, stated once for the tests and the dry run. */
export function funnelDiscountDue(session: DiscountCandidate, now: Date): boolean {
  if (session.paid_at || session.discount_offer_id) return false;
  if (!(FUNNEL_DISCOUNT_STEPS as readonly string[]).includes(session.step)) return false;
  const idle = now.getTime() - new Date(session.updated_at).getTime();
  return idle >= FUNNEL_DISCOUNT_AFTER_MS && idle <= FUNNEL_DISCOUNT_WINDOW_MS;
}

export interface FunnelDiscountRun {
  ok: boolean;
  dryRun: boolean;
  checked: number;
  issued: number;
  linkedExisting: number;
  skippedCustomers: number;
  failed: number;
  wouldIssue?: string[];
  error?: string;
}

export async function issueFunnelDiscounts(
  admin: SupabaseClient,
  opts: { now?: Date; dryRun?: boolean; stripe?: Stripe } = {}
): Promise<FunnelDiscountRun> {
  const now = opts.now ?? new Date();
  const run: FunnelDiscountRun = {
    ok: true,
    dryRun: Boolean(opts.dryRun),
    checked: 0,
    issued: 0,
    linkedExisting: 0,
    skippedCustomers: 0,
    failed: 0,
  };

  const quietSince = new Date(now.getTime() - FUNNEL_DISCOUNT_AFTER_MS).toISOString();
  const notBefore = new Date(now.getTime() - FUNNEL_DISCOUNT_WINDOW_MS).toISOString();
  const { data, error } = await admin
    .from("funnel_sessions")
    .select("id, name, email, phone, step, updated_at, paid_at, discount_offer_id")
    .in("step", [...FUNNEL_DISCOUNT_STEPS])
    .is("discount_offer_id", null)
    .is("paid_at", null)
    .lt("updated_at", quietSince)
    .gt("updated_at", notBefore)
    .order("updated_at", { ascending: true })
    .limit(FUNNEL_DISCOUNT_BATCH);
  if (error) {
    console.error("[funnel-discount] session read failed", error.message);
    return { ...run, ok: false, error: "sessions_unreadable" };
  }

  const due = ((data ?? []) as DiscountCandidate[]).filter((s) => funnelDiscountDue(s, now));
  run.checked = due.length;
  if (opts.dryRun) return { ...run, wouldIssue: due.map((s) => s.id) };

  for (const session of due) {
    // Somebody already set up is never offered a discount on a plan they hold.
    const customers = await customersByEmail(admin, session.email);
    if (!customers.ok) {
      console.error("[funnel-discount] customer lookup failed", session.id, customers.message);
      run.failed += 1;
      continue;
    }
    if (customers.customers.some(isAlreadySetUp)) {
      run.skippedCustomers += 1;
      continue;
    }

    const issued = await issuePostCallOffer(
      admin,
      { email: session.email, name: session.name, phone: session.phone, source: "funnel", createdBy: null },
      // The pass's own clock, so "is the existing code still live" is judged
      // at the same moment as "is this session due".
      { stripe: opts.stripe, now: () => now.getTime() }
    );
    if (!issued.ok) {
      console.error("[funnel-discount] could not issue a code", session.id, issued.reason, issued.message);
      run.failed += 1;
      continue;
    }

    // Linked only while still unpaid and unlinked: a session that paid or got
    // a code in the meantime keeps what it has.
    const linked = await admin
      .from("funnel_sessions")
      .update({ discount_offer_id: issued.offerId })
      .eq("id", session.id)
      .is("discount_offer_id", null)
      .is("paid_at", null);
    if (linked.error) {
      console.error("[funnel-discount] could not link the code", session.id, linked.error.message);
      run.failed += 1;
      continue;
    }
    if (issued.status === "created") run.issued += 1;
    else run.linkedExisting += 1;
  }
  return run;
}
