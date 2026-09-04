/**
 * The details table exactly as a landlord will see it (§41, 0131).
 *
 * ⚠️ THIS IS WHAT MAKES THE FALLBACK LEGIBLE. The four overrides are
 * nullable-with-fallback — an empty box means "use my account details" — and
 * that rule is invisible in a form full of empty boxes. Showing the resolved
 * rows, live, is the difference between a customer understanding why their old
 * company name is still on the email and filing a support ticket about it.
 *
 * Same discipline as §40.14's reach line and §28's filter forecast: show the
 * number that changes the decision, while the decision is still open.
 *
 * A route rather than a client-side render because `landlordReferral.ts` pulls
 * `esc` from `emails.ts`, which constructs a Resend client — not client-safe.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { buildReferralCopy } from "@/lib/landlordReferral";
import { holdsProduct } from "@/lib/products";
import {
  resolveReferralOperator,
  validateReferralDetails,
  type ReferralIdentityRow,
} from "@/lib/referralIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const details = validateReferralDetails(body);
  if (!details.ok) {
    // Reported rather than 400'd — this fires while somebody is typing, and the
    // card shows the reason under the field.
    return NextResponse.json({ ok: false, error: details.message, field: details.field });
  }

  // The unsaved values over the stored row, so the preview shows what pressing
  // Save would produce rather than what was saved last time.
  const operator = resolveReferralOperator({
    ...(customer as unknown as ReferralIdentityRow),
    ...details.patch,
  });

  // ⚠️ Built through buildReferralCopy, never by reassembling the rows here. It
  // is what actually sends, and a preview with its own idea of which rows
  // appear would eventually disagree with the email about, say, whether a blank
  // phone shows an empty line.
  // Their own product, because the intro paragraph branches on it (invariant 6)
  // and a GR operator previewing management wording would be shown a sentence
  // they will never send.
  const leadType = holdsProduct(customer, "management")
    ? "management"
    : "guaranteed_rent";

  const copy = buildReferralCopy({
    lead: {
      lead_name: "Sarah Whitfield",
      address: "14 Gill Avenue, Bristol",
      lead_type: leadType,
    } as Parameters<typeof buildReferralCopy>[0]["lead"],
    operator,
    askQuestions: false,
  });

  return NextResponse.json({
    ok: true,
    subject: copy.subject,
    rows: copy.rows,
    intro: copy.intro,
  });
}
