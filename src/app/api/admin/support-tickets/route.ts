import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import { validateTicketWrite } from "@/lib/supportTickets";
import { planSnapshot, type TicketPlanFields } from "@/lib/supportTicketLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Log a ticket by hand (CLAUDE.md §46).
 *
 * The two in-app forms cover everything submitted through the product. This
 * covers everything else — a question asked by email, on WhatsApp, or on a
 * call — so the log is a record of what customers asked rather than of what
 * they happened to ask through a form. Emily Kitts's follow-up about lead
 * vetting arrived as a plain reply to an existing thread and would otherwise
 * never appear.
 *
 * ⚠️ `visible_to_customer` IS NOT READABLE FROM THE BODY HERE. A hand-logged
 * ticket is the admin's words about a conversation, and there is no shape of
 * request that should bring one into existence already published to the
 * customer's dashboard — the same argument the announcements create route makes
 * for refusing `status`. Sharing one is a deliberate second act through PATCH.
 */
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = validateTicketWrite(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const admin = createAdminClient();

  // The plan snapshot is what they were paying WHEN THEY ASKED, so it is taken
  // from the customer named on the ticket rather than left null — a phone call
  // logged today about last week is still a call from a paying customer.
  let snapshot: string | null = null;
  let product = parsed.value.product;
  if (parsed.value.customer_id) {
    const { data } = await admin
      .from("customers")
      .select(
        "account_status, subscription_status, gr_subscription_status, " +
          "monthly_allocation, gr_monthly_allocation"
      )
      .eq("id", parsed.value.customer_id)
      .maybeSingle();
    if (!data) {
      return NextResponse.json({ error: "Customer not found" }, { status: 400 });
    }
    snapshot = planSnapshot(data as unknown as TicketPlanFields);
  } else {
    product = product ?? null;
  }

  const { data, error } = await admin
    .from("support_tickets")
    .insert({
      source: "admin",
      kind: parsed.value.kind,
      channel: parsed.value.channel,
      customer_id: parsed.value.customer_id,
      submitter_name: parsed.value.submitter_name,
      submitter_email: parsed.value.submitter_email,
      submitter_business: parsed.value.submitter_business,
      subject: parsed.value.subject,
      body: parsed.value.body,
      product,
      plan_snapshot: snapshot,
      visible_to_customer: false,
      ...(parsed.value.submitted_at
        ? { submitted_at: parsed.value.submitted_at }
        : {}),
    })
    .select("id, reference")
    .single();

  if (error || !data) {
    console.error("admin support ticket create failed", error);
    return NextResponse.json(
      { error: "Could not log that ticket." },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { ok: true, id: data.id, reference: data.reference },
    { status: 201 }
  );
}
