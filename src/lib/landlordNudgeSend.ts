/**
 * Sending the §41.1 reminders — the impure half.
 *
 * Driven by a phase in /api/cron/poll-whatsapp-status, never by an operator
 * action and never by completeAssignment. Two reminders per lead, ever, at 48h
 * and 72h after a DELIVERED introduction, and then it stops.
 *
 * ⚠️ THE REMINDER IS NOT AN OPERATOR APPROACH, AND NOTHING HERE MAY MAKE IT
 * ONE. 0127's landlord_approach_ok caps approaches to one landlord at 1/day and
 * 3/week, counting only 'tel_click', 'whatsapp_click', 'mailto_click' and
 * 'message_sent' — its own header states why ours is excluded: "our own
 * reminders and the landlord's own reply are not approaches by anybody". So
 * this module never calls that function, and never writes an event in its
 * counted set. A Stayful email about who is going to ring must not eat an
 * operator's ration of actual contact.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { sendLandlordNudgeEmail } from "@/lib/emails";
import { shouldReferLandlord } from "@/lib/landlordReferral";
import type { ReferralOperator } from "@/lib/landlordReferral";
import { buildNudgeCopy, renderNudgeBody, type NudgeLead } from "@/lib/landlordNudge";
import { mintReferralToken } from "@/lib/landlordReferralToken";
import { isRetryableSendError } from "@/lib/landlordReferralSend";
import {
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
  withinSendingHours,
} from "@/lib/messaging/sendWindow";

type Admin = ReturnType<typeof createAdminClient>;

/** 600ms — Resend's documented 2/second, the pace the announcement sender uses. */
export const NUDGE_PACING_MS = 600;

/** One run's ceiling. The sweep is minutes-tolerant; it does not need to drain. */
export const NUDGE_MAX_PER_RUN = 25;

/**
 * Fails CLOSED, like landlordReferralEnabled and messagingEnabled: an
 * unreadable switch must not start emailing members of the public.
 *
 * ⚠️ A SEPARATE SWITCH FROM `landlord_referral_enabled`, deliberately. It is
 * what lets the introduction run on its own for a fortnight and the reminder be
 * turned on afterwards, once `landlord_prefs_step` carries real drop-off data
 * rather than a guess about where the deck loses people.
 */
export async function landlordNudgeEnabled(admin: Admin): Promise<boolean> {
  const { data, error } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "landlord_referral_nudge_enabled")
    .maybeSingle();
  if (error) return false;
  return (data as { value?: string } | null)?.value === "true";
}

/**
 * Is now a reasonable hour to email a member of the public?
 *
 * Reuses §40.12's window rather than defining a second one. That module is pure
 * and already the codebase's one answer to "what time is it in London", and it
 * is the first time-of-day helper here for a reason worth not undoing: Vercel
 * runs in UTC and Britain is an hour ahead for over half the year, so reading
 * the server clock would mail people an hour early from late March to late
 * October — and would have looked correct in every winter test.
 *
 * ⚠️ A MISSING SETTING MEANS THE DEFAULT WINDOW, not fail-open and not
 * fail-closed. §40.12 settled this: failing closed would refuse every reminder
 * to avoid sending at the wrong hour, failing open would lift the rule exactly
 * when we cannot confirm it. The default IS the rule.
 */
export async function withinNudgeHours(admin: Admin, at: Date): Promise<boolean> {
  const { data } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", ["messaging_quiet_start_hour", "messaging_quiet_end_hour"]);
  const map = new Map(
    ((data ?? []) as { key: string; value: string }[]).map((r) => [r.key, Number(r.value)])
  );
  const pick = (key: string, fallback: number) => {
    const v = map.get(key);
    return Number.isFinite(v) ? (v as number) : fallback;
  };
  return withinSendingHours(
    at,
    pick("messaging_quiet_start_hour", DEFAULT_QUIET_START_HOUR),
    pick("messaging_quiet_end_hour", DEFAULT_QUIET_END_HOUR)
  );
}

/** One row of get_due_landlord_nudges, as the sweep reads it. */
export interface DueNudge {
  lead_id: string;
  customer_id: string;
  nudge_count: number;
  prefs_step: number | null;
  delivered_at: string;
  nudge_sent_at: string | null;
}

export type NudgeOutcome = "sent" | "released" | "failed" | "skipped";

/**
 * Send one reminder.
 *
 * ⚠️ CLAIM BY WRITE, THEN SEND — the credit_invoice discipline (§19.5) and the
 * `pause_ending_notice_sent_at` shape (§21). The sweep runs every five minutes
 * and a slow run can overlap its successor, so checking whether we have already
 * chased and then chasing leaves a real window. Claiming does not.
 *
 * ⚠️ ON A RETRYABLE FAILURE THE CLAIM IS RELEASED, which is the OPPOSITE of
 * what sendLandlordReferral does — and the difference is real rather than an
 * inconsistency. There, a retryable failure keeps its claim because another
 * sender exists and releasing would let them ask the same landlord the same
 * questions twice. Here there is no other sender, so releasing simply means
 * "try again next run", and the 48h/72h windows bound how long that can go on.
 */
export async function sendOneNudge(
  admin: Admin,
  row: DueNudge
): Promise<NudgeOutcome> {
  try {
    const { data: leadRow } = await admin
      .from("leads")
      .select(
        "id, lead_name, email, address, bedrooms, lead_type, owner_customer_id, " +
          "lead_quality_codes, gross_annual_income, landlord_contact_method, " +
          "landlord_contact_time, landlord_wants, landlord_prefs_step"
      )
      .eq("id", row.lead_id)
      .maybeSingle();

    const lead = leadRow as NudgeLead | null;
    if (!lead) return "skipped";

    // The SQL narrows; this is the authority. Restating EMAIL_RE in the query
    // would be a second definition of a rule that already has one.
    const decision = shouldReferLandlord(lead);
    if (!decision.refer) return "skipped";

    const { data: customer } = await admin
      .from("customers")
      .select("business_name, contact_name, email, phone, operator_intro")
      .eq("id", row.customer_id)
      .maybeSingle();
    if (!customer) return "skipped";

    // A token is the whole point of the email; without a secret there is
    // nothing to send them to, so send nothing rather than a dead reminder.
    const token = mintReferralToken(row.lead_id);
    if (!token) return "skipped";

    const attempt: 1 | 2 = row.nudge_count >= 1 ? 2 : 1;

    const claimed = await admin.rpc("claim_landlord_nudge", { p_lead_id: row.lead_id });
    if (claimed.error || claimed.data !== true) return "skipped";

    const copy = buildNudgeCopy({
      lead,
      operator: customer as ReferralOperator,
      attempt,
    });

    const { error: sendError } = await sendLandlordNudgeEmail({
      to: (lead.email ?? "").trim(),
      subject: copy.subject,
      bodyHtml: renderNudgeBody(copy),
      cta: {
        url: `${APP_URL}/p/${token}`,
        label: copy.cta.label,
        note: copy.cta.note,
      },
    });

    if (!sendError) return "sent";

    if (isRetryableSendError(sendError)) {
      await admin.rpc("release_landlord_nudge", {
        p_lead_id: row.lead_id,
        p_error: String(sendError).slice(0, 500),
      });
      return "released";
    }

    // Permanent — a rejected address. The claim stays consumed so we do not
    // walk the same dead mailbox twice more, and the reason is on the row.
    await admin
      .from("leads")
      .update({ landlord_prefs_nudge_error: String(sendError).slice(0, 500) })
      .eq("id", row.lead_id);
    return "failed";
  } catch (error) {
    console.error("sendOneNudge failed", { leadId: row.lead_id, error });
    return "skipped";
  }
}
