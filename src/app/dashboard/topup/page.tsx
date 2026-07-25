import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { TOPUP_CREDITS, TOPUP_AMOUNT_PENCE, productLabel } from "@/lib/topup";
import { topupIneligibilityReason } from "@/lib/topupCharge";
import { TopupPurchasePanel } from "@/components/dashboard/TopupPurchasePanel";
import type { LeadType } from "@/lib/types";

export const dynamic = "force-dynamic";

function formatGbp(pence: number): string {
  const pounds = pence / 100;
  return Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`;
}

/**
 * "Top up leads" — self-serve one-off purchase, available at any balance.
 *
 * A product card is shown only for products the customer actually holds
 * (management via account_status/subscription, GR via gr_subscription_status),
 * keeping the parallel-product split intact: neither card reads the other's
 * balance column.
 */
export default async function TopupTabPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");

  if (!customer) {
    return (
      <div className="rounded-xl border border-black/10 bg-white p-8">
        <h1 className="mb-2 text-lg font-semibold">Top up leads</h1>
        <p className="text-sm text-muted-foreground">
          We couldn&apos;t find your customer record yet. Please contact support.
        </p>
      </div>
    );
  }

  const price = formatGbp(TOPUP_AMOUNT_PENCE);

  // Which products does this customer hold? GR is independent of management.
  const products: LeadType[] = [];
  if (customer.account_status !== "cancelled") products.push("management");
  if (customer.gr_subscription_status === "active") {
    products.push("guaranteed_rent");
  }

  const cards = products.map((leadType) => ({
    leadType,
    label: productLabel(leadType),
    balance:
      leadType === "guaranteed_rent"
        ? customer.gr_lead_balance
        : customer.lead_balance,
    blockedReason: topupIneligibilityReason(customer, leadType),
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold text-foreground">Top up leads</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Buy extra leads whenever you need them — {TOPUP_CREDITS} leads for {price}{" "}
        ({formatGbp(TOPUP_AMOUNT_PENCE / TOPUP_CREDITS)} per lead), charged to the
        card already on file. Credits never expire and carry forward alongside
        your monthly allocation.
      </p>

      {cards.length === 0 ? (
        <div className="rounded-xl border border-black/10 bg-white p-8">
          <p className="text-sm text-muted-foreground">
            You don&apos;t have an active subscription to top up. Please contact
            support if you think this is wrong.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {cards.map((card) => (
            <TopupPurchasePanel
              key={card.leadType}
              leadType={card.leadType}
              productLabel={card.label}
              balance={card.balance}
              credits={TOPUP_CREDITS}
              priceLabel={price}
              blockedReason={card.blockedReason}
            />
          ))}
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        Top-ups are one-off payments and don&apos;t change your monthly
        subscription. You can buy as many as you like.
      </p>
    </div>
  );
}
