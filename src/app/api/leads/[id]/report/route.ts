import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { LEAD_REPORTS_BUCKET } from "@/lib/incomeReportStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One admin sitting is not the shape here — this is a click, so keep it short. */
const SIGNED_URL_TTL_SECONDS = 60;

/**
 * GET /api/leads/[id]/report
 *
 * The Stayful property analysis this lead's income figures were read from
 * (0092). `[id]` is the LEAD id, not an assignment: both audiences reach the
 * report that way, as /api/leads/pool/[id]/claim already does.
 *
 * TWO AUDIENCES, TWO EXISTING PREDICATES, NO THIRD DEFINITION.
 *
 *   1. an operator the lead is assigned to — the existence of the row is the
 *      entitlement, and status is deliberately not consulted, exactly as
 *      /api/customer/files/[id]/download declines to consult it. A rejected or
 *      closed lead is still a lead they paid for (invariant 4).
 *   2. anyone who can see it in the expired pool, via
 *      customer_can_see_pool_lead — the same function the listing and the claim
 *      share (§19.4), so the pool can never show a lead whose analysis this
 *      route then refuses.
 *
 * That second one means a POOLED LEAD'S ANALYSIS CAN BE READ WITHOUT CLAIMING
 * IT. Deliberate, and a commercial decision rather than an oversight: §19.7's
 * bargain is that calling is free and keeping is not, and this widens the free
 * half. What it must not widen is the presentation, which stays behind an
 * assignment.
 *
 * ONE 404 FOR EVERYTHING. "No report stored" and "not yours" come back
 * identically, so the endpoint cannot be used to find out which leads exist.
 *
 * Redirects to a short-lived signed URL rather than streaming the bytes — the
 * lead-files download route's shape, and the reason the bucket needs no
 * storage.objects policy at all: a signed URL is authorised by its signature.
 * Served INLINE, with no `download` option, because an operator wants to read
 * this before a call rather than file it.
 */
export async function GET(
  _req: NextRequest,
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

  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const { data: lead } = await admin
    .from("leads")
    .select("id, income_report_path")
    .eq("id", leadId)
    .maybeSingle();

  const path = (lead as { income_report_path?: string | null } | null)
    ?.income_report_path;
  if (!path) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Cheapest test first: most reads are by the operator who holds the lead, and
  // that is a single indexed lookup against an RPC round trip.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id")
    .eq("lead_id", leadId)
    .eq("customer_id", customer.id)
    .maybeSingle();

  let allowed = Boolean(assignment);
  if (!allowed) {
    const { data: visible, error: visibleError } = await admin.rpc(
      "customer_can_see_pool_lead",
      { p_lead_id: leadId, p_customer_id: customer.id }
    );
    if (visibleError) {
      // Fail CLOSED. The pool half is the permissive one, and an unreadable
      // predicate is not permission.
      console.error("lead report: pool visibility check failed", leadId, visibleError);
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    allowed = visible === true;
  }

  if (!allowed) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: signed, error: signError } = await admin.storage
    .from(LEAD_REPORTS_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    console.error("lead report: signing failed", leadId, signError);
    return NextResponse.json(
      { error: "Could not open the report" },
      { status: 502 }
    );
  }

  return NextResponse.redirect(signed.signedUrl);
}
