import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { assignReplacementLead } from "@/lib/quality/replace";
import { sendQualityClaimResolvedEmail } from "@/lib/emails";
import type { LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/admin/quality-claims/[id]
 *
 * Adjudicate a dead-lead claim that decideClaim sent to review — because the
 * customer is over their hidden allowance, is flagged for manual review, or
 * because a co-assigned operator has the same lead live.
 *
 * Upholding runs exactly the same resolution as the automatic path: restore the
 * credit, then spend it on a different lead where one is available. The claimed
 * lead itself keeps its slot and is never passed to another operator.
 *
 * Body: { upheld: boolean, note?: string, consumes_allowance?: boolean }
 *
 * consumes_allowance defaults to true. Set it false to uphold a claim as a
 * goodwill gesture without spending the customer's budget — useful when the
 * lead was plainly our fault.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { upheld?: boolean; note?: string; consumes_allowance?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.upheld !== "boolean") {
    return NextResponse.json(
      { error: "upheld must be true or false" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: claimRow } = await admin
    .from("lead_quality_claims")
    .select("id, lead_id, customer_id, status")
    .eq("id", params.id)
    .maybeSingle();

  const claim = claimRow as {
    id: string;
    lead_id: string;
    customer_id: string;
    status: string;
  } | null;

  if (!claim) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (claim.status !== "under_review") {
    return NextResponse.json(
      { error: "This claim has already been decided" },
      { status: 409 }
    );
  }

  const note = typeof body.note === "string" ? body.note.trim() : null;

  // Commits the decision and, when upheld, the credit restore + counter
  // rollback + allowance spend. Returns false if something got there first.
  const { data: applied, error: resolveError } = await admin.rpc(
    "resolve_quality_claim",
    {
      p_claim_id: claim.id,
      p_upheld: body.upheld,
      p_reviewer: user?.id ?? null,
      p_review_note: note,
      p_consumes_allowance: body.consumes_allowance !== false,
    }
  );

  if (resolveError) {
    return NextResponse.json({ error: resolveError.message }, { status: 500 });
  }
  if (applied === false) {
    return NextResponse.json(
      { error: "This claim has already been decided" },
      { status: 409 }
    );
  }

  const [{ data: leadRow }, { data: customerRow }] = await Promise.all([
    admin
      .from("leads")
      .select("lead_name, lead_type")
      .eq("id", claim.lead_id)
      .maybeSingle(),
    admin
      .from("customers")
      .select("email, replacement_filter")
      .eq("id", claim.customer_id)
      .maybeSingle(),
  ]);

  const lead = leadRow as { lead_name: string; lead_type: LeadType } | null;
  const customer = customerRow as {
    email: string;
    replacement_filter: unknown;
  } | null;

  let resolution: "none" | "credit" | "replacement" = "none";

  if (body.upheld) {
    await admin.rpc("flag_lead_dead_if_unanimous", { p_lead_id: claim.lead_id });

    const resolved = await assignReplacementLead(
      admin,
      claim.customer_id,
      lead?.lead_type ?? "management",
      customer?.replacement_filter
    );
    resolution = resolved.resolution;

    await admin
      .from("lead_quality_claims")
      .update({
        resolution,
        replacement_assignment_id: resolved.assignmentId,
      })
      .eq("id", claim.id);
  }

  if (customer?.email) {
    await sendQualityClaimResolvedEmail({
      to: customer.email,
      leadName: lead?.lead_name ?? "that lead",
      upheld: body.upheld,
      resolution,
      reviewNote: note,
    });
  }

  return NextResponse.json({ ok: true, upheld: body.upheld, resolution });
}
