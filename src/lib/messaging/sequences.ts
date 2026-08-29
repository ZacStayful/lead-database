/**
 * The follow-up sequence engine (§40.13): enrol, draft, send, advance, stop.
 *
 * ONE DEFINITION OF EACH, for the reason this codebase keeps writing down —
 * `customer_can_see_pool_lead` for the pool (§19.4), `announcementTargetsCustomer`
 * for announcements (§22), `sendOneMessage` for the send path. There will be
 * four callers of `enrolAssignments` alone (a single lead, a bulk selection, the
 * standing rule in `completeAssignment`, and admin), and four readings of "is
 * this lead already in a sequence" would eventually disagree silently.
 *
 * ⚠️ WHAT STOPS A RUN IS THE MOST IMPORTANT THING IN THIS FILE. A ladder of
 * automated messages that keeps going after the landlord has answered is the
 * worst thing this feature could do — worse than never shipping it. Four things
 * stop one, and three of them cost nothing to maintain:
 *
 *   1. THE LANDLORD REPLIES → `stopRunsForThread`, called from the inbound
 *      webhook. This is the one that had to be written. §40.7 is right that an
 *      inbound message must never count as OPERATOR engagement — but "does not
 *      shield the lead from escalation" and "does not stop us messaging them
 *      again" are different questions with opposite answers.
 *   2. THE ASSIGNMENT GOES AWAY → the 0121 cascade. Discard (§30.7), the filter
 *      release (§39) and a swap all delete the row, and the run goes with it.
 *   3. THE LEAD BECOMES UNSENDABLE → `assignmentSendable` is re-read at both the
 *      drafting and the sending step, so rejecting or closing a lead stops the
 *      ladder within the day.
 *   4. THE OPERATOR SAYS SO → `stopRun`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dueAtForStep, nextStepNumber, type CadenceStep } from "./cadence";

type Admin = SupabaseClient;

export type StopReason =
  | "replied"
  | "operator_stopped"
  | "not_sendable"
  | "no_connection"
  | "bad_phone"
  | "drafting_failed"
  | "sequence_archived";

/**
 * ⚠️ THE IDEMPOTENCY KEY IS DERIVED, NOT GENERATED.
 *
 * `lead_messages` is unique on (customer_id, idempotency_key), and that index is
 * what makes a re-run of the sending phase collide on 23505 rather than message
 * the landlord a second time. A random uuid per attempt would defeat it
 * completely — and the sending phase runs every five minutes, so "the same step
 * is considered twice" is the ordinary case, not a rare one.
 *
 * Keyed on the RUN and the STEP rather than on the draft row: a draft that is
 * cancelled and somehow re-created must not get a second chance to send the
 * same step.
 */
export function sequenceIdempotencyKey(runId: string, stepNumber: number): string {
  return `seq:${runId}:${stepNumber}`;
}

export interface SequenceStep extends CadenceStep {
  brief: string | null;
  /** 'ai' = the model writes it per lead; 'manual' = body_template is rendered. */
  mode: "ai" | "manual";
  body_template: string | null;
}

/** A step ladder, ordered, as the engine needs it. */
export async function loadSteps(
  admin: Admin,
  sequenceId: string
): Promise<SequenceStep[]> {
  const { data } = await admin
    .from("message_sequence_steps")
    .select("step_number, delay_days, brief, mode, body_template")
    .eq("sequence_id", sequenceId)
    .order("step_number", { ascending: true });
  return (data ?? []) as SequenceStep[];
}

export interface EnrolResult {
  enrolled: number;
  /** Already in a sequence — this one or another. Never enrolled twice. */
  alreadyEnrolled: number;
  /** Rejected, closed, or otherwise unmessageable. */
  skipped: number;
}

/**
 * Put assignments into a sequence.
 *
 * ⚠️ AT MOST ONE RUN PER ASSIGNMENT, ENFORCED BY THE DATABASE, not by this
 * query. The `message_sequence_runs_assignment_idx` unique index is the real
 * guard; the pre-read below only exists so the operator gets a truthful tally
 * instead of an error. Two ladders of messages to one landlord from one number
 * is the failure this feature must not ship with, and a pre-read alone leaves a
 * window — the standing rule and a bulk enrolment can genuinely race.
 *
 * Insert one at a time rather than in a batch: a batch insert fails ENTIRELY on
 * the first collision, so one lead already in a sequence would refuse the other
 * hundred and ninety-nine.
 */
export async function enrolAssignments(
  admin: Admin,
  params: {
    customerId: string;
    sequenceId: string;
    assignmentIds: string[];
    enrolledBy?: string | null;
    now?: Date;
  }
): Promise<EnrolResult> {
  const now = params.now ?? new Date();
  const result: EnrolResult = { enrolled: 0, alreadyEnrolled: 0, skipped: 0 };
  if (params.assignmentIds.length === 0) return result;

  const steps = await loadSteps(admin, params.sequenceId);
  const first = nextStepNumber(steps, 0);
  if (first === null) return result;

  // Ownership and sendability in one read. Scoped by customer_id, so an
  // assignment id belonging to somebody else simply is not returned — the
  // events-route rule, and here it also means a hand-rolled POST cannot enrol
  // another operator's leads.
  const { data: rows } = await admin
    .from("lead_assignments")
    .select("id, lead_id, status, closed_at, closed_reason")
    .eq("customer_id", params.customerId)
    .in("id", params.assignmentIds);

  const eligible = ((rows ?? []) as {
    id: string;
    lead_id: string;
    status: string | null;
    closed_at: string | null;
    closed_reason: string | null;
  }[]).filter((r) => {
    const sendable =
      r.status !== "rejected" && !r.closed_at && !r.closed_reason;
    if (!sendable) result.skipped += 1;
    return sendable;
  });

  result.skipped += params.assignmentIds.length - (rows ?? []).length;

  const dueAt = dueAtForStep(now, steps, first) ?? now;

  for (const row of eligible) {
    const { error } = await admin.from("message_sequence_runs").insert({
      customer_id: params.customerId,
      sequence_id: params.sequenceId,
      assignment_id: row.id,
      lead_id: row.lead_id,
      status: "active",
      current_step: 0,
      next_due_at: dueAt.toISOString(),
      enrolled_by: params.enrolledBy ?? null,
    });

    if (!error) {
      result.enrolled += 1;
      continue;
    }
    if ((error as { code?: string }).code === "23505") {
      result.alreadyEnrolled += 1;
      continue;
    }
    console.error("[sequences] enrol failed", error);
    result.skipped += 1;
  }

  return result;
}

/** Close a run and say why. Never throws; a failed stop is logged. */
export async function stopRun(
  admin: Admin,
  runId: string,
  reason: StopReason
): Promise<void> {
  const { error } = await admin
    .from("message_sequence_runs")
    .update({
      status: "stopped",
      stopped_reason: reason,
      stopped_at: new Date().toISOString(),
      next_due_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (error) console.error("[sequences] stopRun failed", error);

  // Anything already drafted for a stopped run must not go out. The state
  // column is what the sending phase reads, so leaving these `pending` would
  // send the next step of a ladder we have just stopped.
  const { error: draftError } = await admin
    .from("message_sequence_drafts")
    .update({
      state: "skipped",
      skip_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("run_id", runId)
    .eq("state", "pending");
  if (draftError) console.error("[sequences] stopRun draft sweep failed", draftError);
}

/**
 * ⚠️ THE LANDLORD ANSWERED. STOP TALKING.
 *
 * Called from the inbound webhook the moment a reply is matched to a thread.
 * Everything else here is bookkeeping; this is the rule that decides whether
 * this feature is defensible.
 *
 * Scoped by assignment rather than by thread id, because a thread carries the
 * assignment it was last seen on and a landlord may have replied on a thread
 * created before the run existed. Never throws: an inbound message must be
 * stored even if this fails, and the drafting and sending steps both re-check
 * for a reply anyway.
 */
export async function stopRunsForAssignment(
  admin: Admin,
  assignmentId: string | null,
  reason: StopReason = "replied"
): Promise<void> {
  if (!assignmentId) return;
  try {
    const { data } = await admin
      .from("message_sequence_runs")
      .select("id")
      .eq("assignment_id", assignmentId)
      .eq("status", "active");
    for (const row of (data ?? []) as { id: string }[]) {
      await stopRun(admin, row.id, reason);
    }
  } catch (e) {
    console.error(
      "[sequences] stopRunsForAssignment failed",
      e instanceof Error ? e.message : e
    );
  }
}

/**
 * Move a run on after a step has actually SENT.
 *
 * ⚠️ MEASURED FROM THE SEND, NOT FROM THE SCHEDULE. A step held back overnight
 * by quiet hours, or by the daily cap, has to push the rest of the ladder along
 * with it. Otherwise a backlog enrolled at the cap fires steps 1 and 2 within
 * hours of each other the moment the cap clears — the burst profile that gets a
 * WhatsApp number restricted, produced by the very limit meant to prevent it.
 */
export async function advanceRun(
  admin: Admin,
  params: {
    runId: string;
    sequenceId: string;
    completedStep: number;
    sentAt: Date;
  }
): Promise<void> {
  const steps = await loadSteps(admin, params.sequenceId);
  const next = nextStepNumber(steps, params.completedStep);

  if (next === null) {
    await admin
      .from("message_sequence_runs")
      .update({
        status: "completed",
        current_step: params.completedStep,
        next_due_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.runId);
    return;
  }

  const due = dueAtForStep(params.sentAt, steps, next) ?? params.sentAt;
  await admin
    .from("message_sequence_runs")
    .update({
      current_step: params.completedStep,
      next_due_at: due.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.runId);
}

/**
 * A step the operator cancelled is SKIPPED, not a stop.
 *
 * "Cancel this one" and "stop chasing this landlord" are different intentions
 * and the review queue offers both. Cancelling one draft advances the ladder as
 * though that step had sent, so the next one arrives on its normal cadence —
 * which is what an operator means by "not this message".
 *
 * Measured from now rather than from the step's own due time, so cancelling a
 * step does not stack the next one up against it.
 */
export async function skipStep(
  admin: Admin,
  params: {
    runId: string;
    sequenceId: string;
    stepNumber: number;
    reason: string;
    now?: Date;
  }
): Promise<void> {
  const now = params.now ?? new Date();
  await admin
    .from("message_sequence_drafts")
    .update({
      state: "cancelled",
      skip_reason: params.reason,
      cancelled_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("run_id", params.runId)
    .eq("step_number", params.stepNumber)
    .eq("state", "pending");

  await advanceRun(admin, {
    runId: params.runId,
    sequenceId: params.sequenceId,
    completedStep: params.stepNumber,
    sentAt: now,
  });
}

/**
 * ⚠️ THE `!inner` IS LOAD-BEARING, AND §27.8 RECORDS WHAT ITS ABSENCE COSTS.
 *
 * In PostgREST a filter on a NON-inner embedded resource filters the EMBEDDED
 * RESOURCE rather than the parent rows: every draft still comes back, with
 * `message_sequence_runs` nulled on the ones whose run is not active. That is a
 * 200 that paginates normally and is wrong — and here it would mean the sending
 * phase walking drafts belonging to STOPPED runs, i.e. messaging landlords who
 * have already replied. The exact failure this feature must not have.
 *
 * The select strings live here, not inline in the routes, so a test can assert
 * them. §27.8's own regression was confirmed to fail against the old select
 * before it was kept, and the same applies to these.
 */
export const DUE_DRAFT_COLUMNS =
  "id, run_id, customer_id, step_number, body, draft_id, " +
  "message_sequence_runs!inner(id, status, sequence_id, assignment_id, lead_id)";

export const REVIEW_QUEUE_COLUMNS =
  "id, run_id, step_number, body, send_after, state, edited_at, created_at, " +
  "message_sequence_runs!inner(id, status, assignment_id, sequence_id, " +
  "message_sequences(name), " +
  "lead:leads(id, lead_name, address, owner_customer_id, lead_profile))";

/**
 * The standing rule: put a newly assigned lead into the customer's automatic
 * sequence, if they have one for that product (§40.13).
 *
 * ⚠️ IT ENROLS, AND NEVER SENDS. `completeAssignment` is downstream of
 * `assign_lead_to_customer`, the single money path, and it must not grow a
 * blocking third-party call. What this writes is one row; the drafting cron
 * picks it up that evening and the sending phase posts it in the morning.
 *
 * ⚠️ AND IT NEVER THROWS. Nothing in `completeAssignment` does — a failed email,
 * a failed SMS and a failed top-up offer are all logged and swallowed, because
 * the lead has already been paid for and delivered. A messaging feature must
 * not be the first thing there able to break an assignment.
 *
 * ⚠️ NOT GATED ON `sendThresholdWarnings`. That flag is about CREDIT warnings,
 * and the bulk assigner and the swap pass `false` for reasons that have nothing
 * to do with messaging — a lead placed by an admin is still a lead the operator
 * wants to follow up.
 *
 * It does not check `messaging_sequences_enabled`. Enrolling while the platform
 * switch is off is inert (nothing drafts, nothing sends) and it is the right
 * side to fail on: a lead that arrived during the rollout is then already in
 * the ladder when it is turned on, rather than permanently missed.
 */
export async function enrolOnAssignment(
  admin: Admin,
  params: { customerId: string; assignmentId: string; leadType: string }
): Promise<void> {
  try {
    const { data } = await admin
      .from("message_sequences")
      .select("id")
      .eq("customer_id", params.customerId)
      .eq("trigger", "on_assignment")
      .eq("lead_type", params.leadType === "guaranteed_rent" ? "guaranteed_rent" : "management")
      .eq("channel", "whatsapp")
      .eq("is_active", true)
      .is("archived_at", null)
      .maybeSingle();

    const sequenceId = (data as { id: string } | null)?.id;
    if (!sequenceId) return;

    await enrolAssignments(admin, {
      customerId: params.customerId,
      sequenceId,
      assignmentIds: [params.assignmentId],
    });
  } catch (e) {
    console.error(
      "[sequences] enrolOnAssignment failed",
      e instanceof Error ? e.message : e
    );
  }
}

/** Numeric system_settings, read in one query. Missing keys take the fallback. */
export async function sequenceSettings(
  admin: Admin
): Promise<{ enabled: boolean; reviewHours: number; dailyDraftCap: number }> {
  const { data } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", [
      "messaging_sequences_enabled",
      "messaging_sequence_review_hours",
      "messaging_sequence_daily_draft_cap",
    ]);
  const map = new Map(
    (data ?? []).map((r) => [(r as { key: string }).key, (r as { value: string }).value])
  );
  const num = (key: string, fallback: number) => {
    const v = Number(map.get(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    // ⚠️ FAILS CLOSED, like messagingEnabled and for a sharper reason: what is
    // gated here sends unattended messages from a real person's own number.
    enabled: map.get("messaging_sequences_enabled") === "true",
    // 18, not 12: the drafting cron runs at 17:00 UTC and the earliest a step
    // can send is 09:00 the next morning. See 0121 §7 for the arithmetic.
    reviewHours: num("messaging_sequence_review_hours", 18),
    dailyDraftCap: num("messaging_sequence_daily_draft_cap", 250),
  };
}
