import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { CapacityPanel } from "@/components/admin/CapacityPanel";
import { planForAllocation, grPlanForAllocation } from "@/lib/plans";
import { getCapacityStatus, getGrCapacityStatus } from "@/lib/capacity";
import { getServiceHealth } from "@/lib/serviceHealth";
import { ServiceHealthPanel } from "@/components/admin/ServiceHealthPanel";
import { EscalationSettingsPanel } from "@/components/admin/EscalationSettingsPanel";
import { DEFAULT_MAX_ASSIGNMENTS, type Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const admin = createAdminClient();

  const { data: customersRaw } = await admin.from("customers").select("*");
  const customers = (customersRaw ?? []) as Customer[];

  // "Active" spans BOTH products. subscription_status is management-only, so a
  // GR-only subscriber — whose management columns stay inactive by design
  // (CLAUDE.md §18) — was counted nowhere on this page despite paying monthly.
  const activeManagement = customers.filter(
    (c) => c.subscription_status === "active" && c.is_active
  );
  const activeGr = customers.filter(
    (c) => c.gr_subscription_status === "active" && c.is_active
  );
  const activeCustomers = customers.filter(
    (c) =>
      c.is_active &&
      (c.subscription_status === "active" || c.gr_subscription_status === "active")
  );

  // Capacity management uses account_status (admin approval), independent of
  // Stripe billing state. The "used" side is weighted by monthly allocation via
  // the shared helper — a 20-lead customer is one slot, a 10-lead customer half.
  //
  // Guaranteed Rent is capped separately (0054) and read off its own columns:
  // gr_subscription_status for the population, gr_monthly_allocation for the
  // weight. account_status is management-only, so it cannot appear on this side.
  const [capacity, grCapacity, health, escalationSettings] = await Promise.all([
    getCapacityStatus(),
    getGrCapacityStatus(),
    getServiceHealth(),
    // Read straight rather than through a helper: four keys, one table, and a
    // helper would only be indirection. Missing keys fall back to the values the
    // migration seeds, so the panel renders before it has ever been saved.
    createAdminClient()
      .from("system_settings")
      .select("key, value")
      .in("key", [
        "escalation_enabled",
        "escalation_max_lead_age_days",
        "escalation_score_threshold_day_10",
        "escalation_score_threshold_day_20",
      ])
      .then(({ data }) => {
        const m = new Map(
          ((data ?? []) as { key: string; value: string }[]).map((r) => [
            r.key,
            r.value,
          ])
        );
        return {
          enabled: m.get("escalation_enabled") === "true",
          maxLeadAgeDays: m.get("escalation_max_lead_age_days") ?? "",
          thresholdDay10: Number(m.get("escalation_score_threshold_day_10") ?? 0.3),
          thresholdDay20: Number(m.get("escalation_score_threshold_day_20") ?? 0.45),
        };
      }),
  ]);
  // Prospects awaiting a MANAGEMENT slot. A GR-only subscriber sits at
  // account_status 'waitlisted' permanently by design (§18) — they are a paying
  // customer, not someone queuing for management — so counting them here would
  // overstate the management waitlist the panel is sizing capacity against.
  // Archived rows (is_active = false) are excluded for the same reason: a
  // superseded duplicate signup is not a prospect waiting for a slot.
  const waitlistedAccounts = customers.filter(
    (c) =>
      c.account_status === "waitlisted" &&
      c.gr_subscription_status !== "active" &&
      c.is_active
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
    capacityLimit: capacity.limit,
    grWeightedUsed: grCapacity.weightedUsed,
    grCapacityLimit: grCapacity.limit,
    management: { filtered: mgmtFiltered, unfiltered: mgmtHolders.length - mgmtFiltered },
    gr: { filtered: grFiltered, unfiltered: grHolders.length - grFiltered },
  };

  // MRR counts only customers on a real Stripe subscription — comped/owner
  // accounts are active but generate no revenue.
  //
  // Summed per PRODUCT, not per customer: the two subscriptions are independent
  // and someone holding both is paying both fees, so they contribute twice. The
  // GR side is keyed on gr_stripe_subscription_id for the usual reason — the
  // management subscription id says nothing about whether GR is being billed.
  const mgmtMrr = activeManagement
    .filter((c) => c.stripe_subscription_id)
    .reduce(
      (sum, c) => sum + planForAllocation(c.monthly_allocation).priceGbp,
      0
    );
  const grMrr = activeGr
    .filter((c) => c.gr_stripe_subscription_id)
    .reduce(
      (sum, c) => sum + grPlanForAllocation(c.gr_monthly_allocation).priceGbp,
      0
    );
  const mrr = mgmtMrr + grMrr;
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
      (l.assignment_count ?? 0) < (l.max_assignments ?? DEFAULT_MAX_ASSIGNMENTS)
  ).length;

  const stats = [
    {
      label: "Monthly recurring revenue",
      value: `£${mrr.toLocaleString()}`,
      hint: `Management £${mgmtMrr.toLocaleString()} · Guaranteed Rent £${grMrr.toLocaleString()}`,
    },
    {
      label: "Active customers",
      value: String(activeCustomers.length),
      hint: `Management ${activeManagement.length} · Guaranteed Rent ${activeGr.length}`,
    },
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
      {/* Derived service health first: the manual caps below are a stated
          intention, this is what the lead supply can actually carry today. */}
      <ServiceHealthPanel health={health} />

      <EscalationSettingsPanel
        enabled={escalationSettings.enabled}
        maxLeadAgeDays={escalationSettings.maxLeadAgeDays}
        thresholdDay10={escalationSettings.thresholdDay10}
        thresholdDay20={escalationSettings.thresholdDay20}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <CapacityPanel
          product="management"
          title="Subscriber capacity — Management"
          weightedUsed={capacity.weightedUsed}
          rawActiveCount={capacity.rawActiveCount}
          activeLabel="active management customer"
          initialLimit={capacity.limit}
          waitlistedCount={waitlistedAccounts}
        />
        <CapacityPanel
          product="guaranteed_rent"
          title="Subscriber capacity — Guaranteed Rent"
          weightedUsed={grCapacity.weightedUsed}
          rawActiveCount={grCapacity.rawActiveCount}
          activeLabel="active guaranteed rent customer"
          initialLimit={grCapacity.limit}
        />
      </div>
      <FilterMixCard mix={filterMix} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-3xl font-semibold">{s.value}</p>
              {s.hint && (
                <p className="mt-1 text-xs text-muted-foreground">{s.hint}</p>
              )}
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
    capacityLimit: number;
    grWeightedUsed: number;
    grCapacityLimit: number;
    management: { filtered: number; unfiltered: number };
    gr: { filtered: number; unfiltered: number };
  };
}) {
  // Slots are per product now, so each figure names its product — an unlabelled
  // "Weighted slots used" beside a Guaranteed Rent row reads as covering both.
  const rows = [
    {
      label: "Management slots used",
      value: `${mix.weightedUsed} / ${mix.capacityLimit}`,
    },
    {
      label: "Guaranteed Rent slots used",
      value: `${mix.grWeightedUsed} / ${mix.grCapacityLimit}`,
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
        <dl className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
