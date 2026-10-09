import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { needsLeadBrief } from "@/lib/leadBrief/gate";
import { parseBriefBody } from "@/lib/leadBrief/briefRequest";
import { computeBriefForCustomer } from "@/lib/leadBrief/briefServer";
import { previewForClient } from "@/lib/leadBrief/preview";
import { BriefSupplyUnavailableError } from "@/lib/leadBrief/supply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The questionnaire's match preview (Phase 3). Session only; only a customer
 * who still needs a brief may ask (`needsLeadBrief`), so nobody else can use
 * this as a way to read supply.
 *
 * ⚠️ THE RESPONSE IS `previewForClient` AND NOTHING ELSE. The server preview
 * carries the service, first-pick and behind-pace outcode lists and the
 * forecast; none of that may reach a browser (A4, locked decision 9). The
 * ticked similar areas are echoed back so the screen knows which box the
 * server pre-ticked.
 */
export async function POST(req: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!customer || !needsLeadBrief(customer)) {
    return NextResponse.json({ error: "Not available", code: "not_brief_customer" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseBriefBody(body);

  try {
    const result = await computeBriefForCustomer(createAdminClient(), customer, parsed, {
      autoTickRecommended: true,
    });
    if (!result.ok) {
      return NextResponse.json({ code: "invalid_input", issues: result.issues }, { status: 400 });
    }
    return NextResponse.json({
      preview: previewForClient(result.preview),
      similarAreas: [...result.preview.brief.similarAreas],
    });
  } catch (err) {
    if (err instanceof BriefSupplyUnavailableError) {
      console.error("[lead-brief/preview] supply unavailable", err.message);
      return NextResponse.json({ code: "supply_unavailable" }, { status: 503 });
    }
    console.error("[lead-brief/preview] failed", err);
    return NextResponse.json({ code: "preview_failed" }, { status: 500 });
  }
}
