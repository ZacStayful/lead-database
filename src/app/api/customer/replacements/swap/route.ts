import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { completeAssignment } from "@/lib/ingest";
import { sendDeadLeadReviewEmail } from "@/lib/emails";
import {
  MIN_DETAIL_LENGTH,
  claimBudget,
  decideDeadLeadClaim,
  isReason,
  windowDaysForReason,
  type ClaimCustomer,
  type PeerAssignment,
} from "@/lib/quality/deadLeadPolicy";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Report a lead as already gone AND take a replacement, in one step (§53).
 *
 * ⚠️ THE ENTITLEMENT IS A HARD STOP HERE, WHERE THE CREDIT PATH ROUTES TO
 * REVIEW. §51.3 argues that going over should never be an automatic refusal,
 * because an operator receiving genuinely dead leads is exactly who exceeds a
 * budget. That still holds for a CREDIT, and /api/customer/dead-lead-claim is
 * unchanged. It does not hold for a swap: a swap costs two leads of stock
 * (§52.1) and the number is on screen, so a refusal is a fact the operator can
 * read rather than a silence they have to interpret.
 *
 * ⚠️ THREE SAFETY VALVES SURVIVE THAT HARD STOP, both silent and neither
 * spending anything:
 *
 *   * `quality_review_required` — the per-customer switch has to keep working.
 *   * A slot that is ALREADY a replacement (0146). Two dead landlords on one
 *     paid slot is a sourcing failure, and §51.8 says the queue exists to find
 *     those — so the second one is settled by a person rather than by nobody.
 *   * A peer visibly working the same lead. Withdrawing a lead another operator
 *     is building on, on one customer's say-so, is the one real harm this
 *     screen can do. ⚠️ It must NEVER say why — §19.7 forbids a refusal that
 *     tells operator A what operator B is doing, and the wording here is the
 *     same neutral sentence every review outcome uses.
 */

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
    new_lead_id?: unknown;
    reason?: unknown;
    detail?: unknown;
    contacted_on?: unknown;
    allow_filter_mismatch?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
  }

  const assignmentId = typeof body.assignment_id === "string" ? body.assignment_id : "";
  const newLeadId = typeof body.new_lead_id === "string" ? body.new_lead_id : "";
  if (!assignmentId || !newLeadId) {
    return NextResponse.json(
      { ok: false, code: "bad_request", message: "Pick a lead to swap in." },
      { status: 400 }
    );
  }

  // ⚠️ The reason is narrowed BEFORE any database work, because it decides the
  // window (§52.3) and an unknown one has to be refused without a round trip.
  if (!isReason(body.reason)) {
    return NextResponse.json(
      {
        ok: false,
        code: "reason_required",
        message: "Tell us which of these applies, so we can trace the lead back.",
      },
      { status: 400 }
    );
  }
  const reason = body.reason;
  const windowDays = windowDaysForReason(reason);

  const detail = typeof body.detail === "string" ? body.detail.trim() : "";
  if (detail.length < MIN_DETAIL_LENGTH) {
    return NextResponse.json(
      {
        ok: false,
        code: "detail_too_short",
        message: `Tell us what the landlord actually said, in at least ${MIN_DETAIL_LENGTH} characters.`,
      },
      { status: 400 }
    );
  }

  const contactedOn = typeof body.contacted_on === "string" ? body.contacted_on.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(contactedOn)) {
    return NextResponse.json(
      {
        ok: false,
        code: "contacted_on_required",
        message: "Tell us roughly when you spoke to them.",
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: eligibleRows, error: eligibleError } = await admin.rpc(
    "claimable_dead_lead_assignments",
    { p_customer_id: customer.id, p_window_days: windowDays }
  );
  if (eligibleError) {
    console.error("[replacements/swap] eligibility failed", eligibleError);
    return NextResponse.json(
      { ok: false, message: "We could not check that lead just now." },
      { status: 500 }
    );
  }
  const eligible = ((eligibleRows ?? []) as { assignment_id: string; lead_id: string }[])
    .find((r) => r.assignment_id === assignmentId);
  if (!eligible) {
    return NextResponse.json(
      {
        ok: false,
        code: "not_claimable",
        message:
          "That lead can no longer be replaced. Open it and try the landlord first, within 14 days of it arriving.",
      },
      { status: 400 }
    );
  }

  // The peers, read exactly as the credit path reads them.
  const { data: peerRows } = await admin
    .from("lead_assignments")
    .select("id, status, pipeline_stage")
    .eq("lead_id", eligible.lead_id)
    .neq("customer_id", customer.id);
  const peers: PeerAssignment[] = ((peerRows ?? []) as {
    status: string | null;
    pipeline_stage: string | null;
  }[]).map((p) => ({ status: p.status, pipeline_stage: p.pipeline_stage }));

  /**
   * How many replacements deep this slot already is (0146). A chained report
   * goes to a person, and the customer is told the same neutral sentence every
   * other review outcome uses.
   *
   * ⚠️ A FAILED READ IS NOT A CHAIN — the column is NOT NULL, so null means the
   * query did not come back, and the decision treats it as 0.
   */
  const { data: depthRow } = await admin
    .from("lead_assignments")
    .select("replacement_depth")
    .eq("id", assignmentId)
    .maybeSingle();
  const replacementDepth =
    (depthRow as { replacement_depth?: number | null } | null)?.replacement_depth ?? null;

  const verdict = decideDeadLeadClaim({
    customer: customer as unknown as ClaimCustomer,
    peers,
    reason,
    detail,
    contactedOn,
    replacementDepth,
  });

  // ⚠️ The three valves. `review` here means a person decides, and the customer
  // is told the same neutral sentence whichever of them fired — a message that
  // varied would tell them a peer is working their landlord.
  if (verdict.decision === "review") {
    const { data: applied, error: applyError } = await admin.rpc(
      "apply_dead_lead_claim",
      {
        p_assignment_id: assignmentId,
        p_customer_id: customer.id,
        p_reason: reason,
        p_detail: detail,
        p_contacted_on: contactedOn,
        p_decision: "review",
        p_consumes_allowance: false,
        p_corroboration: verdict.corroboration,
        p_window_days: windowDays,
      }
    );
    if (applyError) {
      console.error("[replacements/swap] review claim failed", applyError);
      return NextResponse.json(
        { ok: false, message: "We could not record that. Please try again." },
        { status: 400 }
      );
    }
    void applied;

    const { data: lead } = await admin
      .from("leads")
      .select("lead_name, address")
      .eq("id", eligible.lead_id)
      .maybeSingle();
    try {
      await sendDeadLeadReviewEmail({
        reason,
        detail,
        contactedOn,
        trigger: verdict.code,
        leadName: (lead as { lead_name?: string } | null)?.lead_name ?? "Unknown lead",
        leadAddress: (lead as { address?: string } | null)?.address ?? null,
        leadId: eligible.lead_id,
        assignedAt: null,
        business: customer.business_name,
        contactName: customer.contact_name,
        customerEmail: customer.email,
        peerNote:
          verdict.corroboration === "peer_contradicts"
            ? "Another operator holding this lead has it live."
            : "",
      });
    } catch (err) {
      console.error("[replacements/swap] review email failed", err);
    }

    return NextResponse.json({ ok: true, swapped: false, message: verdict.message });
  }

  // ⚠️ The entitlement is computed here with claimBudget() and PASSED IN. The
  // RPC re-reads the counter and the streak under its own conditional update,
  // so the arithmetic has one home (§51.3) and two tabs still cannot both pass.
  const entitlement = claimBudget(customer as unknown as ClaimCustomer);
  const claimsSeen = Math.max(0, Math.trunc(customer.quality_claims_this_cycle ?? 0));
  const streakSeen = Math.max(0, Math.trunc(customer.clean_leads_streak ?? 0));

  const { data: swapped, error: swapError } = await admin.rpc("customer_swap_dead_lead", {
    p_assignment_id: assignmentId,
    p_customer_id: customer.id,
    p_new_lead_id: newLeadId,
    p_reason: reason,
    p_detail: detail,
    p_contacted_on: contactedOn,
    p_entitlement: entitlement,
    p_claims_seen: claimsSeen,
    p_streak_seen: streakSeen,
    // Strict === true. The flag has to be SENT, so the picker cannot forget to
    // opt in — it has to opt in (§34, §35).
    p_allow_filter_mismatch: body.allow_filter_mismatch === true,
    p_window_days: windowDays,
  });

  if (swapError) {
    // ⚠️ NEVER pass error.message through verbatim. The admin swap route does
    // that deliberately, for an admin who can act on it; here the raises are
    // internal ("no_entitlement", "stock_floor") or race conditions the
    // customer can only be told to work around.
    const raw = String(swapError.message ?? "");
    console.error("[replacements/swap] swap failed", swapError);

    if (raw.includes("no_entitlement")) {
      return NextResponse.json(
        {
          ok: false,
          code: "no_entitlement",
          message: "You have used all of this month's replacements.",
        },
        { status: 409 }
      );
    }
    if (raw.includes("stock_floor")) {
      return NextResponse.json(
        {
          ok: false,
          code: "no_stock",
          message:
            "We are short of leads to swap in right now. Report it and we will look into it.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        code: "unavailable",
        message: "That lead has just gone — pick another one.",
      },
      { status: 409 }
    );
  }

  const result = (Array.isArray(swapped) ? swapped[0] : swapped) as
    | { claim_id: string; replacement_assignment_id: string; original_lead_id: string }
    | undefined;

  // ⚠️ The ORIGINAL lead id comes back from the RPC. After the swap it cannot be
  // re-derived: the assignment is deleted and the claim's pointer is nulled.
  if (result?.original_lead_id) {
    const { error: flagError } = await admin.rpc("flag_lead_dead_if_unanimous", {
      p_lead_id: result.original_lead_id,
    });
    if (flagError) console.error("[replacements/swap] flag failed", flagError);
  }

  // The replacement is a delivery, so it goes out through the same follow-through
  // every other assignment uses — the new-lead notification and its §42 contact
  // plan. `false` because no credit moved, exactly as the admin swap passes.
  if (result?.replacement_assignment_id) {
    const { data: newLead } = await admin
      .from("leads")
      .select("*")
      .eq("id", newLeadId)
      .maybeSingle();
    if (newLead) {
      try {
        await completeAssignment(
          admin,
          newLead as Lead,
          customer.id,
          result.replacement_assignment_id,
          false
        );
      } catch (err) {
        console.error("[replacements/swap] notify failed", err);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    swapped: true,
    assignment_id: result?.replacement_assignment_id ?? null,
    message: "Swapped. The replacement is in your leads now.",
  });
}
