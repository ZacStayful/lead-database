import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  LeadFilteringPanel,
  type AreaOption,
  type FilterPanelProps,
} from "@/components/dashboard/LeadFilteringPanel";
import { areaLabel } from "@/lib/postcode";
import {
  buildLeadVolumeAggregate,
  fetchAreaContention,
  fetchLeadVolumeData,
  type AreaContention,
  type LeadVolumeAggregate,
  type LeadVolumeData,
} from "@/lib/filterPrediction";
import type { Customer, FilterStatus } from "@/lib/types";
import { SERVICE_AREA_NOTICE } from "@/lib/leadBrief/briefCopy";
import { BRIEF_EDITOR_HREF, EDIT_COPY } from "@/lib/leadBrief/editCopy";
import { canEditLeadBrief } from "@/lib/leadBrief/gate";

export const dynamic = "force-dynamic";

export default async function LeadFilteringPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();

  // One paginated pass over the lead book builds two structures: the per-area
  // counts that shade the map (both products, bedroom-blind — as ever), and the
  // per-product volume aggregate the prediction runs on. This page used to run
  // its own copy of that loop; it now shares the module's, so a customer and an
  // admin cannot be shown different numbers for the same filter.
  //
  // ⚠️ AN UNREADABLE BOOK IS SAID SO, NEVER RENDERED AS AN EMPTY ONE. The loader
  // used to return an empty aggregate on a database error, and this page then
  // told the customer "No postcode areas are available yet" with the map, the
  // picker, the radius search and the whole forecast block gone — which is
  // what a run of Supabase gateway timeouts looked like in September 2026, and
  // what got reported as the filter revisions having been reverted (§58). The
  // page now carries the fact through to the panel, which says so in words and
  // disables Apply until the volumes can be read.
  let volumeData: LeadVolumeData;
  let volumeUnavailable = false;
  try {
    volumeData = await fetchLeadVolumeData(admin);
  } catch (err) {
    console.error("[dashboard/filtering] lead volume read failed", err);
    volumeUnavailable = true;
    volumeData = { aggregate: buildLeadVolumeAggregate([]), areaCounts: {} };
  }
  const { aggregate: volumeAggregate, areaCounts } = volumeData;

  // Per-product, and excluding this customer so re-quoting their own filter
  // does not count them as their own competitor.
  const [mgmtContention, grContention] = await Promise.all([
    fetchAreaContention(admin, "management", customer.id),
    fetchAreaContention(admin, "guaranteed_rent", customer.id),
  ]);

  const availableAreas: AreaOption[] = Object.keys(areaCounts)
    .sort((a, b) => a.localeCompare(b))
    .map((area) => ({ area, label: areaLabel(area) }));
  const maxAreaCount = availableAreas.reduce(
    (m, a) => Math.max(m, areaCounts[a.area] ?? 0),
    0
  );

  const panels = panelPropsFor(
    customer,
    availableAreas,
    areaCounts,
    maxAreaCount,
    volumeAggregate,
    { management: mgmtContention, guaranteed_rent: grContention },
    volumeUnavailable
  );

  const briefCustomer = customer.lead_brief_required === true;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Lead filtering</h1>
        <p className="text-sm text-muted-foreground">
          Receive only the leads that match your chosen locations and bedroom
          range.
        </p>
      </div>

      {/* The Lead Brief (Phase 3, C15): a brief customer's Management area
          comes from their brief, so its panel is replaced by this notice. GR
          is unaffected (invariant 6). */}
      {briefCustomer && (
        <div className="rounded-lg border-[0.5px] border-border p-6 text-sm">
          <p className="font-medium">{SERVICE_AREA_NOTICE.title}</p>
          <p className="mt-1 text-muted-foreground">{SERVICE_AREA_NOTICE.body}</p>
          {canEditLeadBrief(customer) && (
            <Link
              href={BRIEF_EDITOR_HREF}
              className="mt-2 inline-block font-medium text-brand-dark underline underline-offset-2"
            >
              {EDIT_COPY.editBriefLink}
            </Link>
          )}
        </div>
      )}

      {panels.length === 0 && !briefCustomer ? (
        <div className="rounded-lg border-[0.5px] border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Lead filtering becomes available once you have an active subscription.
        </div>
      ) : (
        panels.map((p) => <LeadFilteringPanel key={p.product} {...p} />)
      )}
    </div>
  );
}

/** Build a filter panel for each product the customer can filter. */
function panelPropsFor(
  customer: Customer,
  availableAreas: AreaOption[],
  areaCounts: Record<string, number>,
  maxAreaCount: number,
  volumeAggregate: LeadVolumeAggregate,
  contention: Record<"management" | "guaranteed_rent", AreaContention>,
  volumeUnavailable: boolean
): FilterPanelProps[] {
  const panels: FilterPanelProps[] = [];

  // A brief customer's Management area comes from their brief (C15).
  const managementVisible =
    !customer.lead_brief_required &&
    (customer.subscription_status === "active" ||
      (customer.filter_status ?? "off") !== "off");
  if (managementVisible) {
    panels.push({
      product: "management",
      productLabel: "Management",
      status: (customer.filter_status as FilterStatus) ?? "off",
      areas: customer.filter_areas ?? [],
      minBedrooms: customer.filter_min_bedrooms,
      maxBedrooms: customer.filter_max_bedrooms,
      minGross: customer.filter_min_gross ?? null,
      liftEffectiveDate: customer.filter_lift_effective_date,
      availableAreas,
      areaCounts,
      maxAreaCount,
      volume: volumeAggregate.management,
      // Raw allocation, deliberately not the pool-debit-adjusted effective
      // figure: the prediction is compared against what the plan owes.
      monthlyAllocation: customer.monthly_allocation ?? 0,
      leadBalance: customer.lead_balance ?? 0,
      contention: contention.management,
      // What the customer was SHOWN. The panel renders these rather than a fresh
      // forecast — a recomputed one drifts with ingest and would display a
      // figure they never actually read.
      expectedLeads: customer.filter_expected_leads,
      forecastLikelihoodPct: customer.filter_forecast_likelihood_pct,
      forecastCostPerLeadPence: customer.filter_forecast_cost_per_lead_pence,
      forecastAcknowledgedAt: customer.filter_forecast_acknowledged_at,
      volumeUnavailable,
    });
  }

  const grVisible =
    customer.gr_subscription_status === "active" ||
    (customer.gr_filter_status ?? "off") !== "off";
  if (grVisible) {
    panels.push({
      product: "guaranteed_rent",
      productLabel: "Guaranteed Rent",
      status: (customer.gr_filter_status as FilterStatus) ?? "off",
      areas: customer.gr_filter_areas ?? [],
      minBedrooms: customer.gr_filter_min_bedrooms,
      maxBedrooms: customer.gr_filter_max_bedrooms,
      // Never a floor on GR — there is no column, by design (§25).
      minGross: null,
      liftEffectiveDate: customer.gr_filter_lift_effective_date,
      availableAreas,
      areaCounts,
      maxAreaCount,
      volume: volumeAggregate.guaranteed_rent,
      monthlyAllocation: customer.gr_monthly_allocation ?? 0,
      leadBalance: customer.gr_lead_balance ?? 0,
      contention: contention.guaranteed_rent,
      expectedLeads: customer.gr_filter_expected_leads,
      forecastLikelihoodPct: customer.gr_filter_forecast_likelihood_pct,
      forecastCostPerLeadPence: customer.gr_filter_forecast_cost_per_lead_pence,
      forecastAcknowledgedAt: customer.gr_filter_forecast_acknowledged_at,
      volumeUnavailable,
    });
  }

  return panels;
}
