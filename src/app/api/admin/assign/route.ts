import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { sendNewLeadEmail } from "@/lib/emails";
import { extractCity } from "@/lib/utils";
import type { Customer, Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEAD_PRICE = 15.0;

/** Force-assign a lead to a specific customer. Admin only. */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { lead_id?: string; customer_id?: string; price?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { lead_id, customer_id } = body;
  if (!lead_id || !customer_id) {
    return NextResponse.json(
      { error: "lead_id and customer_id are required" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: assignmentId, error: assignError } = await admin.rpc(
    "assign_lead_to_customer",
    {
      p_lead_id: lead_id,
      p_customer_id: customer_id,
      p_price: body.price ?? LEAD_PRICE,
    }
  );

  if (assignError || !assignmentId) {
    return NextResponse.json(
      { error: assignError?.message ?? "Assignment failed" },
      { status: 400 }
    );
  }

  // Notify the customer just like the automated path.
  const { data: lead } = await admin
    .from("leads")
    .select("*")
    .eq("id", lead_id)
    .single();
  const { data: customer } = await admin
    .from("customers")
    .select("*")
    .eq("id", customer_id)
    .single();

  const typedLead = lead as Lead | null;
  const typedCustomer = customer as Customer | null;

  if (typedLead && typedCustomer) {
    const city = extractCity(typedLead.address);
    const { data: notification } = await admin
      .from("notifications")
      .insert({
        customer_id,
        lead_assignment_id: assignmentId,
        notification_type: "new_lead",
        message: `New lead: ${typedLead.lead_name}${city ? ` in ${city}` : ""}`,
      })
      .select("id")
      .single();

    const { error: emailError } = await sendNewLeadEmail({
      to: typedCustomer.email,
      lead: typedLead,
    });

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

  return NextResponse.json({ status: "ok", assignment_id: assignmentId });
}
