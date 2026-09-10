import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDeadLeadReviewEmail } from "@/lib/emails";
import {
  CLAIM_WINDOW_DAYS,
  DEAD_LEAD_REASON_LABELS,
  decideDeadLeadClaim,
  type DeadLeadReason,
  type PeerAssignment,
} from "@/lib/quality/deadLeadPolicy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Report a lead as having been dead before the operator reached it (§51).
 *
 * ⚠️ A NEW ROUTE, DELIBERATELY NOT A REASON CODE ON /api/leads/[id]/reject.
 * Reject is gated on `pipeline_stage = 'cold'` — nothing built on the lead yet
 * (§5E) — and a dead-lead claim requires the exact opposite: proof the operator
 * actually worked it. Overloading one verb with two opposite predicates is how
 * the two come to disagree, and the disagreement would be about money. Reject
 * is untouched by this file and remains chargeable.
 *
 * The order of what follows is the design:
 *
 *   1. The database decides ELIGIBILITY, through
 *      `claimable_dead_lead_assignments`. An assignment it does not return is
 *      answered here with the specific missing thing and NOTHING IS WRITTEN, so
 *      an operator who has not yet opened the lead can still claim properly once
 *      they have.
 *   2. TypeScript decides the ALLOWANCE and reads the peers, because that is
 *      arithmetic worth unit-testing directly rather than through a route.
 *   3. `apply_dead_lead_claim` re-asserts (1) under a row lock and commits, so
 *      route and function cannot disagree and two submits cannot both pass.
 */

const REASONS = Object.keys(DEAD_LEAD_REASON_LABELS) as DeadLeadReason[];

export async function POST(req: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  let body: {
    assignment_id?: unknown;
    reason?: unknown;
    detail?: unknown;
    contacted_on?: unknown;
  };
  try {
    body = await req.json();
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

  const admin = createAdminClient();

  // 1 — eligibility, from the one predicate that owns it.
  const { data: claimable, error: claimableError } = await admin.rpc(
    "claimable_dead_lead_assignments",
    { p_customer_id: customer.id, p_window_days: CLAIM_WINDOW_DAYS }
  );

  if (claimableError) {
    console.error("[dead-lead-claim] eligibility read failed", claimableError);
    return NextResponse.json(
      { error: "Could not check this lead. Please try again." },
      { status: 500 }
    );
  }

  const rows = (claimable ?? []) as {
    assignment_id: string;
    lead_id: string;
    assigned_at: string;
  }[];
  const eligible = rows.find((r) => r.assignment_id === assignmentId);

  if (!eligible) {
    // ⚠️ Why, not just no. The commonest reason by far is that the operator has
    // not opened the lead in this browser yet, and "you cannot report this"
    // with no explanation reads as us refusing to listen.
    return NextResponse.json(
      {
        ok: false,
        code: "not_claimable",
        message:
          `Open the lead and try the landlord first — we can only look into a lead once you have actually worked it, and within ${CLAIM_WINDOW_DAYS} days of it arriving.`,
      },
      { status: 400 }
    );
  }

  // 2 — the peers. Everyone else holding this same lead, and how their own
  // claim went. One operator with the lead live contradicts a claim it was
  // dead; one whose claim is already settled corroborates it.
  const { data: peerRows } = await admin
    .from("lead_assignments")
    .select("id, status, pipeline_stage")
    .eq("lead_id", eligible.lead_id)
    .neq("customer_id", customer.id);

  const { data: peerClaims } = await admin
    .from("lead_quality_claims")
    .select("lead_assignment_id, status")
    .eq("lead_id", eligible.lead_id)
    .neq("customer_id", customer.id);

  const claimByAssignment = new Map(
    ((peerClaims ?? []) as { lead_assignment_id: string; status: string }[]).map(
      (c) => [c.lead_assignment_id, c.status]
    )
  );

  const peers: PeerAssignment[] = (
    (peerRows ?? []) as {
      id: string;
      status: string | null;
      pipeline_stage: string | null;
    }[]
  ).map((p) => ({
    status: p.status,
    pipeline_stage: p.pipeline_stage,
    claim_status: claimByAssignment.get(p.id) ?? null,
  }));

  const verdict = decideDeadLeadClaim({
    customer,
    peers,
    reason: body?.reason,
    detail: body?.detail,
    contactedOn: body?.contacted_on,
  });

  if (verdict.decision === "ineligible") {
    return NextResponse.json(
      { ok: false, code: verdict.code, message: verdict.message },
      { status: 400 }
    );
  }

  // 3 — commit. Eligibility is re-asserted inside the function under the row
  // lock, so a second submit racing this one is refused there rather than here.
  const { data: applied, error: applyError } = await admin.rpc(
    "apply_dead_lead_claim",
    {
      p_assignment_id: assignmentId,
      p_customer_id: customer.id,
      p_reason: body.reason as string,
      p_detail: String(body.detail ?? "").trim(),
      p_contacted_on: String(body.contacted_on ?? "").trim() || null,
      p_decision: verdict.decision,
      p_consumes_allowance: verdict.consumesAllowance,
      p_corroboration: verdict.corroboration,
      p_window_days: CLAIM_WINDOW_DAYS,
    }
  );

  if (applyError) {
    console.error("[dead-lead-claim] apply failed", applyError);
    return NextResponse.json(
      {
        ok: false,
        code: "apply_failed",
        message: "We could not record that. Please try again.",
      },
      { status: 400 }
    );
  }

  const result = (Array.isArray(applied) ? applied[0] : applied) as
    | { claim_id: string; claim_status: string; upheld: boolean }
    | undefined;

  // The lead flag. Reporting only for now — invariant 11 names
  // `lead_retired_from_allocation()` as the single expression of what retires a
  // lead, and adding a fourth basis belongs in its own change. Best effort: a
  // failed flag must never cost the customer their credit.
  if (result?.upheld) {
    const { error: flagError } = await admin.rpc(
      "flag_lead_dead_if_unanimous",
      { p_lead_id: eligible.lead_id }
    );
    if (flagError) {
      console.error("[dead-lead-claim] flag failed", flagError);
    }
  }

  // A claim a person has to read. Emailed rather than left in a queue nobody
  // opens — §42.9's lesson about a page nobody is asked to look at.
  if (verdict.decision === "review") {
    const { data: lead } = await admin
      .from("leads")
      .select("lead_name, address")
      .eq("id", eligible.lead_id)
      .maybeSingle();

    const livePeers = peers.filter(
      (p) => p.status === "in_discussion" || p.status === "won"
    ).length;

    const { error: emailError } = await sendDeadLeadReviewEmail({
      reason:
        DEAD_LEAD_REASON_LABELS[body.reason as DeadLeadReason] ??
        String(body.reason),
      detail: String(body.detail ?? "").trim(),
      contactedOn: String(body.contacted_on ?? "").trim() || null,
      trigger:
        verdict.code === "peer_contradicts"
          ? "Another operator holding this lead has it live, so this one wants a person's eyes."
          : verdict.code === "customer_under_review"
            ? "This operator is flagged for review, so every claim of theirs comes here."
            : "Beyond what we uphold automatically for this operator.",
      leadName: (lead as { lead_name?: string } | null)?.lead_name ?? "Lead",
      leadAddress: (lead as { address?: string } | null)?.address ?? null,
      leadId: eligible.lead_id,
      assignedAt: eligible.assigned_at,
      business: customer.business_name ?? "",
      contactName: customer.contact_name ?? "",
      customerEmail: customer.email ?? "",
      peerNote:
        peers.length === 0
          ? "This lead went to them alone"
          : `${peers.length} other operator(s), ${livePeers} still working it`,
    });
    if (emailError) {
      console.error("[dead-lead-claim] review email failed", emailError);
    }
  }

  return NextResponse.json({
    ok: true,
    // ⚠️ `upheld` and `message` only. The verdict's reasoning stays here: a
    // response that said which of the two upheld branches fired would let an
    // operator infer the allowance by experiment, which §51 exists to prevent.
    upheld: Boolean(result?.upheld),
    message: verdict.message,
  });
}

/** The three reasons, for the form. */
export async function GET() {
  return NextResponse.json({
    reasons: REASONS.map((value) => ({
      value,
      label: DEAD_LEAD_REASON_LABELS[value],
    })),
    window_days: CLAIM_WINDOW_DAYS,
  });
}
