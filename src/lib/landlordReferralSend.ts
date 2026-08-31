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
