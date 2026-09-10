import { NextResponse, type NextRequest } from "next/server";
import { getUser, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Decide one dead-lead claim (CLAUDE.md §51).
 *
 * ⚠️ SESSION AUTH ONLY, deliberately not `isAdminRequest`. That helper also
 * accepts `x-admin-key`, which exists so crons can call in — and this decision
 * moves money and has to be attributable to a person, because `reviewed_by` is
 * the record of who upheld it. §43.3 takes the same position for repointing a
 * login.
 *
 * Three outcomes, all through `resolve_dead_lead_claim` so the effects of an
 * uphold can never drift from the automatic path:
 *
 *   uphold           — the credit goes back and one of the hidden allowance is
 *                      spent, exactly as an automatic uphold would have.
 *   uphold_goodwill  — the credit goes back and NOTHING is spent. For a claim
 *                      that is probably right but unproven, or one we would
 *                      rather settle than argue: the customer is made whole
 *                      without their future claims being made harder.
 *   decline          — nothing is refunded, and the note is what the customer
 *                      is shown.
 *
 * ⚠️ The function returns FALSE rather than raising when the claim is already
 * settled, so a double-click cannot refund twice. That answer is reported as a
 * 409 rather than a failure — nothing went wrong, the decision was simply
 * already made.
 */

const ACTIONS = ["uphold", "uphold_goodwill", "decline"] as const;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getUser();
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { action?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = typeof body?.action === "string" ? body.action : "";
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${ACTIONS.join(", ")}` },
      { status: 400 }
    );
  }

  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (action === "decline" && note.length === 0) {
    // A decline the customer cannot make sense of is the one outcome here that
    // loses us a customer rather than a credit.
    return NextResponse.json(
      { error: "Say why, so the customer gets an answer rather than a refusal." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: claim } = await admin
    .from("lead_quality_claims")
    .select("id, lead_id, status")
    .eq("id", params.id)
    .maybeSingle();

  if (!claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  const upheld = action !== "decline";

  const { data: applied, error } = await admin.rpc("resolve_dead_lead_claim", {
    p_claim_id: params.id,
    p_upheld: upheld,
    p_reviewer: user!.id,
    p_review_note: note || null,
    p_consumes_allowance: action === "uphold",
  });

  if (error) {
    console.error("[admin/quality-claims] resolve failed", error);
    return NextResponse.json(
      { error: "Could not record that decision." },
      { status: 500 }
    );
  }

  if (applied === false) {
    return NextResponse.json(
      { ok: false, code: "already_settled", error: "This claim is already settled." },
      { status: 409 }
    );
  }

  if (upheld) {
    // Reporting only — invariant 11 keeps the flag out of every candidate
    // function. Best effort: a failed flag must never cost the refund.
    const { error: flagError } = await admin.rpc("flag_lead_dead_if_unanimous", {
      p_lead_id: (claim as { lead_id: string }).lead_id,
    });
    if (flagError) {
      console.error("[admin/quality-claims] flag failed", flagError);
    }
  }

  return NextResponse.json({ ok: true, upheld });
}
