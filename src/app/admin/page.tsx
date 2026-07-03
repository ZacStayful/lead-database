import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { CapacityPanel } from "@/components/admin/CapacityPanel";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

const MONTHLY_PRICE_GBP = 300;

export default async function AdminOverviewPage() {
  const admin = createAdminClient();

  const { data: customersRaw } = await admin.from("customers").select("*");
  const customers = (customersRaw ?? []) as Customer[];
  const activeCustomers = customers.filter(
    (c) => c.subscription_status === "active" && c.is_active
  );

  // Capacity management uses account_status (admin approval), independent of
  // Stripe billing state.
  const activeAccounts = customers.filter(
    (c) => c.account_status === "active"
  ).length;
  const waitlistedAccounts = customers.filter(
    (c) => c.account_status === "waitlisted"
  ).length;
  const { data: capacitySetting } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "max_active_customers")
    .maybeSingle();
  const capacityLimit = parseInt(capacitySetting?.value ?? "10", 10);

  const mrr = activeCustomers.length * MONTHLY_PRICE_GBP;
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
        activeCount={activeAccounts}
        initialLimit={capacityLimit}
        waitlistedCount={waitlistedAccounts}
      />
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
