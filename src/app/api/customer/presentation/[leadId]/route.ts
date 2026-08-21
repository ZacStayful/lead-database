import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildPresentationSeed, type SeedLead } from "@/lib/presentationSeed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/customer/presentation/[leadId]
 *
 * The income presentation, filled in for this lead and this operator (0093).
 * Fetched by public/income-presentation/index.html when it is opened with
 * ?lead=<id>.
 *
 * ASSIGNMENT ONLY — deliberately NOT pool-visible, unlike the analysis PDF
 * itself (§25). A presentation is the tool for winning the landlord's business,
 * and winning the landlord's business is exactly what claiming a pooled lead
 * buys. Reading the analysis before you claim is the bargain widened; being
 * handed the pitch is the bargain gone.
 *
 * Management only. A Guaranteed Rent operator earns the margin between the rent
 * they pay and what the property makes, so a management fee is not their
 * revenue and this presentation is not their pitch (invariant 6).
 *
 * The response carries the profile's state beside the data so the static file
 * holds no knowledge of app routing, and so it can prompt an operator who has
 * never set their terms up before they present Stayful's generic wording as
 * their own.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { leadId: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const leadId = params.leadId;
  if (!leadId) {
    return NextResponse.json({ error: "Lead id required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select(
      "id, business_name, presentation_settings, presentation_settings_updated_at"
    )
    .eq("user_id", user.id)
    .maybeSingle();
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const c = customer as {
    id: string;
    business_name: string | null;
    presentation_settings: unknown;
    presentation_settings_updated_at: string | null;
  };

  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id")
    .eq("lead_id", leadId)
    .eq("customer_id", c.id)
    .maybeSingle();
  if (!assignment) {
    // One 404 for "not yours" and "no such lead", so the endpoint cannot be
    // used to find out which leads exist.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: lead } = await admin
    .from("leads")
    .select(
      "lead_type, address, lead_name, phone, gross_annual_income, avg_nightly_rate, " +
        "occupancy_rate, long_let_annual_income, platform_fee_pct, cleaning_fee_pct, " +
        "monthly_revenue_profile"
    )
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const row = lead as unknown as SeedLead & { lead_type: string };
  if (row.lead_type !== "management") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    data: buildPresentationSeed(row, {
      business_name: c.business_name,
      presentation_settings: c.presentation_settings,
    }),
    profile: {
      configured: c.presentation_settings_updated_at != null,
      updatedAt: c.presentation_settings_updated_at,
      url: "/dashboard/settings#presentation",
    },
  });
}
