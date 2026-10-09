import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCheckoutPlan } from "@/lib/checkout/rules";
import { startFunnelCheckout } from "@/lib/funnel/checkout";
import { namesOtherProduct } from "@/lib/funnel/session";
import { FUNNEL_NO_STORE, funnelGate } from "@/lib/funnel/server";
import { funnelUrl } from "@/lib/funnel/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = FUNNEL_NO_STORE;

/**
 * POST /api/funnel/[token]/checkout — "Continue to payment" on the funnel's
 * plan screen (batch 02 Phase 4). The token is the credential, checked by
 * `funnelGate` first, as on every funnel route: the switch, the session, and
 * "already set up".
 *
 * Then startFunnelCheckout (src/lib/funnel/checkout.ts), shared with the /pay
 * link of a funnel offer: a preview first, brief routing on, and the ONE door
 * with `source = 'funnel'`. The visitor supplies the plan and nothing else.
 */
export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  const admin = createAdminClient();

  const gate = await funnelGate(admin, params.token, "checkout");
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
  const plan = (body as { plan?: unknown } | null)?.plan;
  if (!isCheckoutPlan(plan)) {
    return NextResponse.json({ code: "invalid_plan" }, { status: 400, headers: NO_STORE });
  }

  // Back to the funnel, which resumes on the plan screen.
  const result = await startFunnelCheckout(admin, session, plan, funnelUrl(params.token));

  if (result.status === "refused") {
    return NextResponse.json({ code: result.code }, { status: 409, headers: NO_STORE });
  }
  if (result.status === "already_customer") {
    return NextResponse.json(
      { code: "already_set_up", loginUrl: result.loginUrl },
      { status: 409, headers: NO_STORE }
    );
  }
  if (result.status === "unavailable") {
    return NextResponse.json({ code: "payment_unavailable" }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ url: result.url }, { headers: NO_STORE });
}
