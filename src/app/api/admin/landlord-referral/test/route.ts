/**
 * Send yourself one landlord referral, to rehearse it (§41).
 *
 * The §21.4 announcement-test shape: to the signed-in admin by default,
 * `[TEST]` in the subject, and a failed send is a 502.
 *
 * ⚠️ IT WRITES NOTHING. No claim_landlord_referral, no stamps, no columns
 * touched on the lead or the assignment. A referral is claimed by write BEFORE
 * it is sent, and the claim decides who carries the three questions — so a
 * rehearsal that claimed would burn a real lead's one-and-only introduction
 * slot on an email that went to us. That is the single most important property
 * of this route, and it is asserted in the verification.
 *
 * ⚠️ IT WORKS WHILE THE SWITCH IS OFF. That is the entire point of a rehearsal:
 * you press this to decide whether to turn the thing on. It is the §40.3
 * argument in a different shape — preview has to mean live for this viewer, or
 * the switch can never be tested before it is thrown.
 *
 * It builds from a REAL management lead with real figures and mints a REAL
 * token, so the whole deck is walkable from the email. Nothing else proves the
 * data path actually produces a sensible email for your own leads.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getUser, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { sendLandlordReferralEmail } from "@/lib/emails";
import {
  buildReferralCopy,
  renderReferralBody,
  shouldReferLandlord,
  type ReferralLead,
  type ReferralOperator,
} from "@/lib/landlordReferral";
import { mintReferralToken } from "@/lib/landlordReferralToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const LEAD_COLUMNS =
  "id, lead_name, email, address, bedrooms, lead_type, owner_customer_id, " +
  "lead_quality_codes, gross_annual_income";

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // An unparseable or empty body means "send it to me".
  let body: { to?: unknown; lead_id?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const to = (typeof body.to === "string" && body.to.trim()) || user?.email || "";
  if (!to || !EMAIL_RE.test(to)) {
    return NextResponse.json(
      { error: "Give an email address to send the test to." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // A real management lead with real figures, so the email and the deck are
  // built from the same data a landlord would actually get. Newest first, and
  // a specific lead may be named.
  // Two separate reads rather than a reassigned builder: reassigning a
  // PostgREST query builder makes its inferred type recurse (TS2589).
  const namedId = typeof body.lead_id === "string" && body.lead_id ? body.lead_id : null;
  const { data: leadRows, error: leadError } = namedId
    ? await admin.from("leads").select(LEAD_COLUMNS).eq("id", namedId).limit(1)
    : await admin
        .from("leads")
        .select(LEAD_COLUMNS)
        .eq("lead_type", "management")
        .is("owner_customer_id", null)
        .not("gross_annual_income", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);
  if (leadError) {
    return NextResponse.json({ error: "Could not read a lead to test with." }, { status: 500 });
  }
  const lead = (leadRows ?? [])[0] as unknown as ReferralLead | undefined;
  if (!lead) {
    return NextResponse.json(
      { error: "No management lead with an income figure to build a test from." },
      { status: 404 }
    );
  }

  // Report the same refusal a real send would make, rather than sending
  // something the live path never would.
  const decision = shouldReferLandlord(lead);
  if (!decision.refer) {
    return NextResponse.json(
      { error: `That lead would not be referred: ${decision.reason}` },
      { status: 400 }
    );
  }

  const { data: customer } = await admin
    .from("customers")
    .select("business_name, contact_name, email, phone, operator_intro")
    .eq("email", user?.email ?? "")
    .maybeSingle();

  // Falls back to a plainly-labelled stand-in when the admin has no customer
  // row of their own, so the rehearsal still runs.
  const operator: ReferralOperator = (customer as ReferralOperator | null) ?? {
    business_name: "Example Lettings (test)",
    contact_name: "Test Operator",
    email: to,
    phone: "07700900000",
    operator_intro: null,
  };

  // askQuestions: true so the deck link is present — the half that most needs
  // rehearsing. The token is real; nothing is stamped to make it so.
  const copy = buildReferralCopy({ lead, operator, askQuestions: true });
  const token = mintReferralToken(lead.id);
  const prefsUrl = token ? `${APP_URL}/p/${token}` : null;

  const { error: sendError } = await sendLandlordReferralEmail({
    to,
    subject: `[TEST] ${copy.subject}`,
    bodyHtml: renderReferralBody(copy),
    cta:
      copy.cta && prefsUrl
        ? { url: prefsUrl, label: copy.cta.label, note: copy.cta.note }
        : null,
  });

  if (sendError) {
    console.error("[landlord-referral/test] send failed", sendError);
    return NextResponse.json({ error: "Could not send the test email." }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    to,
    lead_id: lead.id,
    deck_link: Boolean(prefsUrl),
  });
}
