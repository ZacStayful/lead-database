import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { toLeadInterest, LEAD_INTEREST } from "@/lib/monday";
import { toPlanKey } from "@/lib/plans";
import { recordEnquiry } from "@/lib/enquiry/recordEnquiry";
import { ukMobileE164, UK_MOBILE_ERRORS } from "@/lib/leadQuality";
import { APP_URL } from "@/lib/env";
import { clientIp } from "@/lib/api/log";
import { metaTrackingAllowed } from "@/lib/meta/consent";
import { buildMetaUserData } from "@/lib/meta/userData";
import { buildLeadEvent, coerceEventId } from "@/lib/meta/events";
import { logMetaResult, sendMetaConversion } from "@/lib/meta/capi";

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
    event_id?: string;
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

  // Everything from here — the Monday item, the waitlisted customer row and
  // the booking-chase ladder — lives in `recordEnquiry`, shared verbatim with
  // the Monday enquiry sync (§57). Facebook lead ads drop an item on the same
  // board, in the same group, with the same column ids; both doors have to end
  // in exactly the same state or a prospect is recorded but never chased, or
  // chased twice.
  //
  // ⚠️ THIS ROUTE KEEPS THE MOBILE REFUSAL ABOVE AND THE SYNC HAS NONE. A
  // person on this page can be told to correct their number; nobody is
  // watching an ad lead at 3am, so the sync stores what arrived and lets the
  // email half of the chase carry it. Do not reconcile the two.
  const result = await recordEnquiry(admin, {
    source: "website",
    name,
    email,
    phone: mobile,
    websiteUrl,
    propertiesManaged,
    leadInterest,
    planKey,
    // The website mints the board item; the sync adopts one that already
    // exists. A discriminated union rather than an optional id, so neither
    // caller can ask for the wrong one.
    monday: { kind: "create", currentLeadSource },
  });
  if (result.errors.length > 0) {
    console.error("Enquiry recorded with errors", result.errors);
  }

  // Meta Lead conversion, server-side (§60).
  //
  // THE RELIABLE HALF of the conversion, not a backup. Two things make the
  // browser pixel alone insufficient here: roughly a third of visitors block
  // fbevents.js outright, and the form's success path is a hard navigation
  // off-site to Calendly, which races the beacon.
  //
  // `_fbp` / `_fbc` are first-party cookies written by the pixel on the
  // landing page (and `_fbc` is minted from `?fbclid=` by our own bundle even
  // when the pixel is blocked — see MetaPixel.tsx). They arrive on this
  // request because the form's fetch is same-origin, which is why the COOKIE
  // is the right carrier and the URL is not: the visitor lands on
  // `/?fbclid=…` and navigates to `/enquiry`, where the param is long gone.
  //
  // ⚠️ AWAITED, not fire-and-forget. Vercel can freeze the function the
  // instant the response is returned, and an un-awaited promise is simply
  // lost. Worst case is the 4s timeout inside sendMetaConversion.
  //
  // ⚠️ AFTER recordEnquiry, and in THIS route rather than inside it: the
  // Monday enquiry sync (§57) calls the same helper for a Facebook lead-form
  // enquiry, which never touched this site and has no browser event to
  // deduplicate against. It can never fail the request — a measurement
  // outage must not cost us a real lead.
  if (metaTrackingAllowed()) {
    const event = buildLeadEvent({
      eventId: coerceEventId(body.event_id),
      sourceUrl: `${APP_URL}/enquiry`,
      contentName:
        leadInterest === LEAD_INTEREST.management ? planKey : leadInterest,
      userData: buildMetaUserData({
        email,
        phone: mobile,
        fullName: name,
        fbp: request.cookies.get("_fbp")?.value ?? null,
        fbc: request.cookies.get("_fbc")?.value ?? null,
        ipAddress: clientIp(request),
        userAgent: request.headers.get("user-agent"),
      }),
    });
    logMetaResult("enquiry", event, await sendMetaConversion(event));
  }

  // Capacity no longer gates the public form — every prospect books a call.
  //    The field is kept `true` for a stable response shape.
  return NextResponse.json({ ok: true, hasCapacity: true });
}
