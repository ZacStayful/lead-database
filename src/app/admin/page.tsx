import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { CapacityPanel } from "@/components/admin/CapacityPanel";
import { planForAllocation } from "@/lib/plans";
import { getCapacityStatus } from "@/lib/capacity";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const admin = createAdminClient();

  const { data: customersRaw } = await admin.from("customers").select("*");
  const customers = (customersRaw ?? []) as Customer[];
  const activeCustomers = customers.filter(
    (c) => c.subscription_status === "active" && c.is_active
  );

  // Capacity management uses account_status (admin approval), independent of
  // Stripe billing state. The "used" side is weighted by monthly allocation via
  // the shared helper — a 20-lead customer is one slot, a 10-lead customer half.
  const capacity = await getCapacityStatus();
  const waitlistedAccounts = customers.filter(
    (c) => c.account_status === "waitlisted"
  ).length;

  // Filter mix per product — reported separately, since a customer can filter
  // one product and not the other. "Filtered" = an active or pending-lift filter.
  const isFiltered = (s: string | null | undefined) =>
    s === "active" || s === "pending_lift";
  const mgmtHolders = customers.filter(
    (c) => c.subscription_status === "active" && c.account_status === "active"
  );
  const grHolders = customers.filter(
    (c) => c.gr_subscription_status === "active"
  );
  const mgmtFiltered = mgmtHolders.filter((c) => isFiltered(c.filter_status)).length;
  const grFiltered = grHolders.filter((c) => isFiltered(c.gr_filter_status)).length;
  const filterMix = {
    weightedUsed: capacity.weightedUsed,
    rawActiveCount: capacity.rawActiveCount,
    capacityLimit: capacity.limit,
    management: { filtered: mgmtFiltered, unfiltered: mgmtHolders.length - mgmtFiltered },
    gr: { filtered: grFiltered, unfiltered: grHolders.length - grFiltered },
  };

  // MRR counts only customers on a real Stripe subscription — comped/owner
  // accounts are active but generate no revenue.
  const payingCustomers = activeCustomers.filter(
    (c) => c.stripe_subscription_id
  );
  const mrr = payingCustomers.reduce(
    (sum, c) => sum + planForAllocation(c.monthly_allocation).priceGbp,
    0
  );
  const leadsThisMonth = customers.reduce(
    (sum, c) => sum + (c.leads_received_this_month ?? 0),
    0
  );

  // Leads received but not yet fully assigned (assignment_count < max_assignments).
  const { data: openLeads } = await admin
    .from("leads")
    .select("id, assignment_count, max_assignments");
  const notFullyAssigned = (openLeads ?? []).filter(
    (l: { assignment_count: number; max_assignments: number }) =>
      (l.assignment_count ?? 0) < (l.max_assignments ?? 2)
  ).length;

  const stats = [
    { label: "Monthly recurring revenue", value: `£${mrr.toLocaleString()}` },
    { label: "Active customers", value: String(activeCustomers.length) },
    { label: "Leads sent this month", value: String(leadsThisMonth) },
    { label: "Leads awaiting assignment", value: String(notFullyAssigned) },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-sm text-muted-foreground">
          System health at a glance.
        </p>
      </div>
      <CapacityPanel
        weightedUsed={capacity.weightedUsed}
        rawActiveCount={capacity.rawActiveCount}
        initialLimit={capacity.limit}
        waitlistedCount={waitlistedAccounts}
      />
      <FilterMixCard mix={filterMix} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-3xl font-semibold">{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function FilterMixCard({
  mix,
}: {
  mix: {
    weightedUsed: number;
    rawActiveCount: number;
    capacityLimit: number;
    management: { filtered: number; unfiltered: number };
    gr: { filtered: number; unfiltered: number };
  };
}) {
  const rows = [
    {
      label: "Weighted slots used",
      value: `${mix.weightedUsed} / ${mix.capacityLimit}`,
    },
    {
      label: "Management (filtered / unfiltered)",
      value: `${mix.management.filtered} / ${mix.management.unfiltered}`,
    },
    {
      label: "Guaranteed Rent (filtered / unfiltered)",
      value: `${mix.gr.filtered} / ${mix.gr.unfiltered}`,
    },
  ];
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm font-medium">Capacity &amp; filter mix</p>
        <dl className="mt-3 grid gap-4 sm:grid-cols-3">
          {rows.map((r) => (
            <div key={r.label}>
              <dt className="text-xs text-muted-foreground">{r.label}</dt>
              <dd className="mt-0.5 text-2xl font-semibold">{r.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
