import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentCustomer } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PackageUpsellCard } from "@/components/dashboard/PackageUpsellCard";
import { PlanChangeCard } from "@/components/dashboard/PlanChangeCard";
import { PRODUCT_COPY, holdsProduct, previouslyHeldProduct } from "@/lib/products";
import type { LeadType } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Lead packages — what the customer has, and what they don't.
 *
 * The two products sell to different businesses (a management operator earns a
 * fee, a rent-to-rent operator earns a margin), and a customer on one has no
 * reason to know what the other's leads are. So the card for a product they do
 * not hold leads with the explanation, not the price.
 *
 * Held/not-held is per product and reads only that product's columns
 * (holdsProduct) — management from account_status/subscription_status, GR from
 * gr_subscription_status. Using a management column to decide the GR side would
 * offer Guaranteed Rent to somebody who already has it, or hide it from
 * somebody who cancelled management (CLAUDE.md invariant 6).
 */
export default async function PackagesPage({
  searchParams,
}: {
  searchParams?: { checkout?: string; product?: string };
}) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const order: LeadType[] = ["management", "guaranteed_rent"];
  const held = order.filter((t) => holdsProduct(customer, t));
  const notHeld = order.filter((t) => !holdsProduct(customer, t));

  // Who may start a checkout, mirroring /api/customer/subscribe exactly — an
  // offered button that 403s reads as a bug, and a hidden one reads as a missing
  // feature (§18E).
  //
  // PER PRODUCT, not per page. Holding the other product buys you either; having
  // once held THIS one buys you only this one back. So a customer who cancelled
  // management sees a checkout for management and support copy for guaranteed
  // rent, because buying GR would be acquisition and that stays retired (§17).
  const canSubscribeTo = (leadType: LeadType) =>
    held.length > 0 || previouslyHeldProduct(customer, leadType);
  const canSubscribeAny = notHeld.some(canSubscribeTo);

  const checkout = searchParams?.checkout;
  const boughtName =
    searchParams?.product === "guaranteed_rent"
      ? PRODUCT_COPY.guaranteed_rent.name
      : searchParams?.product === "management"
        ? PRODUCT_COPY.management.name
        : "Your new subscription";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Lead packages</h1>
        <p className="text-sm text-muted-foreground">
          What you receive today, and what else we can send you.
        </p>
      </div>

      {checkout === "success" && (
        <Card className="border-brand">
          <CardContent className="pt-6">
            <p className="text-sm font-medium">Payment received</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {boughtName} is being set up now. Your first leads are credited as
              soon as the payment settles — usually within a minute — and appear
              in{" "}
              <Link href="/dashboard/leads" className="underline">
                your leads feed
              </Link>
              . If it hasn&rsquo;t appeared in ten minutes, contact support.
            </p>
          </CardContent>
        </Card>
      )}

      {checkout === "cancelled" && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Checkout was cancelled — nothing has been charged.
            </p>
          </CardContent>
        </Card>
      )}

      {held.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Your subscriptions
          </h2>
          {held.map((leadType) => {
            const product = PRODUCT_COPY[leadType];
            return (
              <Card key={leadType}>
                <CardContent className="pt-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-semibold">
                          {product.name}
                        </h3>
                        <Badge variant="brand">Active</Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {product.tagline}
                      </p>
                    </div>
                    <Link
                      href="/dashboard/settings"
                      className="text-sm underline text-muted-foreground hover:text-foreground"
                    >
                      Manage billing
                    </Link>
                  </div>

                  {/* Tier change. Paused blocks the management side only:
                      paused_at is a management column and GR keeps flowing to a
                      paused management customer (invariant 6). */}
                  <PlanChangeCard
                    leadType={leadType}
                    currentAllocation={
                      leadType === "guaranteed_rent"
                        ? customer.gr_monthly_allocation
                        : customer.monthly_allocation
                    }
                    pendingAllocation={
                      leadType === "guaranteed_rent"
                        ? customer.gr_pending_monthly_allocation
                        : customer.pending_monthly_allocation
                    }
                    pendingEffectiveAt={
                      leadType === "guaranteed_rent"
                        ? customer.gr_pending_plan_change_at
                        : customer.pending_plan_change_at
                    }
                    hasSubscription={Boolean(
                      leadType === "guaranteed_rent"
                        ? customer.gr_stripe_subscription_id
                        : customer.stripe_subscription_id
                    )}
                    blockedReason={
                      leadType === "management" && customer.paused_at
                        ? "Your subscription is paused. Resume it from Settings to change plan."
                        : null
                    }
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {notHeld.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {canSubscribeAny ? "Also available to you" : "Our lead packages"}
          </h2>
          {notHeld.map((leadType) => (
            <PackageUpsellCard
              key={leadType}
              product={PRODUCT_COPY[leadType]}
              canSubscribe={canSubscribeTo(leadType)}
            />
          ))}
        </div>
      )}

      {notHeld.length === 0 && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              You&rsquo;re subscribed to both lead packages — there&rsquo;s
              nothing else to add. Need more leads this month? Use{" "}
              <Link href="/dashboard/topup" className="underline">
                Top up leads
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
