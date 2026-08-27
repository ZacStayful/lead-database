import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
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
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("business_name, presentation_brand")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const row = customer as { business_name: string | null; presentation_brand: unknown };
  const brand = validatePresentationBrand(row.presentation_brand);

  return NextResponse.json({
    brand: await buildBrandPayload(brand),
    company: row.business_name?.trim() || null,
  });
}
