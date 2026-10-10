import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_URL } from "@/lib/env";
import {
  sendBriefAreaUpdatedEmail,
  sendBriefPauseConfirmationEmail,
  sendPauseEndingSoonEmail,
} from "@/lib/emails";
import {
  RETURN_DATE_MESSAGES,
  areaChanged,
  checkReturnDate,
  firstNameOf,
  londonToday,
  returnDecision,
  type BriefAreaUpdatedPayload,
  type RecalibrationState,
} from "@/lib/briefPause";
import { canEditLeadBrief } from "@/lib/leadBrief/gate";
import { checkPauseReasons } from "@/lib/pauseOptions";
import { syncCustomerMondayStatus } from "@/lib/mondayStatus";
import { getStripe } from "@/lib/stripe";
import { briefRowFromPreview } from "@/lib/leadBrief/briefRow";
import { computeBriefForCustomer } from "@/lib/leadBrief/briefServer";
import { keptForRecompute, planAndTravelOf, readStoredPriorities } from "@/lib/leadBrief/editBrief";
import { BriefSupplyUnavailableError } from "@/lib/leadBrief/supply";
import type { Customer } from "@/lib/types";

/**
 * A Lead Brief customer's LONG pause (batch 04 Phase 2, locked decision 3),
 * on the server: the area recalculation 7 days before return, and what happens
 * when the return date comes. SERVER-SIDE ONLY — the brief rows read here carry
 * outcode lists, which never reach a browser (A4).
 *
 * Callers:
 *   - /api/cron/resume-paused-subscriptions: the pass 7 days out, and the
 *     return itself;
 *   - /api/customer/subscription/resume: a customer ending a long pause early.
 *
 * Nothing here throws. Every outcome is a value the caller reports.
 */

/** The open pause episode a long pause's recalculation is claimed on (0167). */
export interface LongPauseEpisode {
  id: string;
  resumes_at: string;
  hold_area: boolean | null;
  recalibrated_at: string | null;
  pending_brief_id: string | null;
}

export type EpisodeRead =
  | { ok: true; episode: LongPauseEpisode | null }
  | { ok: false; error: string };

/**
 * The customer's current episode: the latest open one, the stampEpisodeEnded
 * rule. Null when it is not a long brief pause's (hold_area must be false).
 */
export async function findOpenLongEpisode(
  admin: SupabaseClient,
  customerId: string
): Promise<EpisodeRead> {
  const { data, error } = await admin
    .from("subscription_pauses")
    .select("id, resumes_at, hold_area, recalibrated_at, pending_brief_id")
    .eq("customer_id", customerId)
    .is("ended_at", null)
    .order("paused_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  const episode = (data as LongPauseEpisode | null) ?? null;
  if (!episode || episode.hold_area !== false) return { ok: true, episode: null };
  return { ok: true, episode };
}

/** The brief columns a recalculation reads, from the active row and the scheduled one. */
interface BriefBasisRow {
  id: string;
  status: "active" | "scheduled";
  base_postcode: string;
  priority_outcodes: string[] | null;
  travel_limit_miles: number | null;
  min_bedrooms: number | null;
  min_gross: number | null;
  similar_areas: string[] | null;
  priorities: unknown;
  allocation: number;
  service_radius_miles: number;
  service_outcodes: string[] | null;
}

const BASIS_COLUMNS =
  "id, status, base_postcode, priority_outcodes, travel_limit_miles, min_bedrooms, min_gross, similar_areas, priorities, allocation, service_radius_miles, service_outcodes";

export type RecalibrationResult =
  /** The area came out the same: nothing for the customer to confirm. */
  | { kind: "unchanged" }
  /** A pending version was written for the customer to confirm. */
  | {
      kind: "written";
      briefId: string;
      radiusMiles: number;
      previousRadiusMiles: number;
      basePostcode: string;
    }
  /** Another run claimed this pause first. */
  | { kind: "already" }
  /** The customer's brief moved while this ran (0164's check): try again later. */
  | { kind: "conflict" }
  /** Something could not be read or written: try again later. */
  | { kind: "retry"; error: string }
  /** The engine refused the stored answers. */
  | { kind: "invalid"; detail: string }
  /** No active brief. */
  | { kind: "no_brief" };

export type RecalibrationCustomer = Pick<
  Customer,
  "id" | "monthly_allocation" | "pending_monthly_allocation"
>;

/**
 * Recalculate a long-paused customer's area from live supply (locked decision
 * 3), from their NEWEST choice: a scheduled area change if they saved one, else
 * their active brief (C9). The same compute the editor uses
 * (computeBriefForCustomer), so a recalculated area is exactly what the editor
 * would have offered them today.
 *
 * Unchanged → the episode is stamped and nothing else happens.
 * Changed   → write_pending_lead_brief (0168) stores it as the one change in
 *             flight, claiming the episode under the brief's advisory lock.
 */
export async function recalibrateLongPause(
  admin: SupabaseClient,
  customer: RecalibrationCustomer,
  episode: LongPauseEpisode,
  opts: { effectiveAtIso: string; now: Date }
): Promise<RecalibrationResult> {
  const { data, error } = await admin
    .from("customer_lead_briefs")
    .select(BASIS_COLUMNS)
    .eq("customer_id", customer.id)
    .in("status", ["active", "scheduled"]);
  if (error) return { kind: "retry", error: error.message };
  const rows = (data ?? []) as BriefBasisRow[];
  const active = rows.find((r) => r.status === "active") ?? null;
  if (!active) return { kind: "no_brief" };
  const scheduled = rows.find((r) => r.status === "scheduled") ?? null;
  const basis = scheduled ?? active;

  const kept = keptForRecompute(readStoredPriorities(basis.priorities), {
    minBedrooms: basis.min_bedrooms,
    minGross: basis.min_gross,
  });
  const { travel } = planAndTravelOf(basis);

  let computed;
  try {
    computed = await computeBriefForCustomer(
      admin,
      customer,
      {
        input: {
          basePostcode: basis.base_postcode,
          priorityOutcodes: basis.priority_outcodes ?? [],
          travelLimitMiles: travel,
          minBedrooms: basis.min_bedrooms,
          minGross: basis.min_gross,
          similarAreas: basis.similar_areas ?? [],
          ranking: kept.ranking,
          thresholds: kept.thresholds,
        },
        similarAreasGiven: true,
        shownRadiusMiles: null,
      },
      { autoTickRecommended: false }
    );
  } catch (err) {
    if (err instanceof BriefSupplyUnavailableError) return { kind: "retry", error: err.message };
    return { kind: "retry", error: err instanceof Error ? err.message : String(err) };
  }
  if (!computed.ok) {
    return { kind: "invalid", detail: computed.issues.map((i) => i.code).join(",") };
  }
  const preview = computed.preview;

  const changed = areaChanged(
    active,
    { service_radius_miles: preview.serviceRadiusMiles, service_outcodes: preview.serviceOutcodes },
    basis.id !== active.id
  );

  if (!changed) {
    const { data: stamped, error: stampError } = await admin
      .from("subscription_pauses")
      .update({ recalibrated_at: opts.now.toISOString() })
      .eq("id", episode.id)
      .eq("customer_id", customer.id)
      .eq("hold_area", false)
      .is("recalibrated_at", null)
      .is("ended_at", null)
      .select("id")
      .maybeSingle();
    if (stampError) return { kind: "retry", error: stampError.message };
    return stamped ? { kind: "unchanged" } : { kind: "already" };
  }

  const row = briefRowFromPreview(preview, {
    customerId: customer.id,
    // 0168 allocates the version and decides the status, origin and dates.
    version: 1,
    lockedUntil: null,
    now: opts.now,
    chosenKeys: Object.keys(kept.thresholds) as (keyof typeof kept.thresholds)[],
  });
  const { data: written, error: writeError } = await admin.rpc("write_pending_lead_brief", {
    p_customer_id: customer.id,
    p_expected_active_id: active.id,
    p_basis_id: basis.id,
    p_pause_id: episode.id,
    p_row: row,
    p_effective_at: opts.effectiveAtIso,
  });
  if (writeError) return { kind: "retry", error: writeError.message };
  const result = (written as { result?: string; id?: string } | null) ?? null;
  switch (result?.result) {
    case "written":
      return {
        kind: "written",
        briefId: String(result.id),
        radiusMiles: preview.serviceRadiusMiles,
        previousRadiusMiles: active.service_radius_miles,
        basePostcode: active.base_postcode,
      };
    case "conflict":
      return { kind: "conflict" };
    case "not_claimable":
    case "not_paused":
      return { kind: "already" };
    default:
      return { kind: "retry", error: `write_pending_lead_brief returned ${result?.result ?? "nothing"}` };
  }
}

export interface AnnounceCustomer {
  id: string;
  email: string;
  contact_name: string | null;
  phone: string | null;
}

/**
 * Tell the customer their recalculated area is waiting: the Resend email in
 * the batch's words, and an event n8n picks up to send the WhatsApp whose
 * wording Zac approves (C8). Best effort, and never throws: the pending
 * version is already written, and the dashboard (Phase 3) shows it whether or
 * not either message lands.
 *
 * Once per pause by construction: only the run that wrote the pending version
 * gets here, and the event is also unique per episode (0168).
 */
export async function announceAreaUpdated(
  admin: SupabaseClient,
  customer: AnnounceCustomer,
  episode: Pick<LongPauseEpisode, "id">,
  written: Extract<RecalibrationResult, { kind: "written" }>,
  restartDate: string,
  source: string
): Promise<{ emailed: boolean; evented: boolean }> {
  let emailed = false;
  let evented = false;

  try {
    const { error } = await sendBriefAreaUpdatedEmail({
      to: customer.email,
      contactName: customer.contact_name ?? customer.email,
      restartDate,
    });
    if (error) {
      console.error(`[${source}] area-updated email failed`, { customer: customer.id, error });
    } else {
      emailed = true;
    }
  } catch (err) {
    console.error(`[${source}] area-updated email threw`, { customer: customer.id, err });
  }

  const payload: BriefAreaUpdatedPayload = {
    first_name: firstNameOf(customer.contact_name, customer.email),
    phone: customer.phone ?? null,
    email: customer.email,
    return_date: restartDate,
    radius_miles: written.radiusMiles,
    previous_radius_miles: written.previousRadiusMiles,
    base_postcode: written.basePostcode,
    review_url: `${APP_URL}/dashboard`,
  };
  try {
    const { error } = await admin.from("n8n_events").insert({
      event_type: "brief_area_updated",
      customer_id: customer.id,
      subject_id: episode.id,
      payload,
    });
    // 23505: already recorded for this pause. Not an error.
    if (error && error.code !== "23505") {
      console.error(`[${source}] n8n event insert failed`, { customer: customer.id, error: error.message });
    } else {
      evented = true;
    }
  } catch (err) {
    console.error(`[${source}] n8n event insert threw`, { customer: customer.id, err });
  }

  return { emailed, evented };
}

/**
 * The ordinary "your pause ends soon" notice, for a long brief pause whose
 * area came out unchanged. Claimed on pause_ending_notice_sent_at before the
 * send (the 0101 discipline), so it goes once, and never beside the
 * area-updated email.
 */
export async function sendUnchangedAreaNotice(
  admin: SupabaseClient,
  customer: { id: string; email: string; contact_name: string | null },
  resumesAtIso: string,
  source: string
): Promise<boolean> {
  const { data: claimed, error } = await admin
    .from("customers")
    .update({ pause_ending_notice_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", customer.id)
    .is("pause_ending_notice_sent_at", null)
    .select("id")
    .maybeSingle();
  if (error || !claimed) {
    if (error) console.error(`[${source}] notice claim failed`, { customer: customer.id, error: error.message });
    return false;
  }
  const { error: sendError } = await sendPauseEndingSoonEmail({
    to: customer.email,
    contactName: customer.contact_name ?? customer.email,
    resumeDateIso: resumesAtIso,
  });
  if (sendError) {
    console.error(`[${source}] notice email failed`, { customer: customer.id, error: sendError });
    return false;
  }
  return true;
}

export type ReturnSettlement =
  /** Restart their leads now. */
  | { action: "resume"; note?: string }
  /** Stay paused until they confirm the recalculated area (C4). */
  | { action: "hold" }
  /** Could not decide safely: leave them paused and try again. */
  | { action: "retry"; error: string };

export type SettleCustomer = RecalibrationCustomer & AnnounceCustomer;

/**
 * A long brief pause has reached its return date, or the customer asked to
 * end it early. Decides whether to restart their leads (returnDecision), and
 * recalculates first if that has not happened yet.
 *
 * Fails CLOSED to "retry" while the area cannot be recalculated: the customer
 * stays paused, so they are neither sent leads on an area that has not been
 * checked nor charged, and the next run tries again. Two cases fail OPEN to
 * "resume", because holding the customer would have no end: no open episode
 * (nothing to recalculate against), and the engine refusing their stored
 * answers. Both are logged loudly.
 */
export async function settleLongPauseReturn(
  admin: SupabaseClient,
  customer: SettleCustomer,
  opts: { now: Date; source: string }
): Promise<ReturnSettlement> {
  const read = await findOpenLongEpisode(admin, customer.id);
  if (!read.ok) return { action: "retry", error: read.error };
  const episode = read.episode;
  if (!episode) {
    console.error(`[${opts.source}] long brief pause with no open episode; resuming without a recalculation`, {
      customer: customer.id,
    });
    return { action: "resume", note: "no_episode" };
  }

  let pendingStatus: RecalibrationState["pending_status"] = null;
  if (episode.pending_brief_id) {
    const { data, error } = await admin
      .from("customer_lead_briefs")
      .select("status")
      .eq("id", episode.pending_brief_id)
      .maybeSingle();
    if (error) return { action: "retry", error: error.message };
    pendingStatus = ((data as { status?: string } | null)?.status ?? null) as RecalibrationState["pending_status"];
  }

  const decision = returnDecision({
    recalibrated_at: episode.recalibrated_at,
    pending_brief_id: episode.pending_brief_id,
    pending_status: pendingStatus,
  });
  if (decision === "resume") return { action: "resume" };
  if (decision === "await_confirmation") return { action: "hold" };

  // Not recalculated yet: the 7-day pass missed it, or they are ending the
  // pause early. Effective from now when early, from the return date otherwise.
  const resumesAt = Date.parse(episode.resumes_at);
  const effectiveAtIso =
    Number.isFinite(resumesAt) && opts.now.getTime() < resumesAt
      ? opts.now.toISOString()
      : episode.resumes_at;
  const result = await recalibrateLongPause(admin, customer, episode, {
    effectiveAtIso,
    now: opts.now,
  });
  switch (result.kind) {
    case "unchanged":
      return { action: "resume" };
    case "written":
      await announceAreaUpdated(admin, customer, episode, result, londonToday(opts.now), opts.source);
      return { action: "hold" };
    case "invalid":
      console.error(`[${opts.source}] the engine refused the stored brief; resuming without a recalculation`, {
        customer: customer.id,
        detail: result.detail,
      });
      return { action: "resume", note: "invalid" };
    case "no_brief":
      console.error(`[${opts.source}] long brief pause with no active brief; resuming`, { customer: customer.id });
      return { action: "resume", note: "no_brief" };
    case "already":
    case "conflict":
      return { action: "retry", error: result.kind };
    case "retry":
      return { action: "retry", error: result.error };
  }
}

// --- pausing --------------------------------------------------------------

/** The columns pauseBriefCustomer reads. */
export const BRIEF_PAUSE_CUSTOMER_COLUMNS =
  "id, email, contact_name, account_status, subscription_status, gr_subscription_status, stripe_subscription_id, paused_at, pause_count, lead_brief_required, lead_brief_completed_at";

export type BriefPauseCustomer = Pick<
  Customer,
  | "id"
  | "email"
  | "contact_name"
  | "account_status"
  | "subscription_status"
  | "gr_subscription_status"
  | "stripe_subscription_id"
  | "paused_at"
  | "pause_count"
  | "lead_brief_required"
  | "lead_brief_completed_at"
>;

export type BriefPauseResult =
  | {
      ok: true;
      pausedAt: string;
      resumesAtIso: string;
      returnDate: string;
      holdArea: boolean;
    }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Pause a Lead Brief customer's leads until a return DATE (batch 04 Phase 2).
 *
 * The same guards and the same order as the existing pause route (an active
 * Management subscription, not already paused; DB first, then Stripe, rolled
 * back if Stripe fails), with three differences:
 *
 *   - the return date is checked against the server's clock (briefPause.ts):
 *     tomorrow to 3 months away, London dates;
 *   - pause_holds_area is stamped with it: true for 28 days or fewer (the area
 *     is kept, locked decision 2), false for longer (released, decision 3);
 *   - ⚠️ THE EPISODE IS INSERTED BEFORE STRIPE AND IS NOT BEST EFFORT. The
 *     existing route treats it as reporting only; here a long pause's
 *     recalculation is claimed on it (0168), so a pause without one could never
 *     be recalculated. An insert failure rolls the pause back. If Stripe then
 *     fails, the episode is deleted too; a delete that fails leaves an episode
 *     for a pause that never happened, which is a reporting gap and nothing
 *     more (no cron reads an episode without a live pause).
 */
export async function pauseBriefCustomer(
  admin: SupabaseClient,
  customer: BriefPauseCustomer,
  input: { returnDate: unknown; reasons: unknown; note: unknown },
  opts: { now: Date; source: string }
): Promise<BriefPauseResult> {
  if (!canEditLeadBrief(customer)) {
    return {
      ok: false,
      status: 409,
      error: "Pausing to a date is for customers with a Lead Brief.",
      code: "not_brief_customer",
    };
  }

  const reasons = checkPauseReasons(input.reasons, input.note);
  if (!reasons.ok) return { ok: false, status: 400, error: reasons.error };

  const date = checkReturnDate(input.returnDate, opts.now);
  if (!date.ok) {
    return { ok: false, status: 400, error: RETURN_DATE_MESSAGES[date.code], code: date.code };
  }

  const isManagementActive =
    customer.account_status === "active" &&
    customer.subscription_status === "active" &&
    Boolean(customer.stripe_subscription_id);
  if (!isManagementActive) {
    return {
      ok: false,
      status: 409,
      error: "Pausing is only available on an active management subscription.",
    };
  }
  if (customer.paused_at) {
    return { ok: false, status: 409, error: "Your subscription is already paused." };
  }

  const nowIso = opts.now.toISOString();

  // Guarded, race-safe write, as the existing route: a double submit pauses
  // at most once.
  const { data: updated, error: updateError } = await admin
    .from("customers")
    .update({
      paused_at: nowIso,
      pause_resumes_at: date.resumesAtIso,
      pause_ending_notice_sent_at: null,
      pause_count: (customer.pause_count ?? 0) + 1,
      pause_holds_area: date.holdArea,
      updated_at: nowIso,
    })
    .eq("id", customer.id)
    .eq("account_status", "active")
    .eq("subscription_status", "active")
    .is("paused_at", null)
    .select("id")
    .maybeSingle();
  if (updateError) return { ok: false, status: 500, error: updateError.message };
  if (!updated) {
    return {
      ok: false,
      status: 409,
      error: "Your subscription could not be paused. Please refresh and try again.",
    };
  }

  const rollBack = () =>
    admin
      .from("customers")
      .update({
        paused_at: null,
        pause_resumes_at: null,
        pause_count: customer.pause_count ?? 0,
        pause_holds_area: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", customer.id);

  const { data: episode, error: episodeError } = await admin
    .from("subscription_pauses")
    .insert({
      customer_id: customer.id,
      paused_at: nowIso,
      resumes_at: date.resumesAtIso,
      months: null,
      hold_area: date.holdArea,
      reasons: reasons.reasons,
      note: reasons.note,
    })
    .select("id")
    .maybeSingle();
  if (episodeError || !episode) {
    await rollBack();
    console.error(`[${opts.source}] brief pause episode insert failed; rolled back`, {
      customer: customer.id,
      error: episodeError?.message,
    });
    return { ok: false, status: 500, error: "Could not pause your leads. Please try again." };
  }

  try {
    await getStripe().subscriptions.update(customer.stripe_subscription_id as string, {
      pause_collection: { behavior: "void" },
    });
  } catch (err) {
    await rollBack();
    const { error: deleteError } = await admin.from("subscription_pauses").delete().eq("id", episode.id);
    if (deleteError) {
      console.error(`[${opts.source}] episode for a rolled-back pause could not be deleted`, {
        customer: customer.id,
        episode: episode.id,
        error: deleteError.message,
      });
    }
    console.error(`[${opts.source}] Stripe pause failed; rolled back`, err);
    return { ok: false, status: 502, error: "Could not pause billing. Please try again." };
  }

  const { error: emailError } = await sendBriefPauseConfirmationEmail({
    to: customer.email,
    contactName: customer.contact_name ?? customer.email,
    restartDate: date.returnDate,
    holdArea: date.holdArea,
  });
  if (emailError) {
    console.error(`[${opts.source}] confirmation email failed`, { customer: customer.id, error: emailError });
  }

  try {
    const push = await syncCustomerMondayStatus(admin, customer.id, { reason: opts.source });
    if (push.error || push.skipped === "board_unreadable" || push.skipped === "unlinked") {
      console.error(`[${opts.source}] Monday status push did not land`, {
        customer: customer.id,
        skipped: push.skipped,
        error: push.error,
      });
    }
  } catch (err) {
    console.error(`[${opts.source}] Monday status push threw`, err);
  }

  return {
    ok: true,
    pausedAt: nowIso,
    resumesAtIso: date.resumesAtIso,
    returnDate: date.returnDate,
    holdArea: date.holdArea,
  };
}
