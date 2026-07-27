import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stagesForLeadType } from "@/components/dashboard/pipelineStage";
import type { LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update the authenticated customer's own lead assignment.
 * Supports: mark viewed (viewed_at), mark contacted (status), set the
 * pipeline_stage, and set/clear the due_to_call_date.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    viewed?: boolean;
    contacted?: boolean;
    signed?: boolean;
    pipeline_stage?: string;
    due_to_call_date?: string | null;
    income_estimate?: number | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    body.income_estimate !== undefined &&
    body.income_estimate !== null &&
    !Number.isFinite(body.income_estimate)
  ) {
    return NextResponse.json(
      { error: "income_estimate must be a number" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Confirm ownership before mutating. The lead's type comes back too, because
  // valid pipeline stages differ per product and cannot be checked until we
  // know which product this is.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select(
      "id, customer_id, viewed_at, first_contacted_at, status, customers!inner(user_id), leads(lead_type)"
    )
    .eq("id", params.id)
    .maybeSingle();

  const ownerId = (assignment as { customers?: { user_id?: string } } | null)
    ?.customers?.user_id;

  if (!assignment || ownerId !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // A lead this customer has rejected is settled: they have said they are
  // passing on it and it stays chargeable (0019). Every mutation that would
  // move it back into a working state is refused HERE, in one place, rather
  // than field by field — enforcing it per field is what let `contacted`
  // through while `signed` and `pipeline_stage` were covered.
  //
  // `contacted` is not the mild one of the three. It is the laundering step:
  // flipping status off 'rejected' unlocks both the stage editor and the
  // signed button, each of which refuses a rejected lead directly, and the
  // lead can then be recorded as a conversion the customer declined. The
  // database's own guard (mark_assignment_won skips 'rejected') is then being
  // handed a status that no longer says rejected.
  //
  // viewed_at, due_to_call_date and income_estimate are deliberately still
  // allowed: they are private record-keeping that changes no outcome.
  //
  // Scoped to this assignment alone, which is exactly right: the same lead may
  // sit with another operator as a separate row with its own status, and one
  // customer's rejection must not freeze anybody else's pipeline.
  if ((assignment as { status?: string }).status === "rejected") {
    const blocked = body.contacted
      ? "marked as contacted"
      : body.signed
        ? "marked as signed"
        : body.pipeline_stage !== undefined
          ? "moved to another pipeline stage"
          : null;
    if (blocked) {
      return NextResponse.json(
        { error: `A rejected lead cannot be ${blocked}` },
        { status: 400 }
      );
    }
  }

  // Validate the stage against THIS lead's product.
  //
  // Previously this checked against PIPELINE_STAGES — the Management list — for
  // every lead, so a Guaranteed Rent customer setting any of their own stages
  // (viewing_booked / contract_sent / contract_signed) got a 400 and could not
  // move a lead through their pipeline at all. supabase-js types an embedded
  // to-one as an array while PostgREST returns an object, so accept both.
  if (body.pipeline_stage !== undefined) {
    const rawLead = (assignment as { leads?: unknown }).leads;
    const lead = (Array.isArray(rawLead) ? rawLead[0] : rawLead) as
      | { lead_type?: LeadType }
      | null
      | undefined;
    const allowed = stagesForLeadType(lead?.lead_type);
    if (!allowed.some((s) => s.value === body.pipeline_stage)) {
      return NextResponse.json(
        { error: "Invalid pipeline_stage for this lead type" },
        { status: 400 }
      );
    }
  }

  const update: Record<string, unknown> = {};
  if (body.viewed && !(assignment as { viewed_at?: string }).viewed_at) {
    update.viewed_at = new Date().toISOString();
  }
  if (body.contacted) {
    update.status = "contacted";
  }
  // Stamp the first-contact time once, on the first contacted/signed action, so
  // speed-to-lead analytics measure the true first touch. Never overwritten.
  if (
    (body.contacted || body.signed) &&
    !(assignment as { first_contacted_at?: string }).first_contacted_at
  ) {
    update.first_contacted_at = new Date().toISOString();
  }
  // Terminal positive outcome: the operator has signed / onboarded the landlord.
  // Independent of pipeline_stage — this is the conversion signal the ROI funnel
  // counts. The rejected case is refused by the settled-lead guard above.
  if (body.signed) {
    update.status = "won";
  }
  if (body.pipeline_stage !== undefined) {
    update.pipeline_stage = body.pipeline_stage;
  }
  if (body.due_to_call_date !== undefined) {
    // Empty string clears the date.
    update.due_to_call_date = body.due_to_call_date || null;
  }
  if (body.income_estimate !== undefined) {
    update.income_estimate =
      body.income_estimate === null ? null : Number(body.income_estimate);
  }

  // Stamp the status-change time whenever this PATCH changes `status`, so the
  // inactivity nudge can measure days since last activity. pipeline_stage is a
  // separate column and is deliberately not treated as a status change.
  if (update.status !== undefined) {
    update.last_status_change_at = new Date().toISOString();
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ status: "noop" });
  }

  const { data, error } = await admin
    .from("lead_assignments")
    .update(update)
    .eq("id", params.id)
    .select(
      "id, viewed_at, status, pipeline_stage, due_to_call_date, income_estimate"
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, assignment: data });
}
