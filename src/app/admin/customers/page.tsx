import { createAdminClient } from "@/lib/supabase/admin";
import { AdminCustomersTable } from "@/components/admin/AdminCustomersTable";
import { computePacing, computeGrPacing } from "@/lib/pacing";
import type { Customer, LeadType } from "@/lib/types";
import { AlertTriangle } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage() {
  const admin = createAdminClient();
  const { data } = await admin
    .from("customers")
    .select("*")
    .order("created_at", { ascending: false });
  const customers = (data ?? []) as Customer[];

  // "Last active on the platform" = the customer's last sign-in to the portal.
  // That lives in auth.users, not the customers table, so pull it via the Auth
  // admin API and key it back to each customer by their linked user_id.
  const lastSignInByUser = new Map<string, string | null>();
  for (let page = 1; page <= 20; page++) {
    const { data: usersPage, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error || !usersPage) break;
    for (const u of usersPage.users) {
      lastSignInByUser.set(u.id, u.last_sign_in_at ?? null);
    }
    if (usersPage.users.length < 200) break;
  }
  const lastActive: Record<string, string | null> = {};
  for (const c of customers) {
    if (c.user_id) lastActive[c.id] = lastSignInByUser.get(c.user_id) ?? null;
  }

  // Supply-problem alerts: behind by 5+, fewer than 10 days left, on a product
  // the customer is actually LIVE on.
  //
  // The only guard here used to be `is_active`, which is a generic row flag that
  // is true for every account — including waitlisted prospects who have never
  // subscribed. Those rows have no billing_cycle_anchor, so computePacing falls
  // back to created_at and reports a signup from three weeks ago as "0 received
  // vs 9 expected". That shortfall can never resolve, because the customer is
  // not entitled to leads at all, so the banner became permanent noise naming
  // people who were never owed anything.
  //
  // Each branch mirrors the corresponding half of get_next_customers_for_lead:
  // if the routing functions would not send them a lead, they cannot be behind
  // on one. Paused management customers are excluded for the same reason — their
  // delivery is stopped deliberately, which is not a supply problem.
  //
  // Pacing is per product, so a customer holding both is judged on each
  // separately and can appear once per product.
  const alerts = customers.flatMap((customer) => {
    if (!customer.is_active) return [];
    const rows: {
      customer: Customer;
      pacing: ReturnType<typeof computePacing>;
      product: LeadType;
      received: number;
    }[] = [];

    if (
      customer.account_status === "active" &&
      customer.subscription_status === "active" &&
      customer.paused_at == null
    ) {
      rows.push({
        customer,
        pacing: computePacing(customer),
        product: "management",
        received: customer.leads_received_this_month,
      });
    }
    if (customer.gr_subscription_status === "active") {
      rows.push({
        customer,
        pacing: computeGrPacing(customer),
        product: "guaranteed_rent",
        received: customer.gr_leads_received_this_month,
      });
    }

    return rows.filter(
      ({ pacing }) => pacing.deficit >= 5 && pacing.daysRemaining < 10
    );
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Customers</h1>
        <p className="text-sm text-muted-foreground">
          {customers.length} customer{customers.length === 1 ? "" : "s"}
        </p>
      </div>

      {alerts.length > 0 && (
        <div className="rounded-lg border-[0.5px] border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center gap-2 text-amber-800">
            <AlertTriangle className="h-4 w-4" />
            <p className="text-sm font-semibold">
              Potential supply problem — {alerts.length} customer
              {alerts.length === 1 ? "" : "s"} at risk of missing allocation
            </p>
          </div>
          <ul className="mt-2 space-y-1 text-sm text-amber-800">
            {alerts.map(({ customer, pacing, product, received }) => (
              <li key={`${customer.id}:${product}`}>
                <span className="font-medium">{customer.business_name}</span>{" "}
                <span className="text-xs">
                  ({product === "guaranteed_rent" ? "Guaranteed Rent" : "Management"})
                </span>{" "}
                — {received} received vs {pacing.expected} expected,{" "}
                {pacing.daysRemaining} day
                {pacing.daysRemaining === 1 ? "" : "s"} remaining
              </li>
            ))}
          </ul>
        </div>
      )}

      <AdminCustomersTable customers={customers} lastActive={lastActive} />
    </div>
  );
}
