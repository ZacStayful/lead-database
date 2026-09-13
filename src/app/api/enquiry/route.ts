import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createEnquiryContact, enquiryBoardId, toLeadInterest, LEAD_INTEREST } from "@/lib/monday";
import { PLANS, toPlanKey } from "@/lib/plans";
import { ukMobileE164, UK_MOBILE_ERRORS } from "@/lib/leadQuality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Landing-page enquiry form.
 *
 * Every submission (a) is pushed to the Monday enquiries board and (b) creates
 * an INACTIVE ("waitlisted") account in the lead database. The account stays
 * inactive until an admin activates (invites) it from the admin panel.
 *
 * The response always reports `hasCapacity: true` — capacity no longer gates the
 * public form. Every prospect is shown the Calendly booking link; committed lead
 * volume is managed on the admin side (weighted slots) and at invite time, not
 * by turning enquirers away here.
 */
export async function POST(request: NextRequest) {
  let body: {
    name?: string;
    mobile?: string;
    email?: string;
    website_url?: string;
    properties_managed?: string;
    current_lead_source?: string;
    plan?: string;
    lead_interest?: string;
    product?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Which service they came for. The form now ASKS — it is a required picker,
  // and `lead_interest` is what it posts.
  //
  // `product` is the legacy fallback and is kept deliberately: it is the hidden
  // ?product=guaranteed-rent that the GR landing page has always put in the URL,
  // and it is all a cached copy of the old form, or anything else posting the
  // previous shape, will send. It could only ever say "guaranteed rent" or
  // nothing, which is the whole reason this changed: an enquirer reaching the
  // form directly was silently filed as Management with nobody able to correct
  // it, and "both" could not be expressed at all.
  //
  // Management remains the default of last resort — the same reading the route
  // has always taken of a body with no product on it.
  const leadInterest =
    toLeadInterest(body.lead_interest) ??
    toLeadInterest(body.product) ??
    LEAD_INTEREST.management;

  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  // Accept scheme-less input (e.g. "stayful.co.uk", "www.stayful.co.uk") and
  // normalise to a proper URL so the stored/Monday value is a working link.
  let websiteUrl = body.website_url?.trim() ?? "";
  if (websiteUrl && !/^https?:\/\//i.test(websiteUrl)) {
    websiteUrl = `https://${websiteUrl}`;
  }
  const propertiesManaged = body.properties_managed?.trim() ?? "";
  const currentLeadSource = body.current_lead_source?.trim() ?? "";

  if (!name || !email) {
    return NextResponse.json(
      { error: "Name and email are required" },
      { status: 400 }
    );
  }

  // The mobile is stored in E.164 and in no other shape, so it is resolved here
  // and every write below reads the one variable.
  //
  // ⚠️ THIS REFUSES, where the rest of the route is forgiving. `/api/enquiry`
  // has always taken the number exactly as typed, and §16's instinct is never to
  // turn a prospect away — so this is a deliberate exception, not an oversight.
  // The trade accepted: a landline or an overseas number cannot enquire through
  // the form, and support is the route for those. If that ever costs a real
  // enquiry, the fallback is to keep the raw string here instead of returning.
  //
  // It sits BEFORE the Monday push on purpose. A refusal must leave no board
  // item and no customer row, or a rejected enquiry still creates the duplicate
  // that a retry then can never tidy up.
  const mobileResult = ukMobileE164(body.mobile);
  if (!mobileResult.ok) {
    return NextResponse.json(
      { error: UK_MOBILE_ERRORS[mobileResult.reason] },
      { status: 400 }
    );
  }
  const mobile = mobileResult.value;

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
  //
  //    ONE BOARD, whichever service they asked for, with the "What kind of leads"
  //    cell saying which (§47). Guaranteed Rent enquiries used to go to their own
  //    board (18420913271), and that was a dead end: it has no Status column, so
  //    setEnquiryStatus refused it outright, the item could never carry a label or
  //    sit in a pipeline group, and §23.7 records that the one real GR customer had
  //    to be re-created on this board by hand. Sending every enquiry here is also
  //    what makes resolveItem's stored-link short-circuit work for them.
  //
  //    The creator returns the new item id, and it is KEPT (0086) rather than
  //    discarded: it is the customer -> Monday item link the subscription-status
  //    sync needs. Capturing it here is what stops every future customer having to
  //    be matched by email, phone or name later, which is guesswork by comparison.
  let mondayItemId: string | null = null;
  let mondayBoardId: string | null = null;
  try {
    mondayItemId = await createEnquiryContact({
      name,
      email,
      mobile,
      websiteUrl,
      propertiesManaged,
      leadInterest,
      preferredPlan,
      currentLeadSource,
    });
    mondayBoardId = enquiryBoardId();
  } catch (err) {
    console.error("Monday enquiry push failed", err);
  }

  // Only set when we actually got an id — a failed Monday push must not blank an
  // existing link.
  const mondayLink =
    mondayItemId && mondayBoardId
      ? {
          monday_item_id: mondayItemId,
          monday_board_id: mondayBoardId,
          monday_link_state: "linked",
          monday_link_matched_by: "created",
        }
      : {};

  // 2. Create (or update) the inactive account.
  try {
    // Has this email already enquired / signed up? email is UNIQUE, so update
    // the existing prospect rather than erroring on a duplicate submission.
    const { data: existing } = await admin
      .from("customers")
      .select("id, account_status, monday_item_id")
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
            phone: mobile,
            monthly_allocation: monthlyAllocation,
            website_url: websiteUrl || null,
            properties_managed: propertiesManaged || null,
            // Only on this branch, never on an invited/active/cancelled account —
            // the same rule the rest of this block follows about not letting a
            // public form touch a live account.
            //
            // And only when the row has no link yet. This route creates a NEW board
            // item on every submission, so a prospect who enquires twice produces a
            // duplicate; repointing the link at the newer one would send status
            // writes to the duplicate while sales works the original. First item
            // wins, matching how the rest of the system treats first-touch data.
            ...(existing.monday_item_id ? {} : mondayLink),
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
        phone: mobile,
        monthly_allocation: monthlyAllocation,
        subscription_status: "inactive",
        account_status: "waitlisted",
        website_url: websiteUrl || null,
        properties_managed: propertiesManaged || null,
        ...mondayLink,
      });
      if (customerError) {
        console.error("Enquiry customer insert failed", customerError);
      }
    }
  } catch (err) {
    console.error("Enquiry account creation error", err);
  }

  // 3. Start the booking chase (§55).
  //
  //    They are about to be redirected to Calendly, and most of them will not
  //    book. This row is the ladder that chases them: WhatsApp and email about
  //    two minutes from now, another at 24 hours, a third at 48, stopping the
  //    moment Calendly says they booked.
  //
  //    ⚠️ THIS INSERT IS WHAT MAKES "NEW ENQUIRIES ONLY" STRUCTURAL. There is
  //    no backfill and no cutoff setting anywhere: a prospect with no ladder
  //    row can never be chased, and this is the only thing in the codebase that
  //    creates one. §32.4's argument for a per-row flag over a global — a
  //    cutoff is one bad read away from enrolling the whole back catalogue.
  //
  //    ⚠️ NON-FATAL, exactly like the Monday push above. A failed ladder must
  //    never cost us the enquiry itself, which is the thing we actually cannot
  //    recreate. The unique partial index does the rest: a prospect who
  //    enquires twice while still waitlisted collides on 23505 and keeps the
  //    ladder they already have, rather than being chased twice over.
  try {
    const { data: prospect } = await admin
      .from("customers")
      .select("id, account_status")
      .eq("email", email)
      .maybeSingle();

    if (prospect && prospect.account_status === "waitlisted") {
      const { error: ladderError } = await admin
        .from("prospect_booking_nudges")
        .insert({ customer_id: prospect.id });
      // 23505 is the ordinary case — they already have a live ladder.
      if (ladderError && ladderError.code !== "23505") {
        console.error("Enquiry booking-chase insert failed", ladderError);
      }
    }
  } catch (err) {
    console.error("Enquiry booking-chase error", err);
  }

  // 4. Capacity no longer gates the public form — every prospect books a call.
  //    The field is kept `true` for a stable response shape.
  return NextResponse.json({ ok: true, hasCapacity: true });
}
