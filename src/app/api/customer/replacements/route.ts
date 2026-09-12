import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { viewerScopedLead } from "@/lib/customerLeads";
import {
  CLAIM_WINDOW_DAYS,
  DEAD_LEAD_REASONS,
  DEAD_LEAD_REASON_LABELS,
  REASON_DETAIL_PROMPT,
  claimBudget,
  reasonAvailability,
  windowDaysForReason,
  type ClaimCustomer,
} from "@/lib/quality/deadLeadPolicy";
import {
  nextResetDate,
  remainingOf,
  type ReplacementEntitlement,
} from "@/lib/quality/replacementEntitlement";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The replacements shortlist, and the redacted candidate list for one row.
 *
 * Two reads on one route because they are one screen: the shortlist answers
 * "which of my leads can I replace", and `?assignment_id=` answers "what can I
 * have instead of this one". Splitting them would mean two places that have to
 * agree about eligibility.
 *
 * ⚠️ The entitlement is computed HERE, with `claimBudget()` — the same pure
 * function the credit path uses (§51.3). It is not restated in SQL. The swap
 * RPC re-reads only the COUNTER under its own conditional update, so the
 * arithmetic has one home and the race is still closed.
 */

interface ClaimableRow {
  assignment_id: string;
  lead_id: string;
  assigned_at: string;
  price_paid: number;
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function entitlementFor(customer: ClaimCustomer & {
  quality_claims_this_cycle?: number | null;
  billing_cycle_anchor?: string | null;
  gr_billing_cycle_anchor?: string | null;
  created_at?: string | null;
}): ReplacementEntitlement {
  const entitlement = claimBudget(customer);
  const used = Math.max(0, Math.trunc(customer.quality_claims_this_cycle ?? 0));
  return {
    entitlement,
    used,
    remaining: remainingOf(entitlement, used),
    resetsOn: nextResetDate(customer),
  };
}

export async function GET(req: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const assignmentId = req.nextUrl.searchParams.get("assignment_id");

  // ---- candidates for one row -------------------------------------------
  if (assignmentId) {
    const { data, error } = await admin.rpc(
      "get_customer_replacement_candidates",
      {
        p_assignment_id: assignmentId,
        // ⚠️ From the session, never the query string. The RPC scopes on it
        // too, so a foreign assignment id returns zero rows rather than
        // another customer's stock.
        p_customer_id: customer.id,
        p_limit: 20,
      }
    );
    if (error) {
      console.error("[replacements] candidates failed", error);
      return NextResponse.json(
        { ok: false, message: "We could not load replacements just now." },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true, candidates: data ?? [] });
  }

  // ---- the shortlist -----------------------------------------------------
  //
  // One eligibility read at the widest window answers every reason: the
  // competitor window (7 days) is strictly inside the authoritative one (14),
  // so `reasonAvailability` narrows per reason without a second round trip.
  const { data: rows, error } = await admin.rpc(
    "claimable_dead_lead_assignments",
    { p_customer_id: customer.id, p_window_days: CLAIM_WINDOW_DAYS }
  );
  if (error) {
    console.error("[replacements] shortlist failed", error);
    return NextResponse.json(
      { ok: false, message: "We could not load your leads just now." },
      { status: 500 }
    );
  }

  const claimable = (rows ?? []) as ClaimableRow[];
  const leadIds = claimable.map((r) => r.lead_id);

  const { data: leadRows } = leadIds.length
    ? await admin.from("leads").select("*").in("id", leadIds)
    : { data: [] as Lead[] };

  const leads = new Map(
    ((leadRows ?? []) as Lead[]).map((l) => [
      l.id,
      // §32.8: a resold imported lead must not ship the uploading operator's
      // own working notes to the buyer.
      viewerScopedLead(l, customer.id),
    ])
  );

  const items = claimable
    .map((r) => {
      const lead = leads.get(r.lead_id);
      if (!lead) return null;
      const ageDays = daysSince(r.assigned_at);
      return {
        assignment_id: r.assignment_id,
        lead_id: r.lead_id,
        assigned_at: r.assigned_at,
        age_days: ageDays,
        lead_name: lead.lead_name,
        address: lead.address,
        postcode_area: lead.postcode_area,
        bedrooms: lead.bedrooms,
        lead_type: lead.lead_type,
        gross_annual_income: lead.gross_annual_income,
        reasons: reasonAvailability({
          claimable: true,
          claimStatus: null,
          ageDays,
        }),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return NextResponse.json({
    ok: true,
    entitlement: entitlementFor(customer as never),
    items,
    reasons: DEAD_LEAD_REASONS.map((value) => ({
      value,
      label: DEAD_LEAD_REASON_LABELS[value],
      detail_prompt: REASON_DETAIL_PROMPT[value],
      window_days: windowDaysForReason(value),
    })),
  });
}
