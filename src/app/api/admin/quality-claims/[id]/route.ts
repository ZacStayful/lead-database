import { NextResponse, type NextRequest } from "next/server";
import { getUser, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { completeAssignment } from "@/lib/ingest";
import { sendDeadLeadUpheldEmail } from "@/lib/emails";
import type { Lead } from "@/lib/types";

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
 *   uphold_swap      — the reported lead is REPLACED with one the admin picks,
 *                      and nothing is refunded because nothing needs to be: the
 *                      customer keeps the slot they paid for and a different
 *                      lead goes into it. Added by 0139.
 *   decline          — nothing is refunded, and the note is what the customer
 *                      is shown.
 *
 * ⚠️ A SWAP IS ALWAYS A MANUAL DECISION. There is no automatic path to it, and
 * there must not be: a swap permanently withdraws the reported lead as well as
 * handing over a replacement, so each one costs two leads from a management
 * pool of about seventy. The hidden allowance still auto-upholds CREDITS.
 *
 * ⚠️ The function returns FALSE rather than raising when the claim is already
 * settled, so a double-click cannot refund twice. That answer is reported as a
 * 409 rather than a failure — nothing went wrong, the decision was simply
 * already made.
 */

const ACTIONS = ["uphold", "uphold_goodwill", "uphold_swap", "decline"] as const;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getUser();
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: {
    action?: unknown;
    note?: unknown;
    new_lead_id?: unknown;
    allow_filter_mismatch?: unknown;
  };
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
    .select("id, lead_id, customer_id, lead_assignment_id, status")
    .eq("id", params.id)
    .maybeSingle();

  if (!claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  if (action === "uphold_swap") {
    return upholdWithSwap(admin, params.id, user!.id, note, body, claim as ClaimRow);
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

    await notifyUpheld(admin, claim as ClaimRow, "credit", note, null);
  }

  return NextResponse.json({ ok: true, upheld });
}

type ClaimRow = {
  id: string;
  lead_id: string;
  customer_id: string;
  lead_assignment_id: string | null;
  status: string;
};

/**
 * Settle a claim by handing over a different lead.
 *
 * ⚠️ ONE RPC, NOT TWO CALLS. `resolve_dead_lead_claim_with_swap` marks the
 * claim and performs the swap in a single transaction. Calling the existing
 * swap route and then the existing resolve route cannot work: the swap deletes
 * the assignment, which nulls the claim's pointer, so a failure in between
 * leaves an under_review claim, no assignment, and a free lead already
 * delivered and emailed — non-atomic settlement of a money decision.
 */
async function upholdWithSwap(
  admin: ReturnType<typeof createAdminClient>,
  claimId: string,
  reviewerId: string,
  note: string,
  body: { new_lead_id?: unknown; allow_filter_mismatch?: unknown },
  claim: ClaimRow,
) {
  const newLeadId = typeof body?.new_lead_id === "string" ? body.new_lead_id : "";
  if (!newLeadId) {
    return NextResponse.json(
      { error: "Pick the lead to send in its place." },
      { status: 400 }
    );
  }

  /**
   * ⚠️ STRICT === true, copied from the swap route and for its reason: a truthy
   * 1 or "yes" must never place a lead the customer explicitly filtered out.
   * The flag has to be SENT, so a picker cannot forget to opt in — it has to
   * opt in.
   */
  const allowFilterMismatch = body?.allow_filter_mismatch === true;

  const { data, error } = await admin.rpc("resolve_dead_lead_claim_with_swap", {
    p_claim_id: claimId,
    p_reviewer: reviewerId,
    p_review_note: note || null,
    p_new_lead_id: newLeadId,
    p_allow_filter_mismatch: allowFilterMismatch,
  });

  if (error) {
    // The function raises in plain language for everything an admin can
    // actually act on — the customer is paused, the lead is at capacity, the
    // products do not match, the replacement is outside their filter. Passed
    // through verbatim, as the swap route already does.
    //
    // ⚠️ Nothing was recorded when this fires: the whole transaction rolled
    // back, so the claim is still under_review and can be decided again. That
    // is the correct reading of the message, not "the decision failed to save".
    console.error("[admin/quality-claims] swap failed", error);
    return NextResponse.json(
      { ok: false, error: error.message ?? "Could not place that replacement." },
      { status: 400 }
    );
  }

  const newAssignmentId = data as string | null;
  if (!newAssignmentId) {
    return NextResponse.json(
      { ok: false, code: "already_settled", error: "This claim is already settled." },
      { status: 409 }
    );
  }

  // Reporting only (invariant 11). Best effort: a failed flag must never cost
  // the customer their replacement.
  const { error: flagError } = await admin.rpc("flag_lead_dead_if_unanimous", {
    p_lead_id: claim.lead_id,
  });
  if (flagError) console.error("[admin/quality-claims] flag failed", flagError);

  /**
   * Notify exactly as an ordinary delivery does, by calling the same
   * `completeAssignment` ingest and the swap route use — a replacement IS a
   * delivery from the customer's side, and a second notification path written
   * for this one case would be a second thing to keep in step with their
   * preferences and opt-outs.
   *
   * `sendThresholdWarnings` is FALSE for the swap route's reason: a swap spends
   * no credit, so the balance has not moved, and the low-credit branches key on
   * exact balance values and would re-fire on every swap.
   */
  let notified = false;
  let replacementName: string | null = null;
  try {
    const { data: created } = await admin
      .from("lead_assignments")
      .select("id, customer_id, lead_id")
      .eq("id", newAssignmentId)
      .maybeSingle();

    if (created) {
      const { data: lead } = await admin
        .from("leads")
        .select("*")
        .eq("id", created.lead_id as string)
        .maybeSingle();

      if (lead) {
        replacementName = (lead as Lead).lead_name ?? null;
        await completeAssignment(
          admin,
          lead as Lead,
          created.customer_id as string,
          newAssignmentId,
          false
        );
        notified = true;
      }
    }
  } catch (err) {
    // The swap is committed and correct. A failed send must not be reported as
    // a failed decision — that invites a retry that then hits "already
    // settled". Surfaced so the admin knows to say so by hand.
    console.error("[admin/quality-claims] replacement placed, notify failed", err);
  }

  await notifyUpheld(admin, claim, "swap", note, {
    leadId: newAssignmentId,
    leadName: replacementName,
  });

  return NextResponse.json({
    ok: true,
    upheld: true,
    assignment_id: newAssignmentId,
    notified,
  });
}

/**
 * Tell the customer we agreed with them.
 *
 * Nothing told them anything before 0139 — §51.9 recorded the gap, and the
 * decision reached them only if they happened to reopen the lead.
 *
 * ⚠️ IT DOES NOT KNOW WHICH UPHOLD VERB FIRED, and must not. `uphold` and
 * `uphold_goodwill` differ only in whether the hidden allowance is spent, so an
 * email that read differently between them would publish that allowance to any
 * two operators comparing notes. Only the RESOLUTION reaches it.
 *
 * Best effort throughout: a failed send must never fail a decision that has
 * already moved money or a lead.
 */
async function notifyUpheld(
  admin: ReturnType<typeof createAdminClient>,
  claim: ClaimRow,
  resolution: "credit" | "swap",
  note: string,
  replacement: { leadId: string; leadName: string | null } | null,
) {
  try {
    const { data: customer } = await admin
      .from("customers")
      .select("email, contact_name")
      .eq("id", claim.customer_id)
      .maybeSingle();
    if (!customer?.email) return;

    const { data: lead } = await admin
      .from("leads")
      .select("lead_name")
      .eq("id", claim.lead_id)
      .maybeSingle();

    const { error } = await sendDeadLeadUpheldEmail({
      to: customer.email as string,
      contactName: (customer.contact_name as string | null) ?? null,
      leadName: (lead?.lead_name as string | null) ?? "that lead",
      resolution,
      replacementLeadName: replacement?.leadName ?? null,
      replacementLeadId: replacement?.leadId ?? null,
      note: note || null,
    });
    if (error) console.error("[admin/quality-claims] uphold email failed", error);
  } catch (err) {
    console.error("[admin/quality-claims] uphold email threw", err);
  }
}
