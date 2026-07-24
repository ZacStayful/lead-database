import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Manually adjust a customer's monthly allocation / active flag. Admin only. */
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

  let body: {
    monthly_allocation?: number;
    lead_balance?: number;
    is_active?: boolean;
    leads_received_this_month?: number;
    gr_subscription_status?: string;
    gr_monthly_allocation?: number;
    gr_leads_received_this_month?: number;
    gr_lead_balance?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  // Number.isFinite rejects NaN/Infinity, which pass a bare typeof check when
  // the form submits an empty number input.
  if (Number.isFinite(body.monthly_allocation)) {
    update.monthly_allocation = Math.max(0, Math.floor(body.monthly_allocation!));
  }
  if (typeof body.is_active === "boolean") {
    update.is_active = body.is_active;
  }
  if (Number.isFinite(body.leads_received_this_month)) {
    update.leads_received_this_month = Math.max(
      0,
      Math.floor(body.leads_received_this_month!)
    );
  }
  // lead_balance is the real management credit gate (assign_lead_to_customer
  // only assigns while it is > 0). Editable so an admin can top up a comped
  // customer or one whose subscription won't auto-credit.
  if (Number.isFinite(body.lead_balance)) {
    update.lead_balance = Math.max(0, Math.floor(body.lead_balance!));
  }

  // Guaranteed Rent controls — mirror the management fields on the GR columns.
  if (
    body.gr_subscription_status === "active" ||
    body.gr_subscription_status === "inactive"
  ) {
    update.gr_subscription_status = body.gr_subscription_status;
  }
  if (Number.isFinite(body.gr_monthly_allocation)) {
    update.gr_monthly_allocation = Math.max(
      0,
      Math.floor(body.gr_monthly_allocation!)
    );
  }
  if (Number.isFinite(body.gr_leads_received_this_month)) {
    update.gr_leads_received_this_month = Math.max(
      0,
      Math.floor(body.gr_leads_received_this_month!)
    );
  }
  if (Number.isFinite(body.gr_lead_balance)) {
    update.gr_lead_balance = Math.max(0, Math.floor(body.gr_lead_balance!));
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("customers")
    .update(update)
    .eq("id", params.id)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ status: "ok", customer: data });
}
