/**
 * Put leads into a sequence (§40.13) — one, or two hundred.
 *
 * This is the route that clears the backlog. The book it exists for: ~247
 * workable leads across the top twelve operators, one of whom has 21 that have
 * never been contacted at all and another 19 that were contacted once and then
 * abandoned.
 *
 * ⚠️ IT ENROLS, IT DOES NOT SEND. Nothing goes out from this request. The
 * drafting cron writes a message this evening, it sits in the review queue
 * overnight, and the sending phase posts it in the morning if nobody kills it.
 * A route that sent two hundred WhatsApps synchronously would blow every send
 * limit at once, take minutes, and be the exact burst that gets an operator's
 * number restricted.
 *
 * ⚠️ AND IT REPORTS HOW LONG THE BACKLOG WILL TAKE. `daily_send_cap` defaults to
 * 40; a three-step sequence over two hundred leads is six hundred messages,
 * which is fifteen days. An operator who enrols their whole book expecting it
 * out this afternoon has been misled by our silence, and the first they would
 * hear of it is a landlord ringing about a message sent a fortnight late.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { messagingActiveFor } from "@/lib/messaging/service";
import { enrolAssignments, loadSteps } from "@/lib/messaging/sequences";
import { daysToClear } from "@/lib/messaging/cadence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One enrolment cannot exceed a whole book. Above this, something is wrong. */
const MAX_PER_REQUEST = 500;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  if (!(await messagingActiveFor(admin, isAdminUser(user)))) {
    return NextResponse.json(
      { error: "Messaging is currently switched off.", code: "disabled" },
      { status: 503 }
    );
  }

  let body: { assignment_ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = Array.isArray(body.assignment_ids)
    ? Array.from(
        new Set(
          body.assignment_ids.filter((v): v is string => typeof v === "string" && v.length > 0)
        )
      )
    : [];

  if (ids.length === 0) {
    return NextResponse.json({ error: "Choose at least one lead." }, { status: 400 });
  }
  if (ids.length > MAX_PER_REQUEST) {
    return NextResponse.json(
      { error: `${MAX_PER_REQUEST} leads at a time is the limit.` },
      { status: 400 }
    );
  }

  const { data: sequence } = await admin
    .from("message_sequences")
    .select("id, is_active, archived_at")
    .eq("id", params.id)
    .eq("customer_id", customer.id)
    .maybeSingle();

  const seq = sequence as { is_active: boolean; archived_at: string | null } | null;
  if (!seq) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!seq.is_active || seq.archived_at) {
    return NextResponse.json(
      { error: "That sequence is switched off. Turn it back on first.", code: "inactive" },
      { status: 409 }
    );
  }

  const steps = await loadSteps(admin, params.id);
  if (steps.length === 0) {
    return NextResponse.json(
      { error: "That sequence has no messages in it yet.", code: "no_steps" },
      { status: 409 }
    );
  }

  const result = await enrolAssignments(admin, {
    customerId: customer.id,
    sequenceId: params.id,
    assignmentIds: ids,
    enrolledBy: user.id,
  });

  const { data: conn } = await admin
    .from("customer_whatsapp_connections")
    .select("daily_send_cap")
    .eq("customer_id", customer.id)
    .maybeSingle();
  const cap = (conn as { daily_send_cap?: number } | null)?.daily_send_cap ?? 40;

  return NextResponse.json({
    ok: true,
    ...result,
    steps: steps.length,
    daily_send_cap: cap,
    days_to_clear: daysToClear(result.enrolled, steps.length, cap),
  });
}
