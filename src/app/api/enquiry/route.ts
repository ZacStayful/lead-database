import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createEnquiryContact } from "@/lib/monday";
import { PLANS, toPlanKey } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Landing-page enquiry form.
 *
 * Every submission (a) is pushed to the Monday enquiries board and (b) creates
 * an INACTIVE ("waitlisted") account in the lead database. The account stays
 * inactive until an admin activates (invites) it from the admin panel.
 *
 * The response tells the client whether we currently have capacity for another
 * customer — the form shows the Calendly booking link when we do, or an
 * "at capacity" message when we don't. Either way the account is created; the
 * capacity flag only changes the message shown to the prospect.
 */
export async function POST(request: NextRequest) {
  let body: {
    name?: string;
    mobile?: string;
    email?: string;
    website_url?: string;
    properties_managed?: string;
    plan?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  const mobile = body.mobile?.trim() ?? "";
  // Accept scheme-less input (e.g. "stayful.co.uk", "www.stayful.co.uk") and
  // normalise to a proper URL so the stored/Monday value is a working link.
  let websiteUrl = body.website_url?.trim() ?? "";
  if (websiteUrl && !/^https?:\/\//i.test(websiteUrl)) {
    websiteUrl = `https://${websiteUrl}`;
  }
  const propertiesManaged = body.properties_managed?.trim() ?? "";

  if (!name || !email) {
    return NextResponse.json(
      { error: "Name and email are required" },
      { status: 400 }
    );
  }

  const planKey = toPlanKey(body.plan);
  const plan = PLANS[planKey];
  const monthlyAllocation = plan.leads;
  const preferredPlan = `£${plan.priceGbp}/mo — ${plan.leads} leads`;

  // Fail fast with a clear message if the server isn't configured.
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `Server is not configured. Missing environment variable${
          missing.length === 1 ? "" : "s"
        }: ${missing.join(", ")}.`,
      },
      { status: 500 }
    );
  }

  const admin = createAdminClient();

  // 1. Push to Monday. Non-fatal — we still create the account if this fails.
  try {
    await createEnquiryContact({
      name,
      email,
      mobile,
      websiteUrl,
      propertiesManaged,
      preferredPlan,
    });
  } catch (err) {
    console.error("Monday enquiry push failed", err);
  }

  // 2. Create (or update) the inactive account.
  try {
    // Has this email already enquired / signed up? email is UNIQUE, so update
    // the existing prospect rather than erroring on a duplicate submission.
    const { data: existing } = await admin
      .from("customers")
      .select("id, account_status")
      .eq("email", email)
      .maybeSingle();

    if (existing) {
      // Only refresh prospect data while still waitlisted; never touch an
      // already-invited/active/cancelled account from a public form.
      if (existing.account_status === "waitlisted") {
        await admin
          .from("customers")
          .update({
            contact_name: name,
            business_name: name,
            phone: mobile || null,
            monthly_allocation: monthlyAllocation,
            website_url: websiteUrl || null,
            properties_managed: propertiesManaged || null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      }
    } else {
      // New prospect: create the waitlisted customer row only (user_id stays
      // null). The Supabase auth user is created later, at admin invite time —
      // so a public form never provisions a confirmed login for an arbitrary
      // email, and there's no auth-user/customer-row split to get out of sync.
      const { error: customerError } = await admin.from("customers").insert({
        business_name: name,
        contact_name: name,
        email,
        phone: mobile || null,
        monthly_allocation: monthlyAllocation,
        subscription_status: "inactive",
        account_status: "waitlisted",
        website_url: websiteUrl || null,
        properties_managed: propertiesManaged || null,
      });
      if (customerError) {
        console.error("Enquiry customer insert failed", customerError);
      }
    }
  } catch (err) {
    console.error("Enquiry account creation error", err);
  }

  // 3. Capacity check — decides which message the form shows.
  const { data: setting } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "max_active_customers")
    .single();
  const maxActive = parseInt(setting?.value ?? "10", 10);
  const { count: activeCount } = await admin
    .from("customers")
    .select("*", { count: "exact", head: true })
    .eq("account_status", "active");

  const hasCapacity = (activeCount ?? 0) < maxActive;

  return NextResponse.json({ ok: true, hasCapacity });
}
