import { NextResponse } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { validatePresentationBrand } from "@/lib/presentationBrand";
import { buildBrandPayload } from "@/lib/presentationBrandStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/customer/presentation/brand — branding with no lead (0112).
 *
 * What `public/income-presentation/index.html` fetches when it is opened from
 * Documents with no `?lead=`. That tool has always been the generic one, and an
 * operator presenting from it should still be presenting as themselves.
 *
 * Deliberately separate from the lead route rather than a mode of it: this one
 * touches no lead, needs no assignment check, and is open to a GR customer, who
 * must never reach the lead-seeded half (invariant 6).
 *
 * Failing here is not an error the tool should show — the blank form is a
 * perfectly good presentation without a logo — so an unbranded customer and an
 * unreadable one both come back as the default palette.
 */
export async function GET() {
  // Identity from getCurrentCustomer(): an admin viewing a customer (§62)
  // gets that customer's branding, never their own.
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const row = customer as { business_name: string | null; presentation_brand: unknown };
  const brand = validatePresentationBrand(row.presentation_brand);

  return NextResponse.json({
    brand: await buildBrandPayload(brand),
    company: row.business_name?.trim() || null,
  });
}
