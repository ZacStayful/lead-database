import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { canEditLeadBrief } from "@/lib/leadBrief/gate";
import { parseBriefBody } from "@/lib/leadBrief/briefRequest";
import { computeBriefForCustomer } from "@/lib/leadBrief/briefServer";
import { basePostcodeChanged, keptForRecompute, readStoredPriorities } from "@/lib/leadBrief/editBrief";
import { BriefVersionsUnavailableError, loadBriefVersions } from "@/lib/leadBrief/briefVersions";
import { normaliseBriefInput } from "@/lib/leadBrief/input";
import { previewForClient } from "@/lib/leadBrief/preview";
import { BriefSupplyUnavailableError } from "@/lib/leadBrief/supply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The "Your brief" editor's area preview (Phase 5). Session only, and only for
 * a customer who has confirmed a brief (`canEditLeadBrief`), so nobody else can
 * use it to read supply.
 *
 * The answers come from the body through the questionnaire's own parser. The
 * ranking and the customer's chosen levels come from their STORED brief, never
 * the body, so this preview is the area the save would store. A different
 * base postcode is 409 `postcode_locked`, as on the save (batch 05, locked
 * decision 1).
 *
 * ⚠️ THE RESPONSE IS `previewForClient` AND NOTHING ELSE (A4, locked decision 9).
 */
export async function POST(req: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!customer || !canEditLeadBrief(customer)) {
    return NextResponse.json({ error: "Not available", code: "not_brief_customer" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseBriefBody(body);
  const admin = createAdminClient();

  try {
    const versions = await loadBriefVersions(admin, customer.id);
    if (!versions.active) return NextResponse.json({ code: "conflict" }, { status: 409 });
    const kept = keptForRecompute(readStoredPriorities(versions.active.priorities), {
      minBedrooms: parsed.input.minBedrooms ?? null,
      minGross: parsed.input.minGross ?? null,
    });
    const input = { ...parsed.input, ranking: kept.ranking, thresholds: kept.thresholds };
    // Batch 05, locked decision 1: no preview of an area round another
    // postcode either. Unparseable input falls through to the compute, which
    // reports the issues exactly as before.
    const judged = normaliseBriefInput(input);
    if (judged.ok && basePostcodeChanged(versions.active, judged.brief)) {
      return NextResponse.json(
        { code: "postcode_locked", lockedPostcode: versions.active.base_postcode },
        { status: 409 }
      );
    }
    const result = await computeBriefForCustomer(
      admin,
      customer,
      { ...parsed, input },
      { autoTickRecommended: false }
    );
    if (!result.ok) {
      return NextResponse.json({ code: "invalid_input", issues: result.issues }, { status: 400 });
    }
    return NextResponse.json({
      preview: previewForClient(result.preview),
      similarAreas: [...result.preview.brief.similarAreas],
    });
  } catch (err) {
    if (err instanceof BriefSupplyUnavailableError || err instanceof BriefVersionsUnavailableError) {
      console.error("[lead-brief/edit/preview] unavailable", err.message);
      return NextResponse.json({ code: "supply_unavailable" }, { status: 503 });
    }
    console.error("[lead-brief/edit/preview] failed", err);
    return NextResponse.json({ code: "preview_failed" }, { status: 500 });
  }
}
