/**
 * One sequence: rename, pause, re-shape or archive it (§40.13).
 *
 * ⚠️ EDITING THE LADDER DOES NOT REACH BACK INTO A RUN THAT HAS ALREADY SENT.
 * `advanceRun` re-reads the steps every time, so a step added today lands on
 * every live run at its own cadence, and a step deleted today simply never
 * comes. What is deliberately NOT rewritten is anything already in the review
 * queue: text an operator may have read and approved must not change under
 * them because the ladder was edited afterwards.
 *
 * ⚠️ ARCHIVING STOPS THE LIVE RUNS. Leaving them would keep messaging landlords
 * from a sequence the operator believes they have switched off — the one thing
 * an "archive" button must never mean.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateSequenceInput } from "@/lib/messaging/sequenceInput";
import { stopRun } from "@/lib/messaging/sequences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { name?: unknown; steps?: unknown; is_active?: unknown; archive?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Ownership scoped by customer_id, so a foreign id is indistinguishable from
  // a nonexistent one.
  const { data: existing } = await admin
    .from("message_sequences")
    .select("id, trigger, lead_type, channel")
    .eq("id", params.id)
    .eq("customer_id", customer.id)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (body.archive === true) {
    await admin
      .from("message_sequences")
      .update({
        is_active: false,
        archived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.id);

    const { data: live } = await admin
      .from("message_sequence_runs")
      .select("id")
      .eq("sequence_id", params.id)
      .eq("status", "active");
    for (const r of (live ?? []) as { id: string }[]) {
      await stopRun(admin, r.id, "sequence_archived");
    }
    return NextResponse.json({ ok: true, archived: true, stopped: (live ?? []).length });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.is_active === "boolean") {
    patch.is_active = body.is_active;
  }

  // A name-and-active-only edit needs no ladder. Sending `steps` replaces it.
  if (body.steps !== undefined || typeof body.name === "string") {
    const verdict = validateSequenceInput({
      name: typeof body.name === "string" ? body.name : "unchanged",
      steps: body.steps,
      hasBookingLink: Boolean(customer.messaging_booking_link),
      // From the STORED row, not the request: an edit that does not mention the
      // product must still be judged against the product the sequence is on.
      leadType: (existing as { lead_type?: string }).lead_type,
    });
    if (body.steps !== undefined) {
      if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 400 });
      // Replace rather than diff. The unique (sequence_id, step_number) index
      // makes an in-place reorder a minefield of transient collisions, and a
      // ladder is small enough that rewriting it is simply cheaper.
      await admin.from("message_sequence_steps").delete().eq("sequence_id", params.id);
      const { error: stepErr } = await admin.from("message_sequence_steps").insert(
        verdict.steps.map((s, i) => ({
          sequence_id: params.id,
          step_number: i + 1,
          delay_days: s.delay_days,
          brief: s.brief,
          mode: s.mode,
          body_template: s.body_template,
        }))
      );
      if (stepErr) {
        console.error("[sequences] step replace failed", stepErr);
        return NextResponse.json({ error: "Could not save the messages." }, { status: 500 });
      }
    }
    if (typeof body.name === "string") {
      if (!verdict.ok && body.steps !== undefined) {
        return NextResponse.json({ error: verdict.error }, { status: 400 });
      }
      const trimmed = body.name.trim();
      if (!trimmed) return NextResponse.json({ error: "Give the sequence a name." }, { status: 400 });
      patch.name = trimmed.slice(0, 80);
    }
  }

  const { error } = await admin
    .from("message_sequences")
    .update(patch)
    .eq("id", params.id)
    .eq("customer_id", customer.id);

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        {
          error:
            "You already have an automatic sequence for new leads of this type. Archive that one first.",
          code: "standing_rule_exists",
        },
        { status: 409 }
      );
    }
    console.error("[sequences] update failed", error);
    return NextResponse.json({ error: "Could not save the sequence." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
