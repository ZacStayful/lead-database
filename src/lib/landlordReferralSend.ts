/**
 * Sending one landlord referral (§41) — the impure half.
 *
 * Called at the end of completeAssignment(), and NOWHERE ELSE. It is downstream
 * of assign_lead_to_customer, the single money path, so like everything else in
 * that follow-through it must never throw: a landlord who is not written to is
 * a missed introduction, where an exception here would be a broken assignment.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { sendLandlordReferralEmail } from "@/lib/emails";
import {
  buildReferralCopy,
  renderReferralBody,
  shouldReferLandlord,
  type ReferralLead,
  type ReferralOperator,
} from "@/lib/landlordReferral";
import { mintReferralToken } from "@/lib/landlordReferralToken";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * 5 seconds, matching sms.ts's SMS_TIMEOUT_MS.
 *
 * ⚠️ THE BUDGET IS THE REASON. The Monday sync declares maxDuration = 60 and
 * fans each lead out to up to three customers sequentially; an unbounded second
 * email per assignment is how that run starts getting cut short. Anything
 * slower than this is treated as retryable and swept later.
 */
const SEND_TIMEOUT_MS = 5000;

/** 1m → 5m → 15m → 1h, then hourly. Ladder taken from messaging/webhookRetry.ts. */
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];

export function nextReferralAttemptAt(attempts: number, now = Date.now()): Date {
  const step = BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)];
  return new Date(now + step);
}

/**
 * Is this failure worth retrying?
 *
 * ⚠️ THE TWO BRANCHES ARE NOT SYMMETRIC AND THE ASYMMETRY IS THE POINT.
 * Retryable keeps the claim, so the questions stay reserved for this
 * assignment. Permanent releases it, so the NEXT operator's introduction
 * carries them instead. Getting it backwards either burns the one chance to ask
 * or asks the same landlord twice.
 *
 * Resend reports an invalid recipient as a 4xx that is not 429; anything else —
 * a timeout, a 429, a 5xx, a dropped connection — is ours or theirs and will
 * very likely work in a minute.
 */
export function isRetryableSendError(err: unknown): boolean {
  if (!err) return false;
  const status =
    typeof err === "object" && err !== null && "statusCode" in err
      ? Number((err as { statusCode?: unknown }).statusCode)
      : NaN;
  if (Number.isFinite(status)) {
    if (status === 429) return true;
    if (status >= 500) return true;
    if (status >= 400) return false; // a rejected address will never improve
  }
  return true; // timeouts, network errors, anything unrecognised
}

/** Fails CLOSED, like emailChannelEnabled in messaging/service.ts. */
export async function landlordReferralEnabled(admin: Admin): Promise<boolean> {
  const { data, error } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "landlord_referral_enabled")
    .maybeSingle();
  if (error) return false;
  return (data as { value?: string } | null)?.value === "true";
}

export type ReferralOutcome =
  | { sent: true }
  | { sent: false; skipped: string }
  | { sent: false; deferred: true }
  | { sent: false; failed: true };

/**
 * The whole send, for one assignment.
 *
 * Order is load-bearing and mirrors credit_invoice's discipline (§19.5):
 * claim by write FIRST, then act. Checking whether we have already sent and
 * then sending leaves a window; claiming does not.
 */
export async function sendLandlordReferral(
  admin: Admin,
  params: { lead: ReferralLead; customerId: string; assignmentId: string }
): Promise<ReferralOutcome> {
  const { lead, customerId, assignmentId } = params;

  try {
    if (!(await landlordReferralEnabled(admin))) {
      return { sent: false, skipped: "disabled" };
    }

    const decision = shouldReferLandlord(lead);
    if (!decision.refer) return { sent: false, skipped: decision.reason };

    const { data: customer } = await admin
      .from("customers")
      .select("business_name, contact_name, email, phone, operator_intro")
      .eq("id", customerId)
      .maybeSingle();
    if (!customer) return { sent: false, skipped: "no_customer" };

    // Claim before sending. Exactly one caller per lead is told to ask.
    const { data: claimRows, error: claimError } = await admin.rpc(
      "claim_landlord_referral",
      { p_assignment_id: assignmentId }
    );
    if (claimError) return { sent: false, skipped: "claim_failed" };

    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claim?.claimed) return { sent: false, skipped: "already_claimed" };
    const askQuestions = claim.ask_questions === true;

    const copy = buildReferralCopy({
      lead,
      operator: customer as ReferralOperator,
      askQuestions,
    });

    // No secret configured means no link, not a broken one. The introduction
    // is still worth sending without the questions.
    const token = askQuestions ? mintReferralToken(lead.id) : null;
    const prefsUrl = token ? `${APP_URL}/p/${token}` : null;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ id: null; error: unknown }>((resolve) => {
      timer = setTimeout(
        () => resolve({ id: null, error: new Error("timeout") }),
        SEND_TIMEOUT_MS
      );
    });
    const { error: sendError } = await Promise.race([
      sendLandlordReferralEmail({
        to: (lead.email ?? "").trim(),
        subject: copy.subject,
        bodyHtml: renderReferralBody(copy),
        cta: copy.cta && prefsUrl
          ? { url: prefsUrl, label: copy.cta.label, note: copy.cta.note }
          : null,
      }),
      timeout,
    ]).finally(() => {
      // Without this the pending timer can hold a serverless invocation open
      // for the rest of the window after the send has already resolved.
      if (timer) clearTimeout(timer);
    });

    if (!sendError) {
      await admin
        .from("lead_assignments")
        .update({
          landlord_referral_sent_at: new Date().toISOString(),
          landlord_referral_error: null,
          landlord_referral_next_attempt_at: null,
        })
        .eq("id", assignmentId);
      return { sent: true };
    }

    if (isRetryableSendError(sendError)) {
      // KEEP the claim. Releasing here would let the next operator's referral
      // ask the same landlord the same questions.
      //
      // Read the attempt count back rather than assuming one: the claim RPC
      // increments it, and a hardcoded first step would pin every retry at 60s
      // for ever instead of backing off. One extra read, on the failure path
      // only.
      const { data: row } = await admin
        .from("lead_assignments")
        .select("landlord_referral_attempts")
        .eq("id", assignmentId)
        .maybeSingle();
      const attempts =
        Number((row as { landlord_referral_attempts?: number } | null)
          ?.landlord_referral_attempts) || 1;

      await admin
        .from("lead_assignments")
        .update({
          landlord_referral_error: String(sendError).slice(0, 500),
          landlord_referral_next_attempt_at:
            nextReferralAttemptAt(attempts).toISOString(),
        })
        .eq("id", assignmentId);
      return { sent: false, deferred: true };
    }

    // Permanent. Give the questions back so the next operator asks them.
    await admin.rpc("release_landlord_referral", {
      p_assignment_id: assignmentId,
      p_was_first: askQuestions,
      p_error: String(sendError).slice(0, 500),
    });
    return { sent: false, failed: true };
  } catch (error) {
    // Never throws — see the header.
    console.error("sendLandlordReferral failed", { assignmentId, error });
    return { sent: false, skipped: "threw" };
  }
}

/**
 * How long a claimed-but-unsent referral is retried before we stop.
 *
 * 24h rather than the 48h the WhatsApp poller allows itself: an introduction
 * that arrives two days after the operator has already rung is worse than none,
 * because it tells the landlord they were about to be called by someone who
 * called yesterday.
 */
export const REFERRAL_ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Resend's documented limit is 2 requests a second (§21.3), which is why the
 * announcement sender paces itself at 600ms. This sweep exists BECAUSE of that
 * limit, so it must not reproduce the problem it is cleaning up after.
 */
export const REFERRAL_RETRY_PACING_MS = 600;

/** Bounded per run so one bad afternoon cannot eat the shared wall clock. */
export const REFERRAL_RETRY_MAX_PER_RUN = 25;

/**
 * Has this claim been retried for long enough to stop?
 *
 * Pure, so it is testable with no client at all — the position §40.12 takes
 * about sendWindow.ts, and for the same reason: a decision buried in an
 * impure function is a decision nobody checks.
 */
export function shouldAbandonReferral(
  claimedAt: string | null | undefined,
  now = Date.now()
): boolean {
  if (!claimedAt) return false; // unknown age is not evidence of an old claim
  const t = Date.parse(claimedAt);
  if (!Number.isFinite(t)) return false;
  return now - t > REFERRAL_ABANDON_AFTER_MS;
}

/**
 * Should a RETRY carry the three questions?
 *
 * Nothing stored the original answer, so it is re-derived — conservatively.
 * The questions have only genuinely been asked if an email actually went, so
 * this asks when the lead holds the first-flag AND no assignment for it has
 * been delivered.
 *
 * ⚠️ The one case that reads conservatively: a sibling that succeeded WITHOUT
 * the questions while this one was failing. Then this retry stays quiet and
 * that landlord is never asked. Under-asking costs one landlord's preferences;
 * over-asking sends the same person the same questions twice, which is the
 * failure the whole once-only design exists to prevent.
 */
export function retryShouldAskQuestions(
  leadFirstSentAt: string | null | undefined,
  noSiblingSent: boolean,
  answered?: {
    landlord_contact_method?: string | null;
    landlord_contact_time?: string | null;
    landlord_wants?: string[] | null;
  }
): boolean {
  // ⚠️ Since 0129 a landlord can answer between the claim and the retry — the
  // reminder sweep, or a second operator's introduction, may have got through
  // while this one was failing. Asking again then is the one thing the
  // once-only design exists to prevent, so the spine is re-read at send time.
  //
  // The spine, never `landlord_prefs_submitted_at`: that is stamped by ANY
  // single answer, so it would silence the questions for somebody who has
  // answered one of three.
  //
  // The ask CAP is deliberately NOT re-checked here. `claim_landlord_referral`
  // already counted this ask when it claimed; a retry is the same ask being
  // delivered, not a new one, so testing `ask_count < 3` would refuse the third
  // ask precisely because it is the third.
  if (answered) {
    const complete =
      Boolean(answered.landlord_contact_method) &&
      Boolean(answered.landlord_contact_time) &&
      Boolean(answered.landlord_wants?.length);
    if (complete) return false;
  }
  return Boolean(leadFirstSentAt) && noSiblingSent;
}

export interface RetryableReferral {
  id: string;
  customer_id: string;
  landlord_referral_attempts: number;
  landlord_referral_claimed_at: string | null;
  lead: ReferralLead & {
    landlord_referral_first_sent_at?: string | null;
    landlord_contact_method?: string | null;
    landlord_contact_time?: string | null;
    landlord_wants?: string[] | null;
  };
  /** True when NO assignment for this lead has actually been sent yet. */
  noSiblingSent: boolean;
}

export type RetryOutcome = "sent" | "deferred" | "failed" | "abandoned" | "skipped";

/**
 * Re-send one referral that was claimed and never delivered.
 *
 * ⚠️ IT DOES NOT CLAIM. The claim already exists — that is what put the row in
 * this queue — and calling claim_landlord_referral again would return
 * `claimed: false` and skip the row for ever.
 *
 * ⚠️ WHETHER TO ASK THE QUESTIONS IS RE-DERIVED, not remembered. Nothing stored
 * the original answer, and re-deriving it conservatively is better than
 * guessing: the questions have only genuinely been ASKED if an email actually
 * went. So this asks when the lead holds the first-flag AND no assignment for
 * it has sent. The one case that reads conservatively is a sibling that
 * succeeded without the questions while this one was failing — then this retry
 * stays quiet. Under-asking costs one landlord's preferences; over-asking sends
 * the same person the same questions twice.
 */
export async function retryOneReferral(
  admin: Admin,
  row: RetryableReferral,
  now = Date.now()
): Promise<RetryOutcome> {
  try {
    const decision = shouldReferLandlord(row.lead);
    if (!decision.refer) {
      // The lead changed under us — an admin cleared the address, say. Stop
      // retrying rather than hammering an address that will never accept mail.
      await admin.rpc("release_landlord_referral", {
        p_assignment_id: row.id,
        p_was_first: row.noSiblingSent,
        p_error: `no longer referable: ${decision.reason}`,
      });
      return "failed";
    }

    if (shouldAbandonReferral(row.landlord_referral_claimed_at, now)) {
      // Give the questions back if nobody was ever actually asked, so a future
      // operator's introduction can carry them.
      await admin.rpc("release_landlord_referral", {
        p_assignment_id: row.id,
        p_was_first: row.noSiblingSent,
        p_error: "abandoned after 24h of retries",
      });
      return "abandoned";
    }

    const { data: customer } = await admin
      .from("customers")
      .select("business_name, contact_name, email, phone, operator_intro")
      .eq("id", row.customer_id)
      .maybeSingle();
    if (!customer) return "skipped";

    const askQuestions = retryShouldAskQuestions(
      row.lead.landlord_referral_first_sent_at,
      row.noSiblingSent,
      row.lead
    );

    const copy = buildReferralCopy({
      lead: row.lead,
      operator: customer as ReferralOperator,
      askQuestions,
    });
    const token = askQuestions ? mintReferralToken(row.lead.id) : null;
    const prefsUrl = token ? `${APP_URL}/p/${token}` : null;

    const { error: sendError } = await sendLandlordReferralEmail({
      to: (row.lead.email ?? "").trim(),
      subject: copy.subject,
      bodyHtml: renderReferralBody(copy),
      cta:
        copy.cta && prefsUrl
          ? { url: prefsUrl, label: copy.cta.label, note: copy.cta.note }
          : null,
    });

    if (!sendError) {
      await admin
        .from("lead_assignments")
        .update({
          landlord_referral_sent_at: new Date(now).toISOString(),
          landlord_referral_error: null,
          landlord_referral_next_attempt_at: null,
        })
        .eq("id", row.id);
      return "sent";
    }

    if (isRetryableSendError(sendError)) {
      const attempts = (row.landlord_referral_attempts ?? 0) + 1;
      await admin
        .from("lead_assignments")
        .update({
          landlord_referral_attempts: attempts,
          landlord_referral_error: String(sendError).slice(0, 500),
          landlord_referral_next_attempt_at: nextReferralAttemptAt(attempts, now).toISOString(),
        })
        .eq("id", row.id);
      return "deferred";
    }

    await admin.rpc("release_landlord_referral", {
      p_assignment_id: row.id,
      p_was_first: row.noSiblingSent,
      p_error: String(sendError).slice(0, 500),
    });
    return "failed";
  } catch (error) {
    console.error("retryOneReferral failed", { assignmentId: row.id, error });
    return "skipped";
  }
}
