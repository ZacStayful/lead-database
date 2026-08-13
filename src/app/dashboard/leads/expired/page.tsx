import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";
import {
  ExpiredLeadsPool,
  PoolExplainer,
} from "@/components/dashboard/ExpiredLeadsPool";
import type { LeadType, PoolLead } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * /dashboard/leads/expired — the expired leads pool.
 *
 * Read on the SERVICE ROLE after authenticating on the session client, exactly
 * as /dashboard/leads does. The leads RLS policy (0014) lets a customer read
 * only leads assigned to them, and a pool lead is by definition not assigned to
 * the viewer — so the session client would return an empty list. Widening that
 * policy is the wrong fix: it would expose every lead in the table to every
 * logged-in user and the pool's own rules (product, filter, not previously
 * assigned, not expired) would have to be re-implemented in RLS to hold. They
 * live in get_customer_pool_leads instead, which is the same predicate the
 * claim enforces.
 *
 * Paused management customers are excluded by customer_can_see_pool_lead, so a
 * paused customer sees the empty state rather than a shop they should not be
 * buying from.
 */
export default async function ExpiredLeadsPage({
  searchParams,
}: {
  searchParams: { product?: string };
}) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  // Held products, each read from its OWN columns (invariant 6). A GR-only
  // subscriber has account_status = 'waitlisted', so reading that here would
  // hide the pool from exactly the customers with the most leads in it.
  const holdsManagement =
    customer.subscription_status === "active" && customer.paused_at === null;
  const holdsGr = customer.gr_subscription_status === "active";

  if (!holdsManagement && !holdsGr) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Expired leads</h1>
        </div>
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="font-medium">Expired leads are for active subscribers</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {customer.paused_at
              ? "Your subscription is paused, so lead delivery is stopped. The pool will be here when you resume."
              : "Once your subscription is active you can call and claim from the pool."}
          </p>
        </div>
      </div>
    );
  }

  const available: { key: LeadType; label: string }[] = [
    ...(holdsManagement
      ? [{ key: "management" as LeadType, label: "Management" }]
      : []),
    ...(holdsGr
      ? [{ key: "guaranteed_rent" as LeadType, label: "Guaranteed Rent" }]
      : []),
  ];

  const requested = searchParams.product;
  const active =
    available.find((p) => p.key === requested)?.key ?? available[0].key;

  const admin = createAdminClient();
  const { data } = await admin.rpc("get_customer_pool_leads", {
    p_customer_id: customer.id,
    p_lead_type: active,
  });
  const leads = (data ?? []) as PoolLead[];

  const credits =
    active === "guaranteed_rent"
      ? customer.gr_lead_balance
      : customer.lead_balance;
  const activeLabel = available.find((p) => p.key === active)!.label;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Expired leads</h1>
        <p className="text-sm text-muted-foreground">
          Landlords nobody followed up. Call them for free, claim the ones worth
          keeping.
        </p>
      </div>

      <PoolExplainer />

      {available.length > 1 && (
        <div className="flex gap-1 border-b">
          {available.map((p) => (
            <Link
              key={p.key}
              href={`/dashboard/leads/expired?product=${p.key}`}
              className={cn(
                "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                p.key === active
                  ? "border-brand text-brand"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {p.label}
            </Link>
          ))}
        </div>
      )}

      <ExpiredLeadsPool
        // Remount on a product switch so no confirmation or outcome from the
        // other product's list survives the change.
        key={active}
        leads={leads}
        credits={credits}
        productLabel={activeLabel}
      />
    </div>
  );
}
