/**
 * Act on one queued message before it sends (§40.13).
 *
 * Three verbs, and they are three different intentions that must not be folded
 * into one:
 *
 *   PATCH { body }      — rewrite it. Still sends, at the same time.
 *   POST  { action:"cancel" } — not this message. The ladder carries on, and
 *                         the next step arrives on its normal cadence.
 *   POST  { action:"stop" }   — stop chasing this landlord entirely.
 *
 * Collapsing cancel and stop into one button would make an operator who did not
 * fancy today's wording lose the whole sequence, or — far worse the other way —
 * make somebody who wanted to leave a landlord alone get messaged again in
 * three days.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { skipStep, stopRun } from "@/lib/messaging/sequences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The same ceiling the composer uses. */
const MAX_BODY = 20_000;

interface DraftRow {
  id: string;
  run_id: string;
  step_number: number;
  state: string;
  message_sequence_runs: { id: string; sequence_id: string } | null;
}

async function loadOwned(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
  customerId: string
): Promise<DraftRow | null> {
  const { data } = await admin
    .from("message_sequence_drafts")
    .select("id, run_id, step_number, state, message_sequence_runs(id, sequence_id)")
    .eq("id", id)
    .eq("customer_id", customerId)
    .maybeSingle();
  return (data as unknown as DraftRow | null) ?? null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { body?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text || text.length > MAX_BODY) {
    return NextResponse.json({ error: "Write a message first." }, { status: 400 });
  }

  const admin = createAdminClient();
  const draft = await loadOwned(admin, params.id, customer.id);
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (draft.state !== "pending") {
    return NextResponse.json(
      { error: "That message has already gone.", code: "not_pending" },
      { status: 409 }
    );
  }

  // ⚠️ The operator's edit is written to the QUEUE, never back over
  // message_draft_requests.draft_text. That column is what the model wrote, and
  // the send path compares the two to decide whether the message was edited —
  // overwriting it would make the whole "do drafted messages convert better"
  // question unanswerable, in the direction that always reads as a success.
  const { error } = await admin
    .from("message_sequence_drafts")
    .update({
      body: text,
      edited_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .eq("state", "pending");

  if (error) {
    console.error("[sequence-drafts] edit failed", error);
    return NextResponse.json({ error: "Could not save the change." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = body.action === "stop" ? "stop" : body.action === "cancel" ? "cancel" : null;
  if (!action) {
    return NextResponse.json({ error: "action must be cancel or stop." }, { status: 400 });
  }

  const admin = createAdminClient();
  const draft = await loadOwned(admin, params.id, customer.id);
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (draft.state !== "pending") {
    return NextResponse.json(
      { error: "That message has already gone.", code: "not_pending" },
      { status: 409 }
    );
  }

  if (action === "stop") {
    // stopRun sweeps every pending step on the run, this one included.
    await stopRun(admin, draft.run_id, "operator_stopped");
    return NextResponse.json({ ok: true, stopped: true });
  }

  await skipStep(admin, {
    runId: draft.run_id,
    sequenceId: draft.message_sequence_runs?.sequence_id ?? "",
    stepNumber: draft.step_number,
    reason: "operator_cancelled",
  });
  return NextResponse.json({ ok: true, cancelled: true });
}
