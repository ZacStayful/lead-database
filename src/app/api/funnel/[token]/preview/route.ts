import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseBriefBody } from "@/lib/leadBrief/briefRequest";
import { normaliseBriefInput } from "@/lib/leadBrief/input";
import { BriefSupplyUnavailableError, loadBriefSupply } from "@/lib/leadBrief/supply";
import {
  computeFunnelPreviews,
  funnelAnswers,
  funnelPreviewBody,
  postcodeLockRefuses,
} from "@/lib/funnel/preview";
import {
  advanceStep,
  FUNNEL_PREVIEW_WINDOW_SECONDS,
  namesOtherProduct,
  previewAllowed,
} from "@/lib/funnel/session";
import { FUNNEL_NO_STORE, funnelGate, type FunnelSessionRow } from "@/lib/funnel/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = FUNNEL_NO_STORE;

/**
 * POST /api/funnel/[token]/preview — the funnel's Lead Brief preview, for both
 * plans (batch 02 Phase 2). No sign-in: the token is the credential.
 *
 * ⚠️ THE RESPONSE IS `funnelPreviewBody` AND NOTHING ELSE: two
 * `previewForClient` results and the ticked similar areas. Never a volume or a
 * count per area (02 locked decision 7, 01 A4). Anyone holding a funnel link
 * reaches this route, so it must not be a way to read our supply.
 *
 * The order is deliberate:
 *   1. The switch, the token and "already set up" before anything else
 *      (`funnelGate`, shared with the answers route).
 *   2. The input is judged (pure and cheap) and the postcode lock checked
 *      BEFORE the rate limit, so a typo or a refused postcode never spends one
 *      of the 20 previews.
 *   3. The rate limit BEFORE loading the supply, which is the expensive part
 *      the limit exists to bound.
 */
export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  const admin = createAdminClient();

  const gate = await funnelGate(admin, params.token, "preview");
  if (!gate.ok) return gate.response;
  const session = gate.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
  }
  if (namesOtherProduct(body)) {
    return NextResponse.json({ code: "management_only" }, { status: 400, headers: NO_STORE });
  }

  const parsed = parseBriefBody(body);
  const judged = normaliseBriefInput(parsed.input);
  if (!judged.ok) {
    return NextResponse.json({ code: "invalid_input", issues: judged.issues }, { status: 400, headers: NO_STORE });
  }
  const postcode = judged.brief.basePostcode;

  const lock = await lockPostcode(admin, session, postcode);
  if (lock === "failed") {
    return NextResponse.json({ code: "unavailable" }, { status: 503, headers: NO_STORE });
  }
  if (lock === "refused") {
    return NextResponse.json(
      { code: "postcode_locked", lockedPostcode: session.base_postcode_locked ?? null },
      { status: 409, headers: NO_STORE }
    );
  }

  const { data: budget, error: budgetError } = await admin.rpc("consume_funnel_preview", {
    p_session_id: session.id,
    p_window_seconds: FUNNEL_PREVIEW_WINDOW_SECONDS,
  });
  if (budgetError) {
    // Fails closed: a limiter that cannot count is not a limiter (§27.6).
    console.error("[funnel/preview] rate limit unavailable", budgetError.message);
    return NextResponse.json({ code: "unavailable" }, { status: 503, headers: NO_STORE });
  }
  const count = (budget as { count?: number } | null)?.count ?? null;
  if (count === null) return NextResponse.json({ code: "not_found" }, { status: 404, headers: NO_STORE });
  if (!previewAllowed(count)) {
    return NextResponse.json({ code: "rate_limited" }, { status: 429, headers: NO_STORE });
  }

  try {
    const supply = await loadBriefSupply(admin, { excludeCustomerId: null });
    const result = computeFunnelPreviews(parsed, supply);
    if (!result.ok) {
      return NextResponse.json({ code: "invalid_input", issues: result.issues }, { status: 400, headers: NO_STORE });
    }
    const response = funnelPreviewBody(result);

    // Best effort: the visitor has their preview whether or not this lands.
    // The snapshot is re-written on every preview, and checkout (Phase 4)
    // recomputes rather than trusting it.
    const { error: saveError } = await admin
      .from("funnel_sessions")
      .update({
        answers: funnelAnswers(result.previews[10].brief),
        preview_snapshot: response,
        step: advanceStep(session.step, "previewed"),
      })
      .eq("id", session.id)
      .neq("step", "paid");
    if (saveError) console.error("[funnel/preview] could not save the preview", saveError.message);

    return NextResponse.json(response, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof BriefSupplyUnavailableError) {
      // Never an empty preview from an unreadable book (§58).
      console.error("[funnel/preview] supply unavailable", err.message);
      return NextResponse.json({ code: "supply_unavailable" }, { status: 503, headers: NO_STORE });
    }
    console.error("[funnel/preview] failed", err);
    return NextResponse.json({ code: "preview_failed" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * Locks the base postcode on the first preview (02 Phase 2). The write only
 * claims an unlocked row, so two first previews racing with different
 * postcodes cannot both win: the loser re-reads the lock and is refused.
 */
async function lockPostcode(
  admin: ReturnType<typeof createAdminClient>,
  session: FunnelSessionRow,
  postcode: string
): Promise<"ok" | "refused" | "failed"> {
  if (session.base_postcode_locked) {
    return postcodeLockRefuses(session.base_postcode_locked, postcode) ? "refused" : "ok";
  }
  const { data, error } = await admin
    .from("funnel_sessions")
    .update({ base_postcode_locked: postcode })
    .eq("id", session.id)
    .is("base_postcode_locked", null)
    .select("base_postcode_locked");
  if (error) {
    console.error("[funnel/preview] could not lock the postcode", error.message);
    return "failed";
  }
  if (data && data.length > 0) return "ok";

  const { data: row, error: readError } = await admin
    .from("funnel_sessions")
    .select("base_postcode_locked")
    .eq("id", session.id)
    .maybeSingle();
  if (readError) return "failed";
  const locked = (row as { base_postcode_locked: string | null } | null)?.base_postcode_locked ?? null;
  session.base_postcode_locked = locked;
  return postcodeLockRefuses(locked, postcode) ? "refused" : "ok";
}
