import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { completeAssignment } from "@/lib/ingest";
import type { Lead } from "@/lib/types";

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

  let body: {
    lead_id?: string;
    customer_id?: string;
    customer_ids?: string[];
    price?: number;
    override?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { lead_id } = body;
  // Accept a single customer_id (back-compat) or a customer_ids[] array so the
  // admin can force-assign both recipients in one action.
  const customerIds = (
    body.customer_ids && body.customer_ids.length > 0
      ? body.customer_ids
      : body.customer_id
        ? [body.customer_id]
        : []
  ).filter((id, i, arr) => id && arr.indexOf(id) === i);

  if (!lead_id || customerIds.length === 0) {
    return NextResponse.json(
      { error: "lead_id and at least one customer_id are required" },
      { status: 400 }
    );
  }

  // override bypasses the paid-credit / subscription gate via admin_assign_lead
  // (which still honours capacity and the paused-customer block). Automatic
  // ingest never sets this, so paid leads are never given away by accident.
  const override = body.override === true;

  const admin = createAdminClient();

  // Resolve the lead first so we assign against the correct product pool.
  const { data: lead } = await admin
    .from("leads")
    .select("*")
    .eq("id", lead_id)
    .single();

  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const typedLead = lead as Lead;
  const defaultPrice = typedLead.lead_type === "guaranteed_rent" ? 10.0 : LEAD_PRICE;
  const price = body.price ?? defaultPrice;

  const assigned: string[] = [];
  const failures: { customer_id: string; error: string }[] = [];

  for (const customerId of customerIds) {
    const { data: assignmentId, error: assignError } = await admin.rpc(
      override ? "admin_assign_lead" : "assign_lead_to_customer",
      {
        p_lead_id: lead_id,
        p_customer_id: customerId,
        p_price: price,
        p_lead_type: typedLead.lead_type,
      }
    );

    if (assignError || !assignmentId) {
      failures.push({
        customer_id: customerId,
        error: assignError?.message ?? "Assignment failed",
      });
      continue;
    }

    // Same follow-through as the automated path: notification + new-lead email.
    // Skip the credit-threshold warnings on an override (no credit spent).
    await completeAssignment(
      admin,
      typedLead,
      customerId,
      assignmentId,
      !override
    );
    assigned.push(customerId);
  }

  if (assigned.length === 0) {
    return NextResponse.json(
      { error: failures[0]?.error ?? "Assignment failed", failures },
      { status: 400 }
    );
  }

  return NextResponse.json({
    status: "ok",
    assigned_count: assigned.length,
    assigned,
    failures,
  });
}
