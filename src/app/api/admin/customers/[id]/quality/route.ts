import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import type { ReplacementFilter } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/customers/[id]/quality
 *
 * Tune one customer's lead-quality settings. Admin only — none of these fields
 * are writable by any RLS policy, and none of them are ever shown to the
 * customer.
 *
 *   quality_allowance_pct   share of the plan the hidden claim budget is worth
 *   quality_review_required send every claim from this customer to review
 *   clean_leads_streak      reset the earned-credit streak by hand
 *   replacement_filter      what a replacement lead has to look like
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    quality_allowance_pct?: number;
    quality_review_required?: boolean;
    clean_leads_streak?: number;
    quality_claims_this_cycle?: number;
    replacement_filter?: ReplacementFilter | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.quality_allowance_pct !== undefined) {
    const pct = Number(body.quality_allowance_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 1) {
      return NextResponse.json(
        { error: "quality_allowance_pct must be between 0 and 1" },
        { status: 400 }
      );
    }
    update.quality_allowance_pct = pct;
  }

  if (typeof body.quality_review_required === "boolean") {
    update.quality_review_required = body.quality_review_required;
  }

  for (const field of ["clean_leads_streak", "quality_claims_this_cycle"] as const) {
    if (body[field] !== undefined) {
      const n = Number(body[field]);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json(
          { error: `${field} must be zero or more` },
          { status: 400 }
        );
      }
      update[field] = Math.floor(n);
    }
  }

  if (body.replacement_filter !== undefined) {
    update.replacement_filter = normaliseFilter(body.replacement_filter);
  }

  if (Object.keys(update).length === 1) {
    return NextResponse.json({ status: "noop" });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("customers")
    .update(update)
    .eq("id", params.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

/** An empty filter is stored as null so find_replacement_lead skips it. */
function normaliseFilter(
  filter: ReplacementFilter | null
): ReplacementFilter | null {
  if (!filter) return null;

  const cities = Array.isArray(filter.cities)
    ? filter.cities
        .map((c) => String(c).trim())
        .filter(Boolean)
        .slice(0, 50)
    : [];

  const minBedrooms = Number(filter.min_bedrooms);
  const hasBedrooms = Number.isFinite(minBedrooms) && minBedrooms > 0;

  if (cities.length === 0 && !hasBedrooms) return null;

  return {
    ...(cities.length > 0 ? { cities } : {}),
    ...(hasBedrooms ? { min_bedrooms: Math.floor(minBedrooms) } : {}),
  };
}
