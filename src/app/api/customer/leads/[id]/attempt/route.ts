/**
 * Completing a contact attempt by hand (§42).
 *
 * The normal path needs no route at all: clicking WhatsApp, the phone number or
 * the email posts to /api/customer/events, and that click IS the completion.
 * This exists for the two cases a click cannot express.
 *
 *   1. THE CALL OUTCOME. A `tel_click` says the operator dialled, never that
 *      anybody picked up — and the sequence branches on exactly that, since
 *      attempt 2 is "same day, ONLY if the call went unanswered". `answered`
 *      ends the plan: the operator is in conversation, and putting the next
 *      approach in front of that landlord tomorrow is the one way this feature
 *      could actively embarrass them.
 *   2. "I DID THIS ANOTHER WAY" — they rang from their own handset, or emailed
 *      before opening the page. It advances the plan and writes NO engagement
 *      event; see completeAttempt.ts for why that separation is load-bearing.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  completeAttempt,
  type CallOutcome,
} from "@/lib/contact/completeAttempt";
import type { ContactChannel } from "@/lib/contact/contactStrategy";

export const dynamic = "force-dynamic";

const CHANNELS: readonly ContactChannel[] = ["call", "whatsapp", "email"];
const OUTCOMES: readonly CallOutcome[] = ["answered", "no_answer", "voicemail"];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: leadId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: {
    channel?: unknown;
    call_outcome?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const channel = body.channel as ContactChannel;
  if (!CHANNELS.includes(channel)) {
    return NextResponse.json(
      { error: `channel must be one of: ${CHANNELS.join(", ")}` },
      { status: 400 }
    );
  }

  const callOutcome =
    body.call_outcome === undefined || body.call_outcome === null
      ? null
      : (body.call_outcome as CallOutcome);
  if (callOutcome !== null && !OUTCOMES.includes(callOutcome)) {
    return NextResponse.json(
      { error: `call_outcome must be one of: ${OUTCOMES.join(", ")}` },
      { status: 400 }
    );
  }

  // An outcome only means anything on a call. Accepting one on a WhatsApp
  // attempt would put a value in the column that nothing can interpret.
  if (callOutcome !== null && channel !== "call") {
    return NextResponse.json(
      { error: "call_outcome only applies to a call" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const customerId = (customer as { id: string }).id;

  // Identity from the session, never the body (§8). Scoping the lookup by
  // customer_id makes a foreign lead indistinguishable from a nonexistent one.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id")
    .eq("lead_id", leadId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!assignment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ⚠️ THIS ROUTE CAN ONLY EVER RECORD A MANUAL COMPLETION, WHATEVER IT IS SENT.
  //
  // `source` is deliberately hard-coded rather than read from the body. A
  // completion counts toward the engagement score only when it points at a real
  // lead_events row, and the only thing that can produce one is
  // /api/customer/events — which records the click first and passes its id.
  // Letting a caller post `source: "click"` here would be a way to manufacture
  // engagement with no click behind it, and engagement decides escalation,
  // pooling and reclaim (§3). The DB CHECK refuses the pair as well, so this is
  // the second of two stops rather than the only one.
  const result = await completeAttempt(admin, {
    assignmentId: (assignment as { id: string }).id,
    channel,
    source: "manual",
    callOutcome,
  });

  return NextResponse.json({
    ok: true,
    closed: result.closed,
    step: result.stepNumber ?? null,
    run_stopped: Boolean(result.runStopped),
  });
}
