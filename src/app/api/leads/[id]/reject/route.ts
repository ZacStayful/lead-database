import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNewLeadEmail } from "@/lib/emails";
import { extractCity } from "@/lib/utils";
import type { Customer, Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEAD_PRICE = 15.0;

/**
 * Reject a lead assignment owned by the authenticated customer, then reassign
 * the lead to the next eligible customer (excluding the rejector). The status
 * flip, credit refund and slot reopen happen atomically in
 * reject_lead_assignment; reassignment is best-effort afterwards.
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

  let assignment_id: string | undefined;
  try {
    ({ assignment_id } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!assignment_id) {
    return NextResponse.json(
      { error: "assignment_id required" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Resolve customer_id from the session user.
  const { data: customer, error: customerError } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .single();
  if (customerError || !customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // Resolve the lead first so both the refund and the reassignment act on the
  // correct product — a rejected GR lead must refund the GR balance, not the
  // management one.
  const lead_id = params.id;
  const { data: lead } = await admin
    .from("leads")
    .select("*")
    .eq("id", lead_id)
    .single();

  const leadType = (lead as Lead | null)?.lead_type ?? "management";
  const price = leadType === "guaranteed_rent" ? 10.0 : LEAD_PRICE;

  // Atomic rejection. Fails (400) if the assignment is not owned by this
  // customer or is no longer in 'new' status. p_lead_type routes the credit
  // refund to the management or GR balance.
  const { error: rejectError } = await admin.rpc("reject_lead_assignment", {
    p_assignment_id: assignment_id,
    p_customer_id: customer.id,
    p_lead_type: leadType,
  });
  if (rejectError) {
    return NextResponse.json({ error: rejectError.message }, { status: 400 });
  }

  // Reassignment — find the next eligible customer, excluding the rejector.
  const { data: nextCustomers } = await admin.rpc(
    "get_next_customers_for_lead",
    {
      p_lead_id: lead_id,
      p_max: 1,
      p_exclude_customer_ids: [customer.id],
      p_lead_type: leadType,
    }
  );

  let reassigned = false;
  if (
    nextCustomers &&
    nextCustomers.length > 0 &&
    lead &&
    lead.assignment_count < lead.max_assignments
  ) {
    const nextCustomerId = (nextCustomers[0] as { customer_id: string })
      .customer_id;
    const { data: assignmentId, error: assignError } = await admin.rpc(
      "assign_lead_to_customer",
      {
        p_lead_id: lead_id,
        p_customer_id: nextCustomerId,
        p_price: price,
        p_lead_type: leadType,
      }
    );

    if (!assignError && assignmentId) {
      reassigned = true;

      // Notification + email for the new recipient, mirroring lead ingestion.
      const typedLead = lead as Lead;
      const { data: nextCustomer } = await admin
        .from("customers")
        .select("*")
        .eq("id", nextCustomerId)
        .single();

      const city = extractCity(typedLead.address);
      const { data: notification } = await admin
        .from("notifications")
        .insert({
          customer_id: nextCustomerId,
          lead_assignment_id: assignmentId,
          notification_type: "new_lead",
          message: `New lead: ${typedLead.lead_name}${city ? ` in ${city}` : ""}`,
        })
        .select("id")
        .single();

      let emailError: unknown = null;
      if (nextCustomer) {
        const { error } = await sendNewLeadEmail({
          to: (nextCustomer as Customer).email,
          lead: typedLead,
        });
        emailError = error;
      }

      await admin
        .from("lead_assignments")
        .update({ notification_sent: true, email_sent: !emailError })
        .eq("id", assignmentId);

      if (notification) {
        await admin
          .from("notifications")
          .update({ email_sent: !emailError })
          .eq("id", notification.id);
      }
    }
  }

  return NextResponse.json({ reassigned });
}
