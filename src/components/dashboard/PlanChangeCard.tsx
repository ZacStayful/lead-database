"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PRODUCT_COPY } from "@/lib/products";
import type { LeadType } from "@/lib/types";

/**
 * Change the tier of a product the customer already holds.
 *
 * Deliberately NOT part of `PackageUpsellCard`. That card sells a product they
 * do not have and ends in Stripe Checkout; this one resizes a live subscription
 * and ends in a page refresh. Sharing a component would mean one submit button
 * that sometimes opens a payment page and sometimes changes a running
 * subscription — the same objection §21.4 raised to putting the announcement
 * send inside the compose form.
 *
 * Plan options come from `PRODUCT_COPY[leadType].plans`, so the price shown here
 * and the price charged at the switch both derive from the plan tables. A card
 * that disagrees with the invoice is how a customer ends up feeling mis-sold.
 *
 * NOTHING IS CHARGED TODAY, and the copy says so in as many words. The route
 * uses `proration_behavior: "none"`, so the customer keeps the cycle they have
 * paid for and the new price and lead count both start on their next billing
 * date. Saying "upgrade" without saying when it lands is how a support ticket
 * starts.
 */
export function PlanChangeCard({
  leadType,
  currentAllocation,
  pendingAllocation,
  pendingEffectiveAt,
  hasSubscription,
  blockedReason,
}: {
  leadType: LeadType;
  currentAllocation: number;
  pendingAllocation: number | null;
  pendingEffectiveAt: string | null;
  hasSubscription: boolean;
  blockedReason?: string | null;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const product = PRODUCT_COPY[leadType];
  const current =
    product.plans.find((p) => p.leads === currentAllocation) ?? product.plans[0];
  const alternative = product.plans.find((p) => p.leads !== current.leads);

  async function change(planKey: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/subscription/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: leadType, plan: planKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not change your plan");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change your plan");
    } finally {
      setLoading(false);
    }
  }

  const pendingPlan =
    pendingAllocation != null
      ? product.plans.find((p) => p.leads === pendingAllocation)
      : undefined;

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Your plan</p>
        <p className="text-sm text-muted-foreground">
          £{current.priceGbp} per month · {current.leads} leads
        </p>
      </div>

      {pendingAllocation != null ? (
        <div className="space-y-2 rounded-md border border-brand bg-brand/5 p-3">
          <p className="text-sm font-medium">
            Switching to {pendingAllocation} leads a month
            {pendingPlan ? ` (£${pendingPlan.priceGbp} per month)` : ""}
            {pendingEffectiveAt ? ` on ${formatDate(pendingEffectiveAt)}` : ""}.
          </p>
          <p className="text-xs text-muted-foreground">
            Until then you stay on {current.leads} leads a month at £
            {current.priceGbp}, which is what you have already paid for.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => change(current.key)}
          >
            {loading ? "Saving…" : `Keep my ${current.leads}-lead plan`}
          </Button>
        </div>
      ) : !hasSubscription ? (
        <p className="text-sm text-muted-foreground">
          We can&rsquo;t change this plan automatically —{" "}
          <a href="/dashboard/support" className="underline">
            contact support
          </a>{" "}
          and we&rsquo;ll do it for you.
        </p>
      ) : blockedReason ? (
        <p className="text-sm text-muted-foreground">{blockedReason}</p>
      ) : alternative ? (
        <div className="space-y-2">
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => change(alternative.key)}
          >
            {loading
              ? "Saving…"
              : `${alternative.leads > current.leads ? "Upgrade" : "Downgrade"} to ${alternative.leads} leads — £${alternative.priceGbp}/month`}
          </Button>
          <p className="text-xs text-muted-foreground">
            Takes effect on your next billing date. Nothing is charged today, and
            you keep your {current.leads} leads for the month you have paid for.
            Need more leads before then? Use{" "}
            <a href="/dashboard/topup" className="underline">
              Top up leads
            </a>
            .
          </p>
        </div>
      ) : null}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "your next billing date";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
