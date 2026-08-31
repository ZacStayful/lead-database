/**
 * Completing a contact attempt (§42).
 *
 * ONE DEFINITION, TWO CALLERS: `/api/customer/events`, when a click arrives,
 * and the attempt route, when the operator says they did it another way. The
 * pair must agree about which attempt a given action closes, and a second copy
 * of that rule would drift the first time the sequence changed shape.
 *
 * ⚠️ THE TRUST BOUNDARY LIVES HERE. `lead_events` is the engagement basis for
 * escalation, pooling, the reclaim decision and the scoreboard (§3), and
 * CLIENT_LEAD_EVENT_TYPES is deliberately narrow so a customer cannot
 * manufacture engagement. So:
 *
 *   - a CLICK writes its event (the route does that) and completes the attempt,
 *     recording `done_event_id` so the completion can always be traced back to
 *     the click behind it;
 *   - a MANUAL completion advances the plan and writes NO event.
 *
 * Adherence counts both, because holding an operator to their own word is the
 * point. Engagement scoring counts only clicks, so there is no new way to
 * shield a lead from being escalated away.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContactChannel } from "@/lib/contact/contactStrategy";
import type { LeadEventType } from "@/lib/types";
import { advanceRun, stopRun } from "@/lib/messaging/sequences";

type Admin = SupabaseClient;

/**
 * Which channel an event closes.
 *
 * ⚠️ `detail_opened` IS ABSENT AND MUST STAY ABSENT. Reading a lead is not
 * contacting it (§6). 666 opens against 15 contact actions is the finding this
 * feature exists to name, and letting an open close an attempt would let a
 * customer clear their whole plan by browsing.
 *
 * `nudge_sent` is absent for the §3 reason — it is something we did to the
 * operator — and `message_received` because a landlord's reply is the
 * landlord's act, not an approach by anybody.
 */
export function channelClosedByEvent(
  eventType: LeadEventType | string
): ContactChannel | null {
  switch (eventType) {
    case "tel_click":
      return "call";
    case "whatsapp_click":
      return "whatsapp";
    case "mailto_click":
      return "email";
    // A message actually sent through a connected workspace. It carries a
    // provider id, so it is strictly stronger evidence than a hand-off click —
    // but the channel it closes depends on how it went out, which only the
    // caller knows, so it is resolved there rather than guessed at here.
    default:
      return null;
  }
}

export type AttemptCompletionSource = "click" | "manual" | "auto";
export type CallOutcome = "answered" | "no_answer" | "voicemail";

export interface CompleteAttemptResult {
  closed: boolean;
  /** Why nothing was closed, for logging only — never surfaced to a caller. */
  reason?:
    | "no_open_run"
    | "no_matching_attempt"
    | "not_a_contact_event"
    | "write_failed";
  attemptId?: string;
  stepNumber?: number;
  /** True when an answered call ended the plan early. */
  runStopped?: boolean;
}

interface OpenAttempt {
  id: string;
  run_id: string;
  step_number: number;
  channel: string;
  message_sequence_runs: {
    id: string;
    sequence_id: string;
    status: string;
    assignment_id: string;
    message_sequences: { delivery: string } | null;
  } | null;
}

/**
 * ⚠️ `!inner` ON BOTH EMBEDS, AND IT IS LOAD-BEARING.
 *
 * §27.8 records what its absence costs: in PostgREST a filter on a NON-inner
 * embedded resource filters the EMBEDDED RESOURCE rather than the parent rows,
 * so every attempt comes back with its run nulled instead of excluded. Here
 * that would let a click close an attempt belonging to a STOPPED run — a
 * landlord who has already replied.
 */
const OPEN_ATTEMPT_COLUMNS =
  "id, run_id, step_number, channel, " +
  "message_sequence_runs!inner(id, sequence_id, status, assignment_id, " +
  "message_sequences!inner(delivery))";

/**
 * Close the earliest outstanding attempt on this assignment for `channel`.
 *
 * Earliest rather than nearest-due: a plan whose attempt 2 is overdue and whose
 * attempt 4 falls today should have the overdue one cleared by the operator
 * finally doing it, not the future one brought forward.
 *
 * Never throws. A failed completion costs the operator an entry on their to-do
 * list; throwing would cost them the phone call, because the caller is the
 * fire-and-forget telemetry route.
 */
export async function completeAttempt(
  admin: Admin,
  params: {
    assignmentId: string;
    channel: ContactChannel;
    source: AttemptCompletionSource;
    /** Only ever set alongside source 'click' — the DB CHECK enforces it. */
    eventId?: string | null;
    callOutcome?: CallOutcome | null;
    at?: Date;
  }
): Promise<CompleteAttemptResult> {
  const at = params.at ?? new Date();

  const { data, error } = await admin
    .from("message_sequence_drafts")
    .select(OPEN_ATTEMPT_COLUMNS)
    .eq("state", "pending")
    .eq("channel", params.channel)
    .eq("message_sequence_runs.status", "active")
    .eq("message_sequence_runs.assignment_id", params.assignmentId)
    .eq("message_sequence_runs.message_sequences.delivery", "manual")
    .order("step_number", { ascending: true })
    .limit(1);

  if (error) {
    console.error("[contact] open attempt lookup failed", {
      assignmentId: params.assignmentId,
      error: error.message,
    });
    return { closed: false, reason: "write_failed" };
  }

  const attempt = (data ?? [])[0] as unknown as OpenAttempt | undefined;
  if (!attempt || !attempt.message_sequence_runs) {
    return { closed: false, reason: "no_matching_attempt" };
  }

  const { error: updateError } = await admin
    .from("message_sequence_drafts")
    .update({
      state: "sent",
      done_at: at.toISOString(),
      done_source: params.source,
      done_event_id: params.source === "click" ? params.eventId ?? null : null,
      call_outcome: params.callOutcome ?? null,
      updated_at: at.toISOString(),
    })
    .eq("id", attempt.id)
    // Claim by write: two clicks racing must close one attempt, not two.
    .eq("state", "pending");

  if (updateError) {
    console.error("[contact] attempt completion failed", {
      attemptId: attempt.id,
      error: updateError.message,
    });
    return { closed: false, reason: "write_failed" };
  }

  const run = attempt.message_sequence_runs;

  // ⚠️ AN ANSWERED CALL ENDS THE PLAN, IT DOES NOT ADVANCE IT.
  //
  // Attempt 2 is defined as "same day, ONLY if the call went unanswered". If
  // the landlord picked up, the operator is in conversation — and putting the
  // next approach in front of them tomorrow is the one way this feature could
  // actively embarrass somebody. The lead keeps its own pipeline stage from
  // here; the ladder's job is done.
  if (params.callOutcome === "answered") {
    await stopRun(admin, run.id, "replied");
    return {
      closed: true,
      attemptId: attempt.id,
      stepNumber: attempt.step_number,
      runStopped: true,
    };
  }

  await advanceRun(admin, {
    runId: run.id,
    sequenceId: run.sequence_id,
    completedStep: attempt.step_number,
    sentAt: at,
  });

  return {
    closed: true,
    attemptId: attempt.id,
    stepNumber: attempt.step_number,
    runStopped: false,
  };
}

/**
 * The `/api/customer/events` entry point: a click just landed, close whatever
 * it satisfies.
 *
 * Returns quietly for an event that closes nothing — `detail_opened` is the
 * common case and is not a failure.
 */
export async function completeAttemptForEvent(
  admin: Admin,
  params: { assignmentId: string; eventType: LeadEventType; eventId?: string | null }
): Promise<CompleteAttemptResult> {
  const channel = channelClosedByEvent(params.eventType);
  if (!channel) return { closed: false, reason: "not_a_contact_event" };
  return completeAttempt(admin, {
    assignmentId: params.assignmentId,
    channel,
    source: "click",
    eventId: params.eventId ?? null,
  });
}
