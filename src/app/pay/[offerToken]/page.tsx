/**
 * GET /pay/[offerToken]?plan=10|20 — the post-call payment link (batch 02
 * Phase 4). It replaces the raw Stripe Payment Links: the admin offer panel,
 * the reminder email and the reminder text all link here now
 * (computeCheckoutUrls), under the same field names.
 *
 * The token opens exactly one post-call offer (checkout/payToken.ts). Who is
 * paying comes from that offer row (email, name, phone); the visitor chooses
 * the plan and nothing else. Then the ONE door, startManagementCheckout, with
 * `source = 'call'`:
 *   - already a Management customer: to /login with "You're already set up";
 *   - otherwise: straight on to Stripe, with this person's code applied while
 *     it is still valid (an expired code just means full price).
 *
 * ⚠️ IT HAS A SIDE EFFECT ON GET, by the doc's design: a link in an email has
 * to work when clicked. What it creates is safe to repeat: the same Stripe
 * customer, and the same open session handed back (rules.ts). The plan
 * buttons are plain links, never prefetched, for the same reason.
 *
 * ⚠️ The token is in the path, so the page sends no referrer.
 */
import { notFound, redirect } from "next/navigation";
import { Logo } from "@/components/Logo";
import { createAdminClient } from "@/lib/supabase/admin";
import { BRIEF_BOOKING_URL } from "@/lib/leadBrief/briefCopy";
import { startManagementCheckout } from "@/lib/checkout/startManagementCheckout";
import { checkoutPlanFromParam, type CheckoutPlan } from "@/lib/checkout/rules";
import { payPath, payTokenSecret, verifyPayToken } from "@/lib/checkout/payToken";
import { PAY_COPY } from "@/lib/checkout/copy";
import { validDiscount, type DiscountRow } from "@/lib/funnel/answers";
import { FUNNEL_COPY, discountExpiry, planPriceLine } from "@/lib/funnel/copy";
import { paymentReceivedLoginUrl } from "@/lib/funnel/token";
import { APP_URL } from "@/lib/env";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Payment | Stayful",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

/** Only what the page needs: who is paying and their code. */
const OFFER_PAGE_COLUMNS = "id, prospect_email, prospect_name, prospect_phone, promo_code_string, expires_at, redeemed_at";

interface OfferPageRow extends DiscountRow {
  id: string;
  prospect_email: string;
  prospect_name: string | null;
  prospect_phone: string | null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo height={36} priority />
        </div>
        <div className="space-y-4 rounded-xl border border-black/10 bg-white p-6 text-center sm:p-8">{children}</div>
      </div>
    </main>
  );
}

function BookCall() {
  return (
    <a href={BRIEF_BOOKING_URL} rel="noreferrer" className="inline-block text-sm font-medium underline">
      {PAY_COPY.bookCall}
    </a>
  );
}

function PlanChoice(props: { token: string; title: string; intro: string; discount: string | null }) {
  const plans: CheckoutPlan[] = [10, 20];
  return (
    <Shell>
      <h1 className="text-lg font-semibold">{props.title}</h1>
      <p className="text-sm text-muted-foreground">{props.intro}</p>
      {props.discount && <p className="rounded-md bg-muted/60 px-3 py-2 text-sm">{props.discount}</p>}
      <ul className="space-y-2">
        {plans.map((plan) => (
          <li key={plan}>
            {/* A plain link, never <Link>: following it starts a checkout, so it must never be prefetched. */}
            <a
              href={payPath(props.token, plan)}
              className="block rounded-md bg-brand px-4 py-3 text-sm font-semibold text-white hover:bg-brand-dark"
            >
              {PAY_COPY.continueWith(plan)}
              <span className="block text-xs font-normal opacity-90">{planPriceLine(plan)}</span>
            </a>
          </li>
        ))}
      </ul>
      <BookCall />
    </Shell>
  );
}

function Unavailable() {
  return (
    <Shell>
      <h1 className="text-lg font-semibold">{PAY_COPY.unavailableTitle}</h1>
      <p className="text-sm text-muted-foreground">{PAY_COPY.unavailableBody}</p>
      <BookCall />
    </Shell>
  );
}

export default async function PayPage({
  params,
  searchParams,
}: {
  params: { offerToken: string };
  searchParams: { plan?: string | string[]; cancelled?: string | string[] };
}) {
  const offerId = verifyPayToken(params.offerToken, payTokenSecret());
  if (!offerId) notFound();

  const admin = createAdminClient();
  const { data, error } = await admin.from("post_call_offers").select(OFFER_PAGE_COLUMNS).eq("id", offerId).maybeSingle();
  if (error) {
    console.error("[pay] offer lookup failed", error.message);
    return <Unavailable />;
  }
  const offer = data as OfferPageRow | null;
  if (!offer) notFound();

  const code = validDiscount(offer, new Date());
  const discount = code ? FUNNEL_COPY.discountLine(code.code, discountExpiry(code.expiresAt) ?? "") : null;
  const plan = checkoutPlanFromParam(searchParams.plan);

  if (searchParams.cancelled !== undefined || !plan) {
    const cancelled = searchParams.cancelled !== undefined;
    return (
      <PlanChoice
        token={params.offerToken}
        title={cancelled ? PAY_COPY.cancelledTitle : PAY_COPY.choosePlanTitle}
        intro={cancelled ? PAY_COPY.cancelledBody : PAY_COPY.choosePlanIntro}
        discount={discount}
      />
    );
  }

  const result = await startManagementCheckout(admin, {
    email: offer.prospect_email,
    phone: offer.prospect_phone,
    name: offer.prospect_name ?? offer.prospect_email,
    plan,
    source: "call",
    discountOfferId: offer.id,
    successUrl: paymentReceivedLoginUrl(),
    cancelUrl: `${APP_URL}${payPath(params.offerToken)}?cancelled=1`,
  });

  // redirect() throws to leave the render, so it sits outside any try.
  if (result.status === "checkout") redirect(result.url);
  if (result.status === "already_customer") redirect(result.loginUrl);
  console.error("[pay] checkout unavailable", result.reason);
  return <Unavailable />;
}
