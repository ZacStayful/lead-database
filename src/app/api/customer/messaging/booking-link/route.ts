/**
 * The operator's own booking link (§40.14).
 *
 * ⚠️ THIS IS THE ONLY WAY A LINK CAN REACH A TEMPLATED MESSAGE.
 * `validateTemplate` refuses a typed URL, because a link in a cold WhatsApp is
 * the strongest single spam signal there is and the number at risk belongs to
 * the operator — so one link, stored once and checked once, is offered as
 * `{{booking_link}}` instead of forty different pasted ones.
 *
 * A route of its own rather than a widening of `/api/customer/settings`, which
 * is documented as being about the SMS opt-in and validates exactly one
 * boolean.
 *
 * ⚠️ HTTPS ONLY, and normalised through `new URL()`. §21.5 records the same
 * rule for an announcement's CTA: the constructor percent-encodes the quote
 * that would otherwise break out of an attribute, and rejecting anything that
 * is not `https:` keeps `javascript:` and `data:` out of a value that is sent
 * to a member of the public with the operator's name on it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Long enough for any real booking URL, short enough not to eat a message. */
const MAX_LINK_CHARS = 300;

export async function PATCH(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { booking_link?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw = typeof body.booking_link === "string" ? body.booking_link.trim() : "";

  let stored: string | null = null;
  if (raw) {
    if (raw.length > MAX_LINK_CHARS) {
      return NextResponse.json(
        { error: "That link is too long to put in a WhatsApp message." },
        { status: 400 }
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return NextResponse.json(
        { error: "That does not look like a link. It should start with https://" },
        { status: 400 }
      );
    }
    if (parsed.protocol !== "https:") {
      return NextResponse.json(
        { error: "The link must start with https://" },
        { status: 400 }
      );
    }
    stored = parsed.toString();
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("customers")
    .update({ messaging_booking_link: stored })
    .eq("id", customer.id);

  if (error) {
    console.error("[messaging/booking-link] save failed", error);
    return NextResponse.json({ error: "Could not save that link." }, { status: 500 });
  }

  // ⚠️ An empty string CLEARS it, and that has a consequence worth stating: a
  // sequence step already using {{booking_link}} will then skip every lead,
  // because renderTemplate treats a missing value as missing rather than
  // rendering a gap. Reported so the UI can say so rather than leaving them to
  // discover it from a silent drop in reach.
  return NextResponse.json({ ok: true, booking_link: stored });
}
