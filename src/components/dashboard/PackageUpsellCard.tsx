"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ProductCopy } from "@/lib/products";

/**
 * The cross-sell card for a product the customer does NOT hold.
 *
 * Explains what a lead of this type actually is before asking for money — a
 * management operator and a rent-to-rent operator run different businesses, and
 * "10 more leads" means nothing without saying which kind of landlord, how they
 * were qualified, and how the operator makes money from them.
 *
 * `canSubscribe` is false when the customer holds neither product (a waitlisted
 * account). They still see the description — knowing what is on offer is not
 * gated — but the call to action is support rather than checkout, because the
 * subscribe route refuses them anyway. Better to say so than to show a button
 * that returns a 403.
 */
export function PackageUpsellCard({
  product,
  canSubscribe,
}: {
  product: ProductCopy;
  canSubscribe: boolean;
}) {
  const [planKey, setPlanKey] = useState(product.plans[0].key);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected =
    product.plans.find((p) => p.key === planKey) ?? product.plans[0];
  const multiPlan = product.plans.length > 1;

  async function subscribe() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: product.leadType, plan: planKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? "Could not start checkout");
      }
      // Stripe Checkout is a full redirect, so the button stays in its loading
      // state until the browser leaves — deliberately not reset here.
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout");
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{product.name}</h2>
              <Badge variant="muted">Not subscribed</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {product.tagline}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold">£{selected.priceGbp}</p>
            <p className="text-xs text-muted-foreground">
              per month · {selected.leads} leads
            </p>
          </div>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <p className="font-medium">What one of these leads is</p>
            <p className="mt-1 text-muted-foreground">{product.whatALeadIs}</p>
          </div>
          <div>
            <p className="font-medium">How it&rsquo;s qualified</p>
            <p className="mt-1 text-muted-foreground">{product.qualification}</p>
          </div>
          <div>
            <p className="font-medium">How you make money from it</p>
            <p className="mt-1 text-muted-foreground">{product.outcome}</p>
          </div>
        </div>

        <ul className="space-y-1.5">
          {product.highlights.map((h) => (
            <li key={h} className="flex gap-2 text-sm text-muted-foreground">
              <span aria-hidden className="text-brand">
                &#10003;
              </span>
              <span>{h}</span>
            </li>
          ))}
        </ul>

        {canSubscribe ? (
          <div className="space-y-3 border-t border-border pt-4">
            {multiPlan && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Choose your plan
                </p>
                <div className="flex flex-wrap gap-2">
                  {product.plans.map((plan) => {
                    const active = plan.key === planKey;
                    return (
                      <button
                        key={plan.key}
                        type="button"
                        onClick={() => setPlanKey(plan.key)}
                        aria-pressed={active}
                        className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                          active
                            ? "border-brand bg-brand/10 text-foreground"
                            : "border-input text-muted-foreground hover:bg-accent"
                        }`}
                      >
                        <span className="block font-medium">{plan.label}</span>
                        <span className="block text-xs">
                          £{plan.priceGbp} per month
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={subscribe} disabled={loading}>
                {loading
                  ? "Opening checkout…"
                  : `Subscribe — £${selected.priceGbp}/month`}
              </Button>
              <span className="text-xs text-muted-foreground">
                Secure checkout with Stripe. Cancel any time from Settings.
              </span>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        ) : (
          <div className="border-t border-border pt-4">
            <p className="text-sm text-muted-foreground">
              Your account isn&rsquo;t active yet, so this can&rsquo;t be added
              here.{" "}
              <a href="/dashboard/support" className="underline">
                Contact support
              </a>{" "}
              and we&rsquo;ll get you set up.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
