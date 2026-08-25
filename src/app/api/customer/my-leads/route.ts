import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { holdsProduct } from "@/lib/products";
import {
  createOwnedLeads,
  hasAnyContactDetail,
  type OwnedLeadInput,
} from "@/lib/customerLeads";
import type { Customer, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add one lead by hand.
 *
 * NO FIELD IS REQUIRED. The brief was an enquiry form with nothing mandatory,
 * because an operator taking a call has whatever the landlord has given them so
 * far — sometimes only a mobile number — and being made to invent a name to get
 * past validation is how bad data gets into a database.
 *
 * The one exception is a row with nothing to identify or reach anybody at all,
 * which is refused with a message rather than stored: `create_customer_leads`
 * would classify it `empty` and silently create nothing, and a form that
 * appears to succeed while saving nothing is worse than a clear refusal.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: OwnedLeadInput & { lead_type?: string; run_analysis?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const leadType: LeadType =
    body.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ error: "No customer record" }, { status: 404 });
  }

  // Their own leads are free and unlimited, but they still have to be a
  // customer of the product whose pipeline the lead will use — a GR lead gets
  // GR's stages and a management lead gets management's (invariant 6).
  if (!holdsProduct(customer as Customer, leadType)) {
    return NextResponse.json(
      { error: "You do not hold that product" },
      { status: 403 }
    );
  }

  if (!hasAnyContactDetail(body)) {
    return NextResponse.json(
      {
        error:
          "Add at least one of a name, email, phone number or address so the lead is worth something to you.",
      },
      { status: 400 }
    );
  }

  const { result, error } = await createOwnedLeads(admin, {
    customerId: (customer as Customer).id,
    leadType,
    source: "manual",
    rows: [body],
  });

  if (error || !result) {
    return NextResponse.json(
      { error: error ?? "Could not add the lead" },
      { status: 400 }
    );
  }

  if (result.duplicates > 0) {
    return NextResponse.json(
      { error: "You have already added this lead.", code: "duplicate" },
      { status: 409 }
    );
  }

  const leadId = result.leadIds[0] ?? null;

  // ── The upsell, strictly after the lead exists ────────────────────
  //
  // The lead is created free and is already theirs by the time anything is
  // charged, so a declined card costs them nothing but the figures. The
  // analysis result is REPORTED, never thrown: "lead added, payment didn't go
  // through" is a true and useful sentence, where failing the whole request
  // would lose them a lead they had just typed out.
  let analysis: { status: string; message?: string; url?: string } | null = null;
  if (leadId && body.run_analysis === true) {
    analysis = await startAnalysis(request, leadId, leadType);
  }

  return NextResponse.json({ ok: true, lead_id: leadId, analysis });
}

/**
 * Buy analysis for the lead just created, by calling the one purchase route.
 *
 * Deliberately an internal HTTP call rather than a second copy of that route's
 * logic: it re-derives eligibility and the price from the leads themselves,
 * claims a token, charges and starts the job, and none of that should exist
 * twice. The session cookie is forwarded so it authenticates as the same
 * customer.
 *
 * Never throws. The lead is already added.
 */
async function startAnalysis(
  request: NextRequest,
  leadId: string,
  leadType: LeadType
): Promise<{ status: string; message?: string; url?: string }> {
  try {
    const res = await fetch(`${request.nextUrl.origin}/api/customer/lead-analysis`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: request.headers.get("cookie") ?? "",
      },
      body: JSON.stringify({ lead_ids: [leadId], lead_type: leadType, source: "manual" }),
      cache: "no-store",
    });
    const body = await res.json();
    return { status: body.status ?? "failed", message: body.message, url: body.url };
  } catch (err) {
    console.error("my-leads: analysis purchase failed", err);
    return {
      status: "failed",
      message: "The lead was added, but we couldn't start the figures. You can run them from the lead itself.",
    };
  }
}
