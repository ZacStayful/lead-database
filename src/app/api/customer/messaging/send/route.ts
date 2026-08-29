/**
 * Send one message to a landlord (§40).
 *
 * SESSION-ONLY. This acts with the customer's stored credential to message a
 * third party; an API key that could reach it would impersonate them outward.
 *
 * ⚠️ THE SEND ITSELF LIVES IN `sendOneMessage()`, NOT HERE. This route is
 * authentication, ownership and the two viewer-dependent switches; everything
 * from the connection lookup to the engagement event is one shared function,
 * because a scheduled sequence step walks the identical path and seven silent
 * rules (daily cap, minimum interval, quiet hours, cross-operator cooldown, the
 * idempotency claim, thread bookkeeping, `message_sent`) would otherwise exist
 * in two copies that drift.
 *
 * What stays here is what only an HTTP caller can answer:
 *   1. session + ownership — a foreign assignment id must be indistinguishable
 *      from a nonexistent one, which only this layer can arrange
 *   2. the kill switch and the channel allow-list, both of which take "is this
 *      viewer an admin" and are therefore meaningless to a cron
 *   3. turning a refusal into an HTTP status
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { messagingActiveFor, enabledChannels } from "@/lib/messaging/service";
import {
  sendOneMessage,
  type SendableAssignment,
} from "@/lib/messaging/sendOneMessage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 20_000;

export async function POST(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: {
    assignment_id?: unknown;
    channel?: unknown;
    subject?: unknown;
    body?: unknown;
    client_token?: unknown;
    draft_id?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const assignmentId = typeof body.assignment_id === "string" ? body.assignment_id : "";
  const channel = body.channel === "email" || body.channel === "whatsapp" ? body.channel : null;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  const clientToken = typeof body.client_token === "string" ? body.client_token : "";
  const draftId = typeof body.draft_id === "string" ? body.draft_id : null;

  if (!assignmentId || !channel) {
    return NextResponse.json({ error: "assignment_id and channel are required." }, { status: 400 });
  }
  if (!text || text.length > MAX_BODY) {
    return NextResponse.json({ error: "Write a message first." }, { status: 400 });
  }
  if (!clientToken) {
    return NextResponse.json({ error: "Missing client_token." }, { status: 400 });
  }

  const admin = createAdminClient();

  // messagingActiveFor, not messagingEnabled: an admin rehearsing on production
  // with the switch off must be able to send, or the composer opens correctly
  // and then 503s — which is the same bug one screen later.
  if (!(await messagingActiveFor(admin, isAdminUser(user)))) {
    return NextResponse.json(
      { error: "Messaging is currently switched off.", code: "disabled" },
      { status: 503 }
    );
  }

  // The UI hides email, but hiding is presentation. This is what stops a
  // hand-rolled POST reaching the dormant email path.
  const allowedChannels = await enabledChannels(admin, isAdminUser(user));
  if (!allowedChannels.includes(channel)) {
    return NextResponse.json(
      {
        error: "That channel is not available on your account.",
        code: "channel_disabled",
      },
      { status: 409 }
    );
  }

  // Ownership scoped by customer_id, so a foreign assignment id is
  // indistinguishable from a nonexistent one — the events-route rule, so this
  // cannot be used to probe which assignments exist.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id, status, closed_at, closed_reason, lead_id, leads(id, lead_name, email, phone, lead_type)")
    .eq("id", assignmentId)
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (!assignment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await sendOneMessage(admin, {
    customerId: customer.id,
    assignment: assignment as unknown as SendableAssignment,
    channel,
    text,
    subject: typeof body.subject === "string" ? body.subject : "",
    idempotencyKey: clientToken,
    sentByUserId: user.id,
    draftId,
    revealProviderDetail: isAdminUser(user),
  });

  if (!result.ok) {
    return NextResponse.json(
      result.retryAfterSeconds !== undefined
        ? { error: result.error, code: result.code, retry_after_seconds: result.retryAfterSeconds }
        : { error: result.error, code: result.code },
      { status: result.status }
    );
  }

  if (result.deduped) {
    return NextResponse.json({ ok: true, deduped: true, message: result.priorMessage });
  }

  return NextResponse.json({ ok: true, message_id: result.messageId });
}
