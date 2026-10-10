import type { SupabaseClient } from "@supabase/supabase-js";
import { OUTCODE_CENTROIDS } from "@/lib/outcodes";
import {
  addMonthsClampedYmd,
  firstNameOf,
  londonMidnightIso,
  londonToday,
  onLongBriefPause,
} from "@/lib/briefPause";
import { findOpenLongEpisode } from "@/lib/briefPauseServer";
import { sendBriefAreaConfirmedEmail, sendBriefPauseConfirmationEmail } from "@/lib/emails";
import { briefRowFromPreview } from "@/lib/leadBrief/briefRow";
import { computeBriefForCustomer } from "@/lib/leadBrief/briefServer";
import {
  BriefVersionsUnavailableError,
  loadBriefVersions,
  type BriefVersionRow,
} from "@/lib/leadBrief/briefVersions";
import { EXTEND_MESSAGES } from "@/lib/leadBrief/areaConfirmCopy";
import { briefPlanFor, canEditLeadBrief } from "@/lib/leadBrief/gate";
import { parsedBodyFromRow } from "@/lib/leadBrief/rowInput";
import { BriefSupplyUnavailableError } from "@/lib/leadBrief/supply";
import { nextGrantDate } from "@/lib/quality/replacementEntitlement";
import {
  resumePausedCustomer,
  resumeRefusalReason,
  type ResumeOutcome,
} from "@/lib/resumePause";
import type { Customer } from "@/lib/types";

/**
 * The confirm-on-login screen, on the server (batch 04 Phase 3, locked
 * decision 4). SERVER-SIDE ONLY: the brief rows read here carry outcode lists,
 * which never reach a browser (A4). The screen gets radii, a postcode, a
 * centre point and dates, nothing else.
 *
 * Callers:
 *   - (the dashboard gate's read is src/lib/leadBrief/pendingArea.ts, kept
 *     apart so the layout loads nothing of this module);
 *   - /onboarding/area (`loadAreaConfirmation`);
 *   - POST /api/customer/lead-brief/area/{confirm,tighten,extend};
 *   - /api/cron/accept-lead-brief-areas, the 72-hour auto-accept.
 *
 * Nothing here throws on a database or supply failure. Every outcome is a
 * value the caller reports.
 *
 * WHEN CONFIRMING RESTARTS LEADS. Only a RETURN from a long pause holds
 * delivery, by keeping the customer paused (C4). Confirming restarts them
 * when the pending area's effective date has come: the return date, or the
 * moment they asked to end the pause early (Phase 2 writes it as `now`).
 * Before the return date the area is confirmed and the leads restart on the
 * date they chose, which is what the area-updated email told them ("Review it
 * before your leads restart on [date]"); the resume cron restarts them then,
 * because the pending version is now active (returnDecision). "Switch to 10
 * leads" restarts them at once, because the plan route refuses a paused
 * customer (C5), and the screen says so before they press it.
 */

export const AREA_CONFIRM_CUSTOMER_COLUMNS =
  "id, email, contact_name, phone, stripe_subscription_id, is_active, account_status, subscription_status, gr_subscription_status, paused_at, pause_holds_area, pause_resumes_at, cancel_at_period_end, monthly_allocation, pending_monthly_allocation, billing_cycle_anchor, gr_billing_cycle_anchor, created_at, lead_brief_required, lead_brief_completed_at";

export type AreaConfirmCustomer = Pick<
  Customer,
  | "id"
  | "email"
  | "contact_name"
  | "phone"
  | "stripe_subscription_id"
  | "is_active"
  | "account_status"
  | "subscription_status"
  | "gr_subscription_status"
  | "paused_at"
  | "pause_holds_area"
  | "pause_resumes_at"
  | "cancel_at_period_end"
  | "monthly_allocation"
  | "pending_monthly_allocation"
  | "billing_cycle_anchor"
  | "gr_billing_cycle_anchor"
  | "created_at"
  | "lead_brief_required"
  | "lead_brief_completed_at"
>;

// --- timing (pure) -------------------------------------------------------------

export interface RestartTiming {
  /** A return from a long pause (the customer is held, paused). */
  isReturn: boolean;
  /** Confirming restarts their leads now. */
  resumeNow: boolean;
  /**
   * The London date their leads restart on: today when resuming now, the
   * return date when they confirm early, null for a widening (never stopped).
   */
  restartYmd: string | null;
}

/**
 * When confirming restarts the leads. PURE.
 *
 * `restartNow` is "Switch to 10 leads" before the return date (C5): the plan
 * cannot change while they are paused, so switching restarts them today.
 */
export function restartTiming(
  customer: Pick<Customer, "paused_at" | "pause_holds_area">,
  pendingEffectiveAt: string | null,
  now: Date,
  opts: { restartNow?: boolean } = {}
): RestartTiming {
  const isReturn = onLongBriefPause(customer);
  if (!isReturn) return { isReturn: false, resumeNow: false, restartYmd: null };
  const effective = pendingEffectiveAt ? Date.parse(pendingEffectiveAt) : NaN;
  const due = !Number.isFinite(effective) || now.getTime() >= effective;
  const resumeNow = due || opts.restartNow === true;
  return {
    isReturn: true,
    resumeNow,
    restartYmd: resumeNow ? londonToday(now) : londonToday(new Date(effective)),
  };
}

/**
 * The first picks' lock: until the renewal after the area starts (0164's
 * rule). A restart re-anchors the billing cycle to the restart date
 * (resumePausedCustomer), so a return is locked a month from that date; a
 * widening from the customer's own anchors. PURE.
 */
export function lockedUntilFor(
  customer: Pick<Customer, "billing_cycle_anchor" | "gr_billing_cycle_anchor" | "created_at">,
  timing: RestartTiming,
  now: Date
): string | null {
  if (timing.restartYmd) {
    return nextGrantDate({ billing_cycle_anchor: timing.restartYmd }, new Date(`${timing.restartYmd}T12:00:00Z`));
  }
  return nextGrantDate(
    {
      billing_cycle_anchor: customer.billing_cycle_anchor,
      gr_billing_cycle_anchor: customer.gr_billing_cycle_anchor,
      created_at: customer.created_at,
    },
    now
  );
}

// --- the screen ------------------------------------------------------------------

/** What the browser is given. Radii, a postcode, a point and dates: no outcode lists (A4). */
export interface AreaConfirmView {
  pendingId: string;
  isReturn: boolean;
  /** A return confirmed before its date: the leads restart on the date they chose. */
  beforeReturn: boolean;
  firstName: string;
  basePostcode: string;
  otherAreas: number;
  newMiles: number;
  oldMiles: number;
  /** The 10-lead area's radius, live; null when it cannot be worked out, or they are already on 10. */
  tighterMiles: number | null;
  /** Offered when they are on 20 leads and have not already switched. */
  canSwitch: boolean;
  /** The base outcode's centre, for the map; null when it has no centroid. */
  centre: { lat: number; lng: number } | null;
  /** YYYY-MM-DD (London) the leads restart on, for a return. */
  returnYmd: string | null;
  /** Extend my pause: the date range a new return date may take, for a return. */
  extend: { earliest: string; latest: string } | null;
}

export type AreaConfirmLoad =
  | { kind: "view"; view: AreaConfirmView }
  | { kind: "none" }
  | { kind: "unavailable"; error: string };

/** The base outcode's centroid, for the map. */
export function centreOf(outcode: string): { lat: number; lng: number } | null {
  const c = OUTCODE_CENTROIDS[outcode.toUpperCase()];
  return c ? { lat: c[0], lng: c[1] } : null;
}

/**
 * The 10-lead radius for the pending area's answers, from live supply. Null on
 * any failure: the screen then offers the switch without a number.
 */
async function tighterMilesFor(
  admin: SupabaseClient,
  customer: AreaConfirmCustomer,
  pending: BriefVersionRow
): Promise<number | null> {
  try {
    const { parsed } = parsedBodyFromRow(pending);
    const computed = await computeBriefForCustomer(admin, customer, parsed, { autoTickRecommended: false });
    if (!computed.ok) return null;
    return computed.preview.coverage.find((c) => c.plan === 10)?.radiusMiles ?? null;
  } catch (err) {
    console.error("[area-confirm] 10-lead radius unavailable", {
      customer: customer.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function loadAreaConfirmation(
  admin: SupabaseClient,
  customer: AreaConfirmCustomer,
  now: Date
): Promise<AreaConfirmLoad> {
  let versions;
  try {
    versions = await loadBriefVersions(admin, customer.id);
  } catch (err) {
    if (err instanceof BriefVersionsUnavailableError) return { kind: "unavailable", error: err.message };
    throw err;
  }
  const { active, pending } = versions;
  if (!pending || !active) return { kind: "none" };

  const timing = restartTiming(customer, pending.effective_at, now);
  const switchPending =
    customer.pending_monthly_allocation === 10 && (customer.monthly_allocation ?? 0) > 10;
  const canSwitch = briefPlanFor(customer) === 20 && !switchPending;

  let extend: AreaConfirmView["extend"] = null;
  if (timing.isReturn) {
    const read = await findOpenLongEpisode(admin, customer.id);
    if (read.ok && read.episode && customer.paused_at) {
      const today = londonToday(now);
      const currentReturn = customer.pause_resumes_at ? londonToday(new Date(customer.pause_resumes_at)) : today;
      const after = currentReturn > today ? currentReturn : today;
      const earliest = addDaysAfter(after);
      const latest = addMonthsClampedYmd(londonToday(new Date(customer.paused_at)), 3);
      if (earliest <= latest) extend = { earliest, latest };
    }
  }

  return {
    kind: "view",
    view: {
      pendingId: pending.id,
      isReturn: timing.isReturn,
      beforeReturn: timing.isReturn && !timing.resumeNow,
      firstName: firstNameOf(customer.contact_name, customer.email),
      basePostcode: pending.base_postcode,
      otherAreas: (pending.priority_outcodes ?? []).length,
      newMiles: pending.service_radius_miles,
      oldMiles: active.service_radius_miles,
      tighterMiles: canSwitch ? await tighterMilesFor(admin, customer, pending) : null,
      canSwitch,
      centre: centreOf(pending.base_outcode),
      returnYmd: timing.restartYmd,
      extend,
    },
  };
}

function addDaysAfter(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// --- confirming ----------------------------------------------------------------------

export type ConfirmResult =
  | {
      kind: "confirmed";
      isReturn: boolean;
      /** null when nothing was resumed (a widening, or confirmed before the date). */
      resume: ResumeOutcome | "refused" | null;
      restartYmd: string | null;
      radiusMiles: number;
      basePostcode: string;
    }
  | { kind: "conflict" }
  | { kind: "not_pending" }
  | { kind: "not_due" }
  | { kind: "not_brief_customer" }
  | { kind: "retry"; error: string };

/**
 * Confirm the customer's pending area (or auto-accept it, 72 hours past its
 * effective date), then restart a return whose date has come.
 *
 * First picks are recomputed from live supply first (locked decision 4); if
 * supply cannot be read the stored ones are kept, and 0169 drops any another
 * customer now covers either way. Labels and the "why" checklist need nothing
 * stored: they are worked out per lead from the active version (0163), which
 * from this moment is the confirmed one.
 *
 * `expectedPendingId` is the version the screen showed. A different one
 * (recalculated again since, or superseded by an extension) is a conflict, so
 * a customer never confirms an area they were not shown.
 */
export async function confirmPendingArea(
  admin: SupabaseClient,
  customer: AreaConfirmCustomer,
  opts: { expectedPendingId: string; auto: boolean; now: Date; source: string; restartNow?: boolean }
): Promise<ConfirmResult> {
  if (!canEditLeadBrief(customer)) return { kind: "not_brief_customer" };

  let versions;
  try {
    versions = await loadBriefVersions(admin, customer.id);
  } catch (err) {
    if (err instanceof BriefVersionsUnavailableError) return { kind: "retry", error: err.message };
    throw err;
  }
  const { active, pending } = versions;
  if (!pending) return { kind: "not_pending" };
  if (!active || pending.id !== opts.expectedPendingId) return { kind: "conflict" };

  let firstPicks: string[] | null = null;
  try {
    const { parsed } = parsedBodyFromRow(pending);
    const computed = await computeBriefForCustomer(admin, customer, parsed, { autoTickRecommended: false });
    if (computed.ok) firstPicks = [...computed.preview.firstPickOutcodes];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof BriefSupplyUnavailableError)) {
      console.error(`[${opts.source}] first-pick recompute failed`, { customer: customer.id, error: message });
    }
    // Keep the stored first picks: 0169 still drops any now taken.
  }

  const timing = restartTiming(customer, pending.effective_at, opts.now, { restartNow: opts.restartNow });
  const lockedUntil = lockedUntilFor(customer, timing, opts.now);
  if (!lockedUntil) return { kind: "retry", error: "no renewal date" };

  const { data, error } = await admin.rpc("confirm_pending_lead_brief", {
    p_customer_id: customer.id,
    p_expected_active_id: active.id,
    p_pending_id: pending.id,
    p_first_picks: firstPicks,
    p_locked_until: lockedUntil,
    p_auto: opts.auto,
  });
  if (error) return { kind: "retry", error: error.message };
  const result = (data as { result?: string } | null)?.result;
  switch (result) {
    case "confirmed":
      break;
    case "conflict":
      return { kind: "conflict" };
    case "not_pending":
      return { kind: "not_pending" };
    case "not_due":
      return { kind: "not_due" };
    default:
      return { kind: "retry", error: `confirm_pending_lead_brief returned ${result ?? "nothing"}` };
  }

  let resume: ResumeOutcome | "refused" | null = null;
  if (timing.resumeNow) {
    if (resumeRefusalReason(customer)) {
      // A pending cancellation: they asked to leave. The area is confirmed;
      // the leads stay stopped (the cron's own rule, resumePause.ts).
      resume = "refused";
    } else {
      const resumed = await resumePausedCustomer(admin, customer, { source: opts.source });
      resume = resumed.outcome;
      if (resumed.outcome === "stripe_failed" || resumed.outcome === "db_failed") {
        // The area is confirmed, so the resume cron restarts them on its next
        // run (returnDecision reads the version as active).
        console.error(`[${opts.source}] area confirmed but the restart did not land`, {
          customer: customer.id,
          outcome: resumed.outcome,
          error: resumed.error,
        });
      }
    }
  }

  return {
    kind: "confirmed",
    isReturn: timing.isReturn,
    resume,
    restartYmd: timing.restartYmd,
    radiusMiles: pending.service_radius_miles,
    basePostcode: pending.base_postcode,
  };
}

/**
 * The email that goes with an AUTO-accept (locked decision 4). Best effort,
 * never throws. A customer's own confirm needs no email: they are looking at
 * the screen.
 *
 * A return is emailed only when their leads actually restarted ("Your leads
 * have restarted…" would otherwise be false). A widening never stopped them,
 * so it gets the widening wording.
 */
export async function sendAutoAcceptEmail(
  customer: Pick<Customer, "id" | "email" | "contact_name">,
  result: Extract<ConfirmResult, { kind: "confirmed" }>,
  source: string
): Promise<boolean> {
  if (result.isReturn && result.resume !== "resumed") return false;
  try {
    const { error } = await sendBriefAreaConfirmedEmail({
      to: customer.email,
      contactName: customer.contact_name ?? customer.email,
      radiusMiles: result.radiusMiles,
      basePostcode: result.basePostcode,
      restarted: result.isReturn,
    });
    if (error) {
      console.error(`[${source}] area-confirmed email failed`, { customer: customer.id, error });
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[${source}] area-confirmed email threw`, { customer: customer.id, err });
    return false;
  }
}

// --- extending the pause -------------------------------------------------------------

export type ExtendResult =
  | { ok: true; returnYmd: string }
  | { ok: false; status: number; code: string; error: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Extend my pause" (batch 04 Phase 3). A long brief pause only: the return
 * date moves later, up to 3 months from the day they paused, and the area is
 * recalculated again before it (extend_brief_pause, 0169). The pause
 * confirmation email goes again with the new date.
 *
 * The date is judged in SQL against the episode under the brief's lock; this
 * only refuses a shape that is not a date.
 */
export async function extendLongPause(
  admin: SupabaseClient,
  customer: AreaConfirmCustomer,
  rawReturnDate: unknown,
  opts: { source: string }
): Promise<ExtendResult> {
  if (!canEditLeadBrief(customer) || !onLongBriefPause(customer)) {
    return { ok: false, status: 409, code: "not_extendable", error: EXTEND_MESSAGES.not_extendable };
  }
  const returnDate = typeof rawReturnDate === "string" ? rawReturnDate.trim() : "";
  if (!YMD.test(returnDate) || Number.isNaN(Date.parse(`${returnDate}T12:00:00Z`))) {
    return { ok: false, status: 400, code: "invalid", error: EXTEND_MESSAGES.invalid };
  }

  const read = await findOpenLongEpisode(admin, customer.id);
  if (!read.ok) return { ok: false, status: 503, code: "retry", error: read.error };
  if (!read.episode) {
    return { ok: false, status: 409, code: "not_extendable", error: EXTEND_MESSAGES.not_extendable };
  }

  let resumesAtIso: string;
  try {
    resumesAtIso = londonMidnightIso(returnDate);
  } catch {
    return { ok: false, status: 400, code: "invalid", error: EXTEND_MESSAGES.invalid };
  }

  const { data, error } = await admin.rpc("extend_brief_pause", {
    p_customer_id: customer.id,
    p_pause_id: read.episode.id,
    p_resumes_at: resumesAtIso,
  });
  if (error) return { ok: false, status: 503, code: "retry", error: error.message };
  const result = (data as { result?: string } | null)?.result;
  if (result !== "extended") {
    const code = (result ?? "not_extendable") as keyof typeof EXTEND_MESSAGES | "not_paused" | "resumes_at_required";
    const message =
      code in EXTEND_MESSAGES ? EXTEND_MESSAGES[code as keyof typeof EXTEND_MESSAGES] : EXTEND_MESSAGES.not_extendable;
    return { ok: false, status: code === "not_paused" ? 409 : 400, code, error: message };
  }

  try {
    const { error: emailError } = await sendBriefPauseConfirmationEmail({
      to: customer.email,
      contactName: customer.contact_name ?? customer.email,
      restartDate: returnDate,
      holdArea: false,
    });
    if (emailError) console.error(`[${opts.source}] extend email failed`, { customer: customer.id, error: emailError });
  } catch (err) {
    console.error(`[${opts.source}] extend email threw`, { customer: customer.id, err });
  }

  return { ok: true, returnYmd: returnDate };
}

// --- a tighter area, after "Switch to 10 leads" (C5) -------------------------------

export type TightenResult =
  | { kind: "scheduled"; startsOn: string | null; radiusMiles: number }
  | { kind: "unchanged" }
  | { kind: "not_switched" }
  | { kind: "conflict" }
  | { kind: "retry"; error: string };

/**
 * After the switch to 10 leads, the 10-lead area for the customer's confirmed
 * answers, saved as the one scheduled change (save_scheduled_lead_brief, 0164)
 * so it starts at the renewal the plan does, exactly as an area change made
 * in the editor. Only once the plan has actually changed (briefPlanFor reads
 * the pending tier, §24); a 20-lead customer is refused rather than tightened.
 */
export async function scheduleTighterArea(
  admin: SupabaseClient,
  customer: AreaConfirmCustomer,
  opts: { now: Date }
): Promise<TightenResult> {
  if (!canEditLeadBrief(customer) || briefPlanFor(customer) !== 10) return { kind: "not_switched" };

  let versions;
  try {
    versions = await loadBriefVersions(admin, customer.id);
  } catch (err) {
    if (err instanceof BriefVersionsUnavailableError) return { kind: "retry", error: err.message };
    throw err;
  }
  const active = versions.active;
  if (!active) return { kind: "retry", error: "no active brief" };
  if (active.allocation === 10) return { kind: "unchanged" };

  const { parsed, chosenKeys } = parsedBodyFromRow(active);
  let preview;
  try {
    const computed = await computeBriefForCustomer(admin, customer, parsed, { autoTickRecommended: false });
    if (!computed.ok) return { kind: "retry", error: computed.issues.map((i) => i.code).join(",") };
    preview = computed.preview;
  } catch (err) {
    return { kind: "retry", error: err instanceof Error ? err.message : String(err) };
  }

  const row = briefRowFromPreview(preview, {
    customerId: customer.id,
    // 0164 allocates the version, decides the status and sets the lock.
    version: 1,
    lockedUntil: null,
    now: opts.now,
    status: "scheduled",
    chosenKeys,
  });
  const { data, error } = await admin.rpc("save_scheduled_lead_brief", {
    p_customer_id: customer.id,
    p_expected_active_id: active.id,
    p_row: row,
  });
  if (error) return { kind: "retry", error: error.message };
  const result = (data as { result?: string } | null)?.result;
  if (result === "conflict") return { kind: "conflict" };
  if (result !== "saved") return { kind: "retry", error: `save_scheduled_lead_brief returned ${result ?? "nothing"}` };

  return {
    kind: "scheduled",
    startsOn: nextGrantDate(
      {
        billing_cycle_anchor: customer.billing_cycle_anchor,
        gr_billing_cycle_anchor: customer.gr_billing_cycle_anchor,
        created_at: customer.created_at,
      },
      opts.now
    ),
    radiusMiles: preview.serviceRadiusMiles,
  };
}
