import type { SupabaseClient } from "@supabase/supabase-js";
import { briefRoutingEnabled } from "@/lib/leadBrief/routing";
import { startManagementCheckout } from "@/lib/checkout/startManagementCheckout";
import type { CheckoutPlan } from "@/lib/checkout/rules";
import { advanceStep } from "@/lib/funnel/session";
import { paymentReceivedLoginUrl } from "@/lib/funnel/token";
import type { FunnelSessionRow } from "@/lib/funnel/server";

/**
 * A funnel session's payment (batch 02 Phases 4 and 5), shared by its two
 * doors so they cannot disagree:
 *   - POST /api/funnel/[token]/checkout, "Continue to payment" on the plan
 *     screen;
 *   - GET /pay/[offerToken] for an offer the funnel issued (Phase 5's
 *     discount), which is the link in its reminder email and text.
 *
 * Either way the subscription is tagged `source = 'funnel'` with the session
 * id, which is what the webhook's completeFunnelPayment keys on to give the
 * payer a sign-in link and the brief. Paying a funnel offer through the call
 * route would skip both.
 *
 * Who is paying comes from the session row, never a request body.
 *
 * ⚠️ REFUSED UNLESS BRIEF ROUTING IS ON. A funnel payer is set up as a Lead
 * Brief customer, 0163 keeps such customers out of the legacy pools, and brief
 * routing runs only while `lead_brief_enabled` is on. Taking the money with it
 * off would sell leads that routing would never send (0165's own warning).
 *
 * ⚠️ A preview first. The plan screen shows each plan's area from the preview,
 * and the brief confirmation is built from it, so a session that has never
 * previewed cannot pay.
 */
export type FunnelCheckoutResult =
  | { status: "checkout"; url: string }
  | { status: "already_customer"; loginUrl: string }
  | { status: "refused"; code: "preview_required" | "payment_not_open" }
  | { status: "unavailable" };

export async function startFunnelCheckout(
  admin: SupabaseClient,
  session: FunnelSessionRow,
  plan: CheckoutPlan,
  cancelUrl: string
): Promise<FunnelCheckoutResult> {
  if (!session.preview_snapshot) return { status: "refused", code: "preview_required" };
  if (!(await briefRoutingEnabled(admin))) return { status: "refused", code: "payment_not_open" };

  const result = await startManagementCheckout(admin, {
    email: session.email,
    phone: session.phone,
    name: session.name,
    plan,
    source: "funnel",
    // A post-call code for this person, or the funnel's own (Phase 5).
    discountOfferId: session.discount_offer_id ?? undefined,
    funnelSessionId: session.id,
    successUrl: paymentReceivedLoginUrl(),
    cancelUrl,
  });

  if (result.status === "already_customer") return { status: "already_customer", loginUrl: result.loginUrl };
  if (result.status === "unavailable") {
    console.error("[funnel/checkout] checkout unavailable", result.reason);
    return { status: "unavailable" };
  }

  // Recorded for the admin and for the payment's provisioning. A failed write
  // is logged and does not stand in the way of paying: the subscription's own
  // metadata carries the funnel session id, which is what the webhook reads.
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

  return { status: "checkout", url: result.url };
}
