import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BRAND_PRESETS,
  DEFAULT_PRESENTATION_BRAND,
  derivePalette,
  logoMaxBytes,
  logoStoragePath,
  sniffLogoMime,
  validatePresentationBrand,
  type PresentationBrand,
} from "@/lib/presentationBrand";
import { brandLogoDataUrl, PRESENTATION_BRAND_BUCKET } from "@/lib/presentationBrandStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The authenticated customer's presentation branding (0112) — their logo and
 * their colour, applied to every presentation they open.
 *
 * ANY SUBSCRIBER, management or GR, unlike the terms profile beside it. The
 * lead-seeded half of the presentation is management-only because a management
 * fee is not what a GR operator sells (invariant 6); a logo is not a product.
 *
 * Auth on the session client, write on the service role — `customers` has a
 * single SELECT policy and no write policy, and this adds none (invariant 7).
 *
 * ⚠️ THE BYTES COME THROUGH THIS ROUTE. The bucket has no `storage.objects`
 * policy at all, so the browser cannot upload to it directly, which is the
 * point: the file is checked here — its real type sniffed from its own bytes
 * rather than believed from the upload's declared content-type — before
 * anything is stored.
 */

interface BrandRow {
  id: string;
  presentation_brand: unknown;
  presentation_brand_updated_at: string | null;
}

async function loadCustomer(userId: string): Promise<BrandRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("customers")
    .select("id, presentation_brand, presentation_brand_updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as BrandRow | null) ?? null;
}

async function respond(row: BrandRow, brand: PresentationBrand) {
  return NextResponse.json({
    brand,
    palette: derivePalette(brand.accent),
    presets: BRAND_PRESETS,
    // NULL means never saved. Deliberately NOT derived from the blob's
    // contents: a customer who deliberately keeps the default green HAS
    // configured this, and testing the contents would nag them for ever — the
    // same distinction §26.5 draws for the terms profile.
    configured: row.presentation_brand_updated_at != null,
    updatedAt: row.presentation_brand_updated_at,
    logoUrl: await brandLogoDataUrl(brand),
  });
}

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = await loadCustomer(user.id);
  if (!row) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  return respond(row, validatePresentationBrand(row.presentation_brand));
}

/**
 * Multipart, because one of the fields is a file.
 *
 * `accent` is always sent; `logo` is a new file or absent; `remove_logo` drops
 * the one on record. Absent and removed are different requests, so saving a
 * colour cannot silently delete a logo.
 */
export async function PUT(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = await loadCustomer(user.id);
  if (!row) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a form submission" }, { status: 400 });
  }

  const current = validatePresentationBrand(row.presentation_brand);
  const accent = String(form.get("accent") ?? "");
  const removeLogo = form.get("remove_logo") === "1";
  const file = form.get("logo");

  const admin = createAdminClient();
  let logo = current.logo;

  if (file instanceof File && file.size > 0) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffLogoMime(bytes);
    if (!mime) {
      return NextResponse.json(
        { error: "That file is not a PNG, JPEG, WebP or SVG image." },
        { status: 400 }
      );
    }
    const cap = logoMaxBytes(mime);
    if (bytes.byteLength > cap) {
      return NextResponse.json(
        {
          error:
            mime === "image/svg+xml"
              ? "That SVG is over 512 KB — a vector logo should be a few kilobytes."
              : "That image is over 2 MB.",
        },
        { status: 400 }
      );
    }

    const path = logoStoragePath(row.id);
    const { error: uploadError } = await admin.storage
      .from(PRESENTATION_BRAND_BUCKET)
      .upload(path, bytes, { contentType: mime, upsert: true });
    if (uploadError) {
      console.error("presentation brand: logo upload failed", row.id, uploadError);
      return NextResponse.json({ error: "Could not store that logo" }, { status: 500 });
    }
    logo = { path, mime, sizeBytes: bytes.byteLength };
  } else if (removeLogo) {
    if (current.logo) {
      // Best-effort: a failed remove leaves an object nothing points at, which
      // the next upload overwrites anyway (one fixed path per customer).
      const { error } = await admin.storage
        .from(PRESENTATION_BRAND_BUCKET)
        .remove([current.logo.path]);
      if (error) console.error("presentation brand: logo remove failed", row.id, error);
    }
    logo = null;
  }

  // Coerced rather than rejected, so a malformed colour degrades to the default
  // instead of 400-ing at somebody mid-save.
  const brand = validatePresentationBrand({ accent, logo });

  const updatedAt = new Date().toISOString();
  const { error } = await admin
    .from("customers")
    .update({ presentation_brand: brand, presentation_brand_updated_at: updatedAt })
    .eq("id", row.id);

  if (error) {
    console.error("presentation brand: write failed", row.id, error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return respond({ ...row, presentation_brand_updated_at: updatedAt }, brand);
}

/** Back to the default palette and no logo. */
export async function DELETE() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = await loadCustomer(user.id);
  if (!row) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const current = validatePresentationBrand(row.presentation_brand);
  const admin = createAdminClient();
  if (current.logo) {
    const { error } = await admin.storage
      .from(PRESENTATION_BRAND_BUCKET)
      .remove([current.logo.path]);
    if (error) console.error("presentation brand: logo remove failed", row.id, error);
  }

  const updatedAt = new Date().toISOString();
  const { error } = await admin
    .from("customers")
    .update({
      presentation_brand: DEFAULT_PRESENTATION_BRAND,
      presentation_brand_updated_at: updatedAt,
    })
    .eq("id", row.id);
  if (error) {
    console.error("presentation brand: reset failed", row.id, error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return respond(
    { ...row, presentation_brand_updated_at: updatedAt },
    DEFAULT_PRESENTATION_BRAND
  );
}
