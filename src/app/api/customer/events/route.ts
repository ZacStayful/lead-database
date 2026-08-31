import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { completeAttemptForEvent } from "@/lib/contact/completeAttempt";
import {
  CLIENT_LEAD_EVENT_TYPES,
  type ClientLeadEventType,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Collapse repeat signals of the same kind on the same assignment inside this
 * window into a single stored event.
 *
 * Sized for intent, not for storage. A detail_opened fires on every mount, so
 * React's development double-invoke, a back-button return, or an impatient
 * double-click would each otherwise write a distinct event and inflate the
 * operator's apparent engagement. Sixty seconds is comfortably longer than any
 * of those and comfortably shorter than a genuine second visit to the same lead.
 */
const DEDUPE_WINDOW_SECONDS = 60;

/**
 * Ceiling on events accepted from one customer in a rolling hour, across every
 * assignment and type. The dedupe above handles honest repetition; this exists
 * only so a scripted client cannot flood the table. Set well above real use —
 * working thirty leads hard in an hour lands nowhere near it.
 */
const HOURLY_EVENT_CAP = 600;

function isClientEventType(v: unknown): v is ClientLeadEventType {
  return (
    typeof v === "string" &&
    (CLIENT_LEAD_EVENT_TYPES as readonly string[]).includes(v)
  );
}

/**
 * Record one passive engagement event against the caller's own lead assignment.
 *
 * These events are the raw material for engagement scoring, which in turn
 * decides who is offered a reclaimed lead — so this route is the trust boundary
 * for that scoring. It is deliberately the ONLY way to write lead_events:
 * the table exposes no browser insert policy, so a customer cannot manufacture
 * engagement by writing rows directly and outbidding better operators.
 *
 * Three guards, in order:
 *   1. The event type must be one of the three the browser is allowed to send.
 *      note_added / file_added / stage_changed are server-side signals and are
 *      rejected here even though the column's CHECK permits them.
 *   2. The assignment must belong to the calling customer. A miss returns 404
 *      rather than 403, so the route cannot be used to probe which assignment
 *      ids exist.
 *   3. Volume: dedupe identical recent signals, then cap the rolling hour.
 *
 * The client fires this and forgets. Every failure path still returns a 2xx-
 * shaped body where it can, and the caller ignores the response entirely —
 * losing a telemetry event must never interrupt someone working a lead.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { assignment_id?: unknown; event_type?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const assignmentId = body?.assignment_id;
  if (typeof assignmentId !== "string" || assignmentId.length === 0) {
    return NextResponse.json(
      { error: "assignment_id required" },
      { status: 400 }
    );
  }

  if (!isClientEventType(body?.event_type)) {
    return NextResponse.json(
      {
        error: `event_type must be one of: ${CLIENT_LEAD_EVENT_TYPES.join(", ")}`,
      },
      { status: 400 }
    );
  }
  const eventType: ClientLeadEventType = body.event_type;

  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const customerId = (customer as { id: string }).id;

  // Ownership. Scoping the lookup by customer_id means a foreign assignment id
  // is indistinguishable from a nonexistent one.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id")
    .eq("id", assignmentId)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (!assignment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Dedupe: an identical signal on this assignment in the recent past means
  // this is a repeat of the same intent, not a new one.
  const dedupeSince = new Date(
    Date.now() - DEDUPE_WINDOW_SECONDS * 1000
  ).toISOString();

  const { count: recentSame } = await admin
    .from("lead_events")
    .select("id", { count: "exact", head: true })
    .eq("assignment_id", assignmentId)
    .eq("event_type", eventType)
    .gte("created_at", dedupeSince);

  if ((recentSame ?? 0) > 0) {
    return NextResponse.json({ ok: true, recorded: false, reason: "duplicate" });
  }

  // Rolling-hour cap across this customer's own assignments.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: ownAssignments } = await admin
    .from("lead_assignments")
    .select("id")
    .eq("customer_id", customerId);

  const ownIds = (ownAssignments ?? []).map((a) => (a as { id: string }).id);
  if (ownIds.length > 0) {
    const { count: recentTotal } = await admin
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .in("assignment_id", ownIds)
      .gte("created_at", hourAgo);

    if ((recentTotal ?? 0) >= HOURLY_EVENT_CAP) {
      return NextResponse.json({
        ok: true,
        recorded: false,
        reason: "rate_limited",
      });
    }
  }

  const { data: inserted, error } = await admin
    .from("lead_events")
    .insert({
      assignment_id: assignmentId,
      event_type: eventType,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // Swallowed on purpose: the caller is fire-and-forget and a lost event is
    // strictly less costly than surfacing an error into a working session.
    console.error("[customer/events] insert failed", {
      assignmentId,
      eventType,
      error: error.message,
    });
    return NextResponse.json({ ok: true, recorded: false, reason: "error" });
  }

  // The contact plan (§42). A click on WhatsApp, the phone number or the email
  // IS the record that the attempt happened — there is no "mark done" button,
  // and `done_event_id` points back at the row just inserted so any adherence
  // figure can be traced to the click behind it.
  //
  // ⚠️ AFTER the insert and the dedupe, deliberately. A repeat click inside the
  // dedupe window returns above without reaching here, so hammering the button
  // cannot walk an operator through their whole plan.
  //
  // ⚠️ AND IT NEVER THROWS OR BLOCKS. completeAttemptForEvent swallows its own
  // errors; this route is fire-and-forget telemetry called as the browser
  // navigates away to WhatsApp or the dialler, so a failed completion must cost
  // a to-do entry and never the phone call. `detail_opened` closes nothing and
  // returns immediately — reading a lead is not contacting it (§6).
  const completion = await completeAttemptForEvent(admin, {
    assignmentId,
    eventType,
    eventId: (inserted as { id: string } | null)?.id ?? null,
  });

  return NextResponse.json({
    ok: true,
    recorded: true,
    attempt_closed: completion.closed,
  });
}
