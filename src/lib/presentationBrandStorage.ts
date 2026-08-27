import { createAdminClient } from "@/lib/supabase/admin";
import { derivePalette, type BrandPalette, type PresentationBrand } from "@/lib/presentationBrand";

/**
 * Getting an operator's logo to the presentation (0112).
 *
 * ⚠️ THE LOGO IS INLINED AS A `data:` URI, NOT SERVED AS A SIGNED URL, and that
 * is the one decision in this file.
 *
 * `public/income-presentation/` vendors React locally specifically so it keeps
 * working offline or on a hotel network during a live meeting. A signed URL
 * reintroduces exactly what that avoids: a second request, to a host that may
 * be unreachable, for an asset that expires — and it expires on the clock,
 * meaning the failure lands mid-presentation rather than at the start where it
 * would be noticed. A logo is a few kilobytes; carrying it in the payload the
 * tool already fetches costs one storage read and cannot fail later.
 */

export const PRESENTATION_BRAND_BUCKET = "presentation-brand";

/** What the tool needs to paint itself. */
export interface BrandPayload {
  accent: string;
  palette: BrandPalette;
  /** `data:` URI, or null when they have not uploaded one. */
  logoUrl: string | null;
}

/**
 * The stored logo as a data URI, or null.
 *
 * FAILS TO NULL, NEVER THROWS. A missing or unreadable object must cost the
 * operator their logo and nothing else — the presentation still opens, in their
 * colours, with the landlord already on the call.
 */
export async function brandLogoDataUrl(brand: PresentationBrand): Promise<string | null> {
  if (!brand.logo) return null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(PRESENTATION_BRAND_BUCKET)
      .download(brand.logo.path);
    if (error || !data) {
      if (error) console.error("presentation brand: logo read failed", brand.logo.path, error);
      return null;
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    return `data:${brand.logo.mime};base64,${bytes.toString("base64")}`;
  } catch (err) {
    console.error("presentation brand: logo read threw", brand.logo.path, err);
    return null;
  }
}

/** The whole brand block the presentation endpoints return. */
export async function buildBrandPayload(brand: PresentationBrand): Promise<BrandPayload> {
  return {
    accent: brand.accent,
    palette: derivePalette(brand.accent),
    logoUrl: await brandLogoDataUrl(brand),
  };
}
