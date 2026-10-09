import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { briefRoutingEnabled } from "@/lib/leadBrief/routing";
import { startManagementCheckout } from "@/lib/checkout/startManagementCheckout";
import { isCheckoutPlan } from "@/lib/checkout/rules";
import { advanceStep, namesOtherProduct } from "@/lib/funnel/session";
import { FUNNEL_NO_STORE, funnelGate } from "@/lib/funnel/server";
import { funnelUrl, paymentReceivedLoginUrl } from "@/lib/funnel/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = FUNNEL_NO_STORE;

/**
 * POST /api/funnel/[token]/checkout — "Continue to payment" on the funnel's
 * plan screen (batch 02 Phase 4). The token is the credential, checked by
 * `funnelGate` first, as on every funnel route: the switch, the session, and
 * "already set up".
 *
 * Then the ONE door, startManagementCheckout, with `source = 'funnel'`. The
 * visitor supplies the plan and nothing else: who is paying comes from the
 * session, never the body.
 *
 * ⚠️ REFUSED UNLESS BRIEF ROUTING IS ON. A funnel payer is set up as a Lead
 * Brief customer (Phase 5), 0163 keeps such customers out of the legacy
 * pools, and brief routing runs only while `lead_brief_enabled` is on. Taking
 * the money with it off would sell leads that routing would never send
 * (0165's own warning). The page offers a call instead.
 *
 * ⚠️ A preview first. The plan screen shows each plan's area from the
 * preview, and the brief Phase 5 confirms is built from it, so a session that
 * has never previewed cannot pay.
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

  if (!session.preview_snapshot) {
    return NextResponse.json({ code: "preview_required" }, { status: 409, headers: NO_STORE });
  }
  if (!(await briefRoutingEnabled(admin))) {
    return NextResponse.json({ code: "payment_not_open" }, { status: 409, headers: NO_STORE });
  }

  const result = await startManagementCheckout(admin, {
    email: session.email,
    phone: session.phone,
    name: session.name,
    plan,
    source: "funnel",
    // A post-call code for this person, or (Phase 5) the funnel's own.
    discountOfferId: session.discount_offer_id ?? undefined,
    funnelSessionId: session.id,
    successUrl: paymentReceivedLoginUrl(),
    // Back to the funnel, which resumes on the plan screen.
    cancelUrl: funnelUrl(params.token),
  });

  if (result.status === "already_customer") {
    return NextResponse.json(
      { code: "already_set_up", loginUrl: result.loginUrl },
      { status: 409, headers: NO_STORE }
    );
  }
  if (result.status === "unavailable") {
    console.error("[funnel/checkout] checkout unavailable", result.reason);
    return NextResponse.json({ code: "payment_unavailable" }, { status: 503, headers: NO_STORE });
  }

  // Recorded for Phase 5 (provisioning keys on checkout_started) and for the
  // admin. A failed write is logged and does not stand in the way of paying:
  // the subscription's own metadata carries the funnel session id too.
  const update: Record<string, unknown> = {
    step: advanceStep(session.step, "checkout_started"),
    checkout_session_id: result.checkoutSessionId,
    plan_selected: plan,
  };
  if (result.customerId) update.customer_id = result.customerId;
  const { error } = await admin
    .from("funnel_sessions")
    .update(update)
    .eq("id", session.id)
    .neq("step", "paid");
  if (error) console.error("[funnel/checkout] could not record the checkout", error.message);

  return NextResponse.json({ url: result.url }, { headers: NO_STORE });
}
