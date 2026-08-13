import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { leadPriceFor } from "@/lib/plans";
import type { LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ClaimResult = {
  status: "claimed" | "already_claimed" | "not_available" | "not_visible";
  assignment_id: string | null;
  spent_credit: boolean;
  debit_after: number;
};

/**
 * POST /api/leads/pool/[id]/claim
 *
 * Take a lead out of the expired pool and into the customer's own leads tab.
 *
 * Chargeable, and deliberately so: the operator has already seen the contact
 * details and rung the landlord before deciding. That is the whole point of the
 * pool — calling is free, keeping is not — and it is also why a claimed lead is
 * not eligible for any refund or replacement. There is nothing to be
 * disappointed by that they had not already seen.
 *
 * Every rule lives in claim_pool_lead: product match, active subscription for
 * that product, lead filter, not-previously-assigned, and the race. This route
 * authenticates and nothing else, so the endpoint and the function cannot
 * disagree about who may claim what — the arrangement §5E describes for reject
 * and close.
 *
 * LOSING THE RACE IS NOT AN ERROR. Two operators ringing the same landlord and
 * one of them claiming first is the mechanism working as designed, so
 * 'already_claimed' comes back 200 with a flag rather than a 4xx. The UI says
 * "somebody else claimed this one" and refreshes the list. Only genuine faults
 * — unknown lead, wrong product — throw.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const leadId = params.id;
  if (!leadId) {
    return NextResponse.json({ error: "Lead id required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: customer, error: customerError } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .single();
  if (customerError || !customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // The product comes from the LEAD, never the request body. Letting the caller
  // name it would let a management-only subscriber claim a GR lead by asserting
  // it was management, and the price and the balance column both follow from
  // this value.
  const { data: lead, error: leadError } = await admin
    .from("leads")
    .select("id, lead_type")
    .eq("id", leadId)
    .maybeSingle();
  if (leadError || !lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const leadType = lead.lead_type as LeadType;

  const { data, error } = await admin.rpc("claim_pool_lead", {
    p_lead_id: leadId,
    p_customer_id: customer.id,
    p_price: leadPriceFor(leadType),
    p_lead_type: leadType,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const result = (Array.isArray(data) ? data[0] : data) as ClaimResult | undefined;
  if (!result) {
    return NextResponse.json({ error: "Claim failed" }, { status: 500 });
  }

  if (result.status !== "claimed") {
    return NextResponse.json({ ok: false, status: result.status }, { status: 200 });
  }

  return NextResponse.json({
    ok: true,
    status: "claimed",
    assignment_id: result.assignment_id,
    // Which of the two costs was paid, so the confirmation can say "one credit
    // used" or "your next cycle is one lead shorter" rather than guessing from
    // a balance the client would have to re-fetch.
    spent_credit: result.spent_credit,
    pool_debit: result.debit_after,
  });
}
