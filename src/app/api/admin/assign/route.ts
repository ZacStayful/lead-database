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

  const { data: assignmentId, error: assignError } = await admin.rpc(
    "assign_lead_to_customer",
    {
      p_lead_id: lead_id,
      p_customer_id: customer_id,
      p_price: body.price ?? defaultPrice,
      p_lead_type: typedLead.lead_type,
    }
  );

  if (assignError || !assignmentId) {
    return NextResponse.json(
      { error: assignError?.message ?? "Assignment failed" },
      { status: 400 }
    );
  }

  // Same follow-through as the automated path: notification, email, and
  // threshold warnings (management only).
  await completeAssignment(admin, typedLead, customer_id, assignmentId);

  return NextResponse.json({ status: "ok", assignment_id: assignmentId });
}
