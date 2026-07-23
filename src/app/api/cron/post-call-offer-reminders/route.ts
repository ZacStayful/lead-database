import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { getStripe } from "@/lib/stripe";
import { sendPostCallReminderEmail } from "@/lib/emails";
import { sendSms } from "@/lib/sms";
import {
  computeCheckoutUrls,
  formatRemaining,
  type PostCallOffer,
} from "@/lib/postCallOffers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HOUR_MS = 60 * 60 * 1000;

// Reminder thresholds, most-urgent first. `send` at most one per offer per run —
// the most-urgent crossed threshold whose flag is still null.
const THRESHOLDS = [
  { hours: 1, ms: 1 * HOUR_MS, flag: "reminder_1h_sent_at" as const },
  { hours: 4, ms: 4 * HOUR_MS, flag: "reminder_4h_sent_at" as const },
  { hours: 12, ms: 12 * HOUR_MS, flag: "reminder_12h_sent_at" as const },
];

/**
 * GET/POST /api/cron/post-call-offer-reminders
 *
 * Fires reminder email + SMS at 12h / 4h / 1h remaining on unredeemed post-call
 * offers. Auth mirrors /api/monday/sync: Bearer $CRON_SECRET (Vercel Cron) OR an
 * admin session. Runs every 15 minutes.
 */
async function handle(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const viaCron = Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;

  if (!viaCron) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminUser(user)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const admin = createAdminClient();
  const stripe = getStripe();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Candidate offers: unredeemed and still live.
  const { data: offersRaw, error: fetchErr } = await admin
    .from("post_call_offers")
    .select("*")
    .is("redeemed_at", null)
    .gt("expires_at", nowIso);

  if (fetchErr) {
    console.error("reminder cron: fetch failed", fetchErr);
    return NextResponse.json({ error: "Fetch failed" }, { status: 500 });
  }

  const offers = (offersRaw ?? []) as PostCallOffer[];

  let sent = 0;
  let skippedRedeemed = 0;
  let noThreshold = 0;
  const failures: string[] = [];

  for (const offer of offers) {
    const remainingMs = new Date(offer.expires_at).getTime() - nowMs;
    if (remainingMs <= 0) continue;

    // Pick the most-urgent crossed threshold whose flag is unset.
    const target = THRESHOLDS.find(
      (t) => remainingMs <= t.ms && offer[t.flag] == null
    );
    if (!target) {
      noThreshold += 1;
      continue;
    }

    // Re-check Stripe directly — don't rely solely on the local flag. If it's
    // already been redeemed, skip (the webhook will set redeemed_at); never send
    // a reminder for a used code.
    try {
      const promo = await stripe.promotionCodes.retrieve(
        offer.stripe_promo_code_id
      );
      if ((promo.times_redeemed ?? 0) > 0) {
        skippedRedeemed += 1;
        continue;
      }
    } catch (err) {
      // Couldn't verify with Stripe — skip this offer this run rather than risk
      // reminding on a possibly-redeemed code. It'll be retried next run.
      failures.push(`${offer.id}: stripe_retrieve_failed`);
      console.error("reminder cron: promo retrieve failed", offer.id, err);
      continue;
    }

    const remaining = formatRemaining(offer.expires_at, nowMs);
    let urls;
    try {
      urls = computeCheckoutUrls(offer.promo_code_string);
    } catch (err) {
      failures.push(`${offer.id}: ${err instanceof Error ? err.message : "url_error"}`);
      continue;
    }

    let anyChannelSent = false;

    // Email (always attempted).
    const emailRes = await sendPostCallReminderEmail({
      to: offer.prospect_email,
      prospectName: offer.prospect_name,
      promoCode: offer.promo_code_string,
      remaining,
      checkoutUrl10: urls.checkout_url_10,
      checkoutUrl20: urls.checkout_url_20,
    });
    if (emailRes.error) {
      failures.push(`${offer.id}: email_failed`);
      console.error("reminder cron: email failed", offer.id, emailRes.error);
    } else {
      anyChannelSent = true;
    }

    // SMS (best-effort; a missing/bad phone is skipped, not a failure of the run).
    const smsBody =
      `Stayful: your 10% first-month discount expires in ${remaining}. ` +
      `Code ${offer.promo_code_string}. ` +
      `10-lead plan: ${urls.checkout_url_10} | 20-lead plan: ${urls.checkout_url_20}`;
    const smsRes = await sendSms(offer.prospect_phone, smsBody);
    if (smsRes.ok) {
      anyChannelSent = true;
    } else if (smsRes.reason !== "missing_or_malformed_phone") {
      failures.push(`${offer.id}: sms_${smsRes.reason}`);
      console.error("reminder cron: sms failed", offer.id, smsRes.reason);
    }

    // Mark the sent threshold immediately after a successful send (either
    // channel), before moving to the next prospect, so a re-run never
    // double-sends. Also stamp any COARSER threshold already crossed but never
    // sent (e.g. the cron was down through the 12h window): we send only the
    // single most-urgent reminder this run, and record the skipped ones as
    // handled so they don't fire late out of order on a subsequent run.
    if (anyChannelSent) {
      const stamp = new Date().toISOString();
      const flagUpdate: Record<string, string> = {};
      for (const t of THRESHOLDS) {
        if (remainingMs <= t.ms && offer[t.flag] == null) flagUpdate[t.flag] = stamp;
      }
      const { error: markErr } = await admin
        .from("post_call_offers")
        .update(flagUpdate)
        .eq("id", offer.id);
      if (markErr) {
        failures.push(`${offer.id}: mark_failed`);
        console.error("reminder cron: mark failed", offer.id, markErr);
      } else {
        sent += 1;
      }
    }
  }

  return NextResponse.json({
    status: "ok",
    scanned: offers.length,
    sent,
    skipped_redeemed: skippedRedeemed,
    no_threshold_due: noThreshold,
    failures,
  });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

// GET supports Vercel Cron, which issues a GET with the CRON_SECRET bearer.
export async function GET(request: NextRequest) {
  return handle(request);
}
