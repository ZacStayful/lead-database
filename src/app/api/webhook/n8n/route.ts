import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendNewLeadEmail,
  sendLowCreditsEmail,
  sendCreditsExhaustedEmail,
} from "@/lib/emails";
import { chargeOverflowLead } from "@/lib/billing";
import { extractCity } from "@/lib/utils";
import type { Customer, Lead, N8nLeadPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEAD_PRICE = 15.0;
const LOW_CREDITS_THRESHOLD = 18;

const REQUIRED_FIELDS: (keyof N8nLeadPayload)[] = [
  "monday_item_id",
  "lead_name",
  "address",
  "phone",
  "email",
  "lead_profile",
  "bedrooms",
  "enquiry_date",
  "estimated_monthly_income",
];

export async function POST(request: NextRequest) {
  // 1. Validate the Authorization header.
  const auth = request.headers.get("authorization");
  const expected = `Bearer ${process.env.N8N_WEBHOOK_SECRET}`;
  if (!process.env.N8N_WEBHOOK_SECRET || auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse the JSON body.
  let body: N8nLeadPayload;
  try {
    body = (await request.json()) as N8nLeadPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.monday_item_id || !body.lead_name) {
    return NextResponse.json(
      { error: "Missing required fields: monday_item_id, lead_name" },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();

  // 3. Idempotency: bail out if we've already ingested this Monday item.
  const { data: existing } = await supabase
    .from("leads")
    .select("id")
    .eq("monday_item_id", String(body.monday_item_id))
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      { status: "duplicate", lead_id: existing.id, assignments_made: 0 },
      { status: 200 }
    );
  }

  // 4. Insert the new lead.
  const insertPayload: Record<string, string> = {};
  for (const field of REQUIRED_FIELDS) {
    insertPayload[field] = body[field] != null ? String(body[field]) : "";
  }

  const { data: lead, error: insertError } = await supabase
    .from("leads")
    .insert(insertPayload)
    .select("*")
    .single();

  if (insertError || !lead) {
    // Unique-violation race: another request inserted the same item first.
    if (insertError?.code === "23505") {
      return NextResponse.json(
        { status: "duplicate", assignments_made: 0 },
        { status: 200 }
      );
    }
    console.error("Lead insert failed", insertError);
    return NextResponse.json(
      { error: "Failed to insert lead" },
      { status: 500 }
    );
  }

  const typedLead = lead as Lead;

  // 5. Find the next eligible customers (max 2).
  const { data: candidates, error: candidateError } = await supabase.rpc(
    "get_next_customers_for_lead",
    { p_lead_id: typedLead.id, p_max: typedLead.max_assignments ?? 2 }
  );

  if (candidateError) {
    console.error("get_next_customers_for_lead failed", candidateError);
    return NextResponse.json(
      { error: "Assignment lookup failed", lead_id: typedLead.id },
      { status: 500 }
    );
  }

  const customerIds: string[] = (candidates ?? []).map(
    (c: { customer_id: string }) => c.customer_id
  );

  // 6 & 7. Assign atomically, then notify.
  let assignmentsMade = 0;
  const results: { customer_id: string; ok: boolean; error?: string }[] = [];

  for (const customerId of customerIds) {
    const { data: assignmentId, error: assignError } = await supabase.rpc(
      "assign_lead_to_customer",
      {
        p_lead_id: typedLead.id,
        p_customer_id: customerId,
        p_price: LEAD_PRICE,
      }
    );

    if (assignError || !assignmentId) {
      results.push({
        customer_id: customerId,
        ok: false,
        error: assignError?.message,
      });
      continue;
    }

    assignmentsMade += 1;
    results.push({ customer_id: customerId, ok: true });

    // Load the customer to send the notification + email + threshold warnings.
    const { data: customer } = await supabase
      .from("customers")
      .select("*")
      .eq("id", customerId)
      .single();

    const typedCustomer = customer as Customer | null;
    if (!typedCustomer) continue;

    // In-portal notification row (feeds the real-time subscription).
    const city = extractCity(typedLead.address);
    const message = `New lead: ${typedLead.lead_name}${city ? ` in ${city}` : ""}`;
    const { data: notification } = await supabase
      .from("notifications")
      .insert({
        customer_id: customerId,
        lead_assignment_id: assignmentId,
        notification_type: "new_lead",
        message,
      })
      .select("id")
      .single();

    // Resend email for the new lead.
    const { error: emailError } = await sendNewLeadEmail({
      to: typedCustomer.email,
      lead: typedLead,
    });

    // Flag the assignment + notification as delivered.
    await supabase
      .from("lead_assignments")
      .update({ notification_sent: true, email_sent: !emailError })
      .eq("id", assignmentId);

    if (notification) {
      await supabase
        .from("notifications")
        .update({ email_sent: !emailError })
        .eq("id", notification.id);
    }

    // Threshold emails based on the post-increment count (RPC already incremented).
    const newCount = typedCustomer.leads_received_this_month;
    if (newCount === typedCustomer.monthly_allocation) {
      await sendCreditsExhaustedEmail({ to: typedCustomer.email });
    } else if (newCount === LOW_CREDITS_THRESHOLD) {
      await sendLowCreditsEmail({
        to: typedCustomer.email,
        remaining: typedCustomer.monthly_allocation - newCount,
      });
    }

    // Overflow billing: if this assignment pushed the customer beyond their
    // included allocation (only possible with overflow enabled), bill £20.
    if (newCount > typedCustomer.monthly_allocation) {
      await chargeOverflowLead(typedCustomer);
    }
  }

  // 8. Return a summary.
  return NextResponse.json(
    {
      status: "ok",
      lead_id: typedLead.id,
      assignments_made: assignmentsMade,
      results,
    },
    { status: 200 }
  );
}
