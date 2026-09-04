/**
 * How many of your leads this message can actually reach (§40.14).
 *
 * ⚠️ THIS IS THE MOST VALUABLE THING IN THE FEATURE, and it is the reason
 * skipping a lead with a missing field is an acceptable answer at all.
 *
 * Measured over the 449 live leads: first name fills on 444, address on 446 —
 * but the income, nightly rate and occupancy figures on 173, which is 39%. So
 * an operator who types {{income}} into a chase and saves it silently loses
 * three sends in five, and would find out weeks later if at all.
 *
 * Shown while the wording can still be changed, it is the number that changes
 * the decision — the same discipline as §28's filter forecast and §40.13's
 * "state how long the backlog will take".
 *
 * The sample renders against one of THEIR OWN leads, not an invented one: a
 * preview built from made-up data cannot be wrong about their book, which is
 * exactly what makes it useless.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { viewerScopedLead } from "@/lib/customerLeads";
import { resolveOperatorNames } from "@/lib/referralIdentity";
import {
  fieldCoverage,
  renderTemplate,
  validateTemplate,
  type MergeLead,
} from "@/lib/messaging/mergeFields";
import { assignmentSendable } from "@/lib/messaging/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enough to be honest about the ratio without reading a whole book on every
 * keystroke. The largest operator holds 38 workable leads, so this is the whole
 * population for everybody today and stays a fair sample if that changes.
 */
const SAMPLE_LIMIT = 400;

export async function POST(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { body_template?: unknown; lead_type?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const template = typeof body.body_template === "string" ? body.body_template : "";
  const leadType = body.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";

  const hasBookingLink = Boolean(customer.messaging_booking_link);
  const verdict = validateTemplate(template, { hasBookingLink, leadType });
  if (!verdict.ok) {
    // Reported rather than 400'd: this fires while somebody is typing, and the
    // builder shows the reason under the box.
    return NextResponse.json({ ok: false, error: verdict.error });
  }

  const admin = createAdminClient();

  // The same population enrolment would actually reach: this customer's own
  // assignments, of this product, that are still messageable.
  const { data } = await admin
    .from("lead_assignments")
    .select(
      "id, status, closed_at, closed_reason, " +
        "lead:leads!inner(id, lead_name, address, bedrooms, lead_type, owner_customer_id, " +
        "lead_profile, gross_annual_income, avg_nightly_rate, occupancy_rate)"
    )
    .eq("customer_id", customer.id)
    .eq("lead.lead_type", leadType)
    .order("assigned_at", { ascending: false })
    .limit(SAMPLE_LIMIT);

  const rows = ((data ?? []) as unknown as {
    id: string;
    status: string | null;
    closed_at: string | null;
    closed_reason: string | null;
    lead: Record<string, unknown> | null;
  }[]).filter((r) => r.lead && assignmentSendable(r));

  const operator = {
    // §41/0131 — same names the referral email uses, so the reach line previews
    // what would really send.
    ...resolveOperatorNames(customer),
    messaging_booking_link: customer.messaging_booking_link,
  };

  // Scoped, even for a count. On a resold imported lead `lead_profile` is the
  // uploading operator's private notes — no field reads it, but scoping at the
  // boundary rather than relying on the catalogue is the §32.8 rule.
  const leads = rows.map((r) => ({
    lead: viewerScopedLead(r.lead as never, customer.id) as unknown as MergeLead,
  }));

  const coverage = fieldCoverage(template, leads, operator);

  // The first lead the template actually works for, so the sample is a message
  // that would really go rather than one with gaps in it.
  let sample: string | null = null;
  for (const row of leads) {
    const rendered = renderTemplate(template, { lead: row.lead, customer: operator });
    if (rendered.ok) {
      sample = rendered.text;
      break;
    }
  }

  return NextResponse.json({
    ok: true,
    ...coverage,
    sample,
    fields: verdict.fields,
  });
}
