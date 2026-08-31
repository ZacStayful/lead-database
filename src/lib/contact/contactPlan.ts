/**
 * Provisioning and reading a lead's contact plan (§42).
 *
 * ⚠️ NOBODY BUILDS ANYTHING. §40.13 shipped a sequence builder and production
 * carries zero sequences — a customer who has to design a follow-up ladder
 * before they can follow anybody up does not follow anybody up. The standard
 * plan is created for them the first time a lead lands, and stays editable
 * afterwards through the existing SequencePanel.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTACT_ATTEMPTS,
  TOTAL_ATTEMPTS,
  attemptsForLead,
  type ContactAttempt,
  type ContactChannel,
} from "@/lib/contact/contactStrategy";

type Admin = SupabaseClient;

export const STANDARD_PLAN_NAME = "Standard follow-up";

/** Numeric/boolean settings this feature reads, in one query. */
export async function contactPlanSettings(admin: Admin): Promise<{
  enabled: boolean;
  landlordMaxPerDay: number;
  landlordMaxPerWeek: number;
  noticePct: number;
  noticeMinOverdue: number;
}> {
  const { data } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", [
      "contact_plans_enabled",
      "contact_landlord_max_per_day",
      "contact_landlord_max_per_week",
      "followup_adherence_notice_pct",
      "followup_adherence_notice_min_overdue",
    ]);

  const map = new Map(
    ((data ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value])
  );
  const num = (k: string, fallback: number) => {
    const n = Number(map.get(k));
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    // ⚠️ Fails CLOSED, the messagingEnabled precedent: an unreadable switch must
    // not start putting approaches in front of members of the public.
    enabled: map.get("contact_plans_enabled") === "true",
    landlordMaxPerDay: num("contact_landlord_max_per_day", 1),
    landlordMaxPerWeek: num("contact_landlord_max_per_week", 3),
    noticePct: num("followup_adherence_notice_pct", 50),
    noticeMinOverdue: num("followup_adherence_notice_min_overdue", 5),
  };
}

/**
 * The customer's standing contact plan for a product, created if absent.
 *
 * Idempotent: the lookup is by (customer, product, trigger, delivery), so a
 * second call returns the existing plan rather than a duplicate. 0121's partial
 * unique index already refuses two standing rules per product, which is what
 * stops a lead being enrolled twice and messaged twice on day one.
 *
 * Never throws. It is called from `completeAssignment`, which is downstream of
 * the single money path — a failed plan costs a to-do list, and must never cost
 * the assignment.
 */
export async function ensureContactPlan(
  admin: Admin,
  params: { customerId: string; leadType: string }
): Promise<string | null> {
  const leadType =
    params.leadType === "guaranteed_rent" ? "guaranteed_rent" : "management";

  try {
    const { data: existing } = await admin
      .from("message_sequences")
      .select("id")
      .eq("customer_id", params.customerId)
      .eq("lead_type", leadType)
      .eq("trigger", "on_assignment")
      .eq("delivery", "manual")
      .is("archived_at", null)
      .maybeSingle();

    const found = (existing as { id: string } | null)?.id;
    if (found) return found;

    const { data: created, error } = await admin
      .from("message_sequences")
      .insert({
        customer_id: params.customerId,
        name: STANDARD_PLAN_NAME,
        lead_type: leadType,
        // 'mixed' because the ladder alternates call / WhatsApp / email. The
        // per-step channel is what actually decides each rung.
        channel: "mixed",
        trigger: "on_assignment",
        delivery: "manual",
        is_active: true,
      })
      .select("id")
      .maybeSingle();

    if (error || !created) {
      // A unique violation here means another request created it a moment ago,
      // which is success from this caller's point of view.
      const { data: raced } = await admin
        .from("message_sequences")
        .select("id")
        .eq("customer_id", params.customerId)
        .eq("lead_type", leadType)
        .eq("trigger", "on_assignment")
        .eq("delivery", "manual")
        .is("archived_at", null)
        .maybeSingle();
      const racedId = (raced as { id: string } | null)?.id ?? null;
      if (!racedId) {
        console.error("[contact] plan creation failed", error?.message);
      }
      return racedId;
    }

    const sequenceId = (created as { id: string }).id;

    await admin.from("message_sequence_steps").insert(
      CONTACT_ATTEMPTS.map((a) => ({
        sequence_id: sequenceId,
        step_number: a.number,
        delay_days: a.delayDays,
        channel: a.channel,
        // The brief IS the deliverable here, shown to the operator rather than
        // fed to a drafter — which is what 'objective' means (0127).
        mode: "objective",
        brief: a.objective,
      }))
    );

    return sequenceId;
  } catch (e) {
    console.error(
      "[contact] ensureContactPlan failed",
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

/** One rung as the timeline renders it. */
export interface TimelineAttempt {
  number: number;
  channel: ContactChannel;
  objective: string;
  /** null for a rung that has never been materialised. */
  dueAt: string | null;
  doneAt: string | null;
  state: "done" | "due" | "overdue" | "upcoming" | "skipped";
  callOutcome: string | null;
  /** True when a real recorded click closed it, rather than a manual tick. */
  byClick: boolean;
}

export interface ContactTimelineView {
  attempts: TimelineAttempt[];
  completed: number;
  total: number;
  /** The rung the operator should do now, if any is due. */
  current: TimelineAttempt | null;
  /** True once the plan has run its course. */
  finished: boolean;
  stopped: boolean;
}

interface AttemptRow {
  step_number: number;
  channel: string;
  body: string | null;
  send_after: string;
  state: string;
  done_at: string | null;
  done_source: string | null;
  call_outcome: string | null;
}

/**
 * Build the timeline for one assignment.
 *
 * PURE, so it can be unit tested without a client — the same reasoning
 * `cadence.ts` and `sendWindow.ts` give at length. The caller does the reads.
 *
 * Rungs the scheduler has not materialised yet still appear, greyed, with their
 * objective: the whole point is that the operator can see what is LEFT, not
 * only what has been queued.
 */
export function buildContactTimeline(params: {
  rows: AttemptRow[];
  landlordContactMethod?: string | null;
  runStatus?: string | null;
  now?: Date;
}): ContactTimelineView {
  const now = params.now ?? new Date();
  const defs = attemptsForLead(params.landlordContactMethod);
  const byStep = new Map(params.rows.map((r) => [r.step_number, r]));
  const stopped = params.runStatus === "stopped";

  const attempts: TimelineAttempt[] = defs.map((def: ContactAttempt) => {
    const row = byStep.get(def.number);
    if (!row) {
      return {
        number: def.number,
        channel: def.channel,
        objective: def.objective,
        dueAt: null,
        doneAt: null,
        state: "upcoming",
        callOutcome: null,
        byClick: false,
      };
    }

    const due = new Date(row.send_after);
    let state: TimelineAttempt["state"];
    if (row.state === "sent") state = "done";
    else if (row.state === "cancelled" || row.state === "skipped") state = "skipped";
    else if (due.getTime() <= now.getTime()) state = "overdue";
    else state = "upcoming";

    return {
      number: def.number,
      // The stored row is the authority on channel — an operator may have
      // edited the plan since, and the timeline must show what was actually
      // scheduled rather than what the default says.
      channel: (row.channel as ContactChannel) ?? def.channel,
      objective: row.body?.trim() ? row.body : def.objective,
      dueAt: row.send_after,
      doneAt: row.done_at,
      state,
      callOutcome: row.call_outcome,
      byClick: row.done_source === "click",
    };
  });

  // "Due" is the earliest outstanding rung. Marking it separately from the
  // merely-overdue ones is what lets the card show one action rather than a
  // list of arrears.
  const current =
    attempts.find((a) => a.state === "overdue") ??
    null;
  if (current) current.state = "due";

  const completed = attempts.filter((a) => a.state === "done").length;

  return {
    attempts,
    completed,
    total: TOTAL_ATTEMPTS,
    current: stopped ? null : current,
    finished: completed >= TOTAL_ATTEMPTS,
    stopped,
  };
}
