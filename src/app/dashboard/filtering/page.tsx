import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  LeadFilteringPanel,
  type AreaOption,
  type FilterPanelProps,
} from "@/components/dashboard/LeadFilteringPanel";
import { areaLabel } from "@/lib/postcode";
import type { Customer, FilterStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeadFilteringPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();

  // Per-area lead counts across the whole inventory, so the map can shade each
  // area by volume and the customer can see where leads actually come from.
  // Paginated: a single select is capped (Supabase default 1000 rows), which
  // would undercount the map once the lead table grows past 1000.
  const areaCounts: Record<string, number> = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("leads")
      .select("postcode_area")
      .not("postcode_area", "is", null)
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data as { postcode_area: string | null }[]) {
      const a = r.postcode_area?.toUpperCase();
      if (a) areaCounts[a] = (areaCounts[a] ?? 0) + 1;
    }
    if (data.length < PAGE) break;
  }

  const availableAreas: AreaOption[] = Object.keys(areaCounts)
    .sort((a, b) => a.localeCompare(b))
    .map((area) => ({ area, label: areaLabel(area) }));
  const maxAreaCount = availableAreas.reduce(
    (m, a) => Math.max(m, areaCounts[a.area] ?? 0),
    0
  );

  const panels = panelPropsFor(customer, availableAreas, areaCounts, maxAreaCount);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Lead filtering</h1>
        <p className="text-sm text-muted-foreground">
          Receive only the leads that match your chosen locations and bedroom
          range.
        </p>
      </div>

      {panels.length === 0 ? (
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
  maxAreaCount: number
): FilterPanelProps[] {
  const panels: FilterPanelProps[] = [];

  const managementVisible =
    customer.subscription_status === "active" ||
    (customer.filter_status ?? "off") !== "off";
  if (managementVisible) {
    panels.push({
      product: "management",
      productLabel: "Management",
      status: (customer.filter_status as FilterStatus) ?? "off",
      areas: customer.filter_areas ?? [],
      minBedrooms: customer.filter_min_bedrooms,
      maxBedrooms: customer.filter_max_bedrooms,
      liftEffectiveDate: customer.filter_lift_effective_date,
      availableAreas,
      areaCounts,
      maxAreaCount,
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
      liftEffectiveDate: customer.gr_filter_lift_effective_date,
      availableAreas,
      areaCounts,
      maxAreaCount,
    });
  }

  return panels;
}
