import { cityForArea } from "@/lib/postcode";
import type { Customer, LeadType } from "@/lib/types";

/**
 * Reading a customer's lead filter for admin surfaces.
 *
 * The filter columns are per product and fully parallel (invariant 6), and the
 * two routing functions read them differently: `get_filtered_candidates_for_lead`
 * only considers customers whose filter is `active` or `pending_lift`, while
 * `get_unfiltered_candidates_for_lead` only considers `off`. So "has a filter"
 * means exactly those two statuses — a customer mid-lift is still filtered and
 * still ranks in the filtered pool.
 *
 * A null / empty `filter_areas` is "anywhere", not "nowhere": the SQL treats an
 * empty array as no area restriction, so a customer can filter on bedrooms
 * alone. Rendering that as an empty location list would misreport who is
 * eligible for what.
 */

export interface LeadFilterView {
  leadType: LeadType;
  /** Product name for display. */
  label: string;
  /** "active" | "pending_lift" */
  status: string;
  /** Postcode areas, already uppercased. Empty = any location. */
  areas: string[];
  minBedrooms: number | null;
  maxBedrooms: number | null;
  liftDate: string | null;
  /** How it was set (0094): "areas", "radius", or null for pre-0094 filters. */
  selectionMode: string | null;
  /** Radius details, only meaningful when selectionMode is "radius". */
  radiusOutcode: string | null;
  radiusMiles: number | null;
  /**
   * The volume forecast the customer was SHOWN (0098, renamed 0100) — not what
   * today's volumes would quote. The two drift as ingest moves, and admin needs
   * to see what was actually put in front of them to answer questions about it.
   *
   * A forecast, not a guarantee: expectedLeads is a lower bound and nothing is
   * credited when a month falls short.
   */
  expectedLeads: number | null;
  forecastCostPerLeadPence: number | null;
  forecastLikelihoodPct: number | null;
  forecastAcknowledgedAt: string | null;
}

export function isFilterActive(status?: string | null): boolean {
  return status === "active" || status === "pending_lift";
}

/** Does this customer restrict either product's leads? */
export function hasLeadFilter(customer: Customer): boolean {
  return (
    isFilterActive(customer.filter_status) ||
    isFilterActive(customer.gr_filter_status)
  );
}

/**
 * Every product the customer currently filters, management first. Returns an
 * empty array for an unfiltered customer, so callers can render nothing without
 * a separate check.
 */
export function activeLeadFilters(customer: Customer): LeadFilterView[] {
  const views: LeadFilterView[] = [];

  if (isFilterActive(customer.filter_status)) {
    views.push({
      leadType: "management",
      label: "Management",
      status: customer.filter_status,
      areas: normaliseAreas(customer.filter_areas),
      minBedrooms: customer.filter_min_bedrooms,
      maxBedrooms: customer.filter_max_bedrooms,
      liftDate: customer.filter_lift_effective_date,
      selectionMode: customer.filter_selection_mode ?? null,
      radiusOutcode: customer.filter_radius_outcode ?? null,
      radiusMiles: customer.filter_radius_miles ?? null,
      expectedLeads: customer.filter_expected_leads ?? null,
      forecastCostPerLeadPence:
        customer.filter_forecast_cost_per_lead_pence ?? null,
      forecastLikelihoodPct: customer.filter_forecast_likelihood_pct ?? null,
      forecastAcknowledgedAt: customer.filter_forecast_acknowledged_at ?? null,
    });
  }

  if (isFilterActive(customer.gr_filter_status)) {
    views.push({
      leadType: "guaranteed_rent",
      label: "Guaranteed Rent",
      status: customer.gr_filter_status,
      areas: normaliseAreas(customer.gr_filter_areas),
      minBedrooms: customer.gr_filter_min_bedrooms,
      maxBedrooms: customer.gr_filter_max_bedrooms,
      liftDate: customer.gr_filter_lift_effective_date,
      selectionMode: customer.gr_filter_selection_mode ?? null,
      radiusOutcode: customer.gr_filter_radius_outcode ?? null,
      radiusMiles: customer.gr_filter_radius_miles ?? null,
      expectedLeads: customer.gr_filter_expected_leads ?? null,
      forecastCostPerLeadPence:
        customer.gr_filter_forecast_cost_per_lead_pence ?? null,
      forecastLikelihoodPct:
        customer.gr_filter_forecast_likelihood_pct ?? null,
      forecastAcknowledgedAt: customer.gr_filter_forecast_acknowledged_at ?? null,
    });
  }

  return views;
}

function normaliseAreas(areas: string[] | null | undefined): string[] {
  return (areas ?? []).filter(Boolean).map((a) => a.toUpperCase());
}

/** "Any" · "3+" · "2–4" · "Exactly 3" · "Up to 4" */
export function bedroomPhrase(
  min: number | null,
  max: number | null
): string {
  if (min == null && max == null) return "Any";
  if (min != null && max != null) {
    return min === max ? `Exactly ${min}` : `${min}–${max}`;
  }
  if (min != null) return `${min}+`;
  return `Up to ${max}`;
}

/**
 * Postcode areas as "BS — Bristol" pairs. The area code is kept alongside the
 * city because the filter matches on the code: a lead lands in the filter
 * because its postcode area is BS, and an admin comparing a lead to a filter
 * needs the code, not just a city that may not be the one they had in mind.
 */
export function areaLabels(areas: string[]): string[] {
  return areas.map((a) => {
    const city = cityForArea(a);
    return city && city !== a ? `${a} — ${city}` : a;
  });
}

/** Full location text, or "Anywhere" when no area restriction is set. */
export function locationText(areas: string[]): string {
  return areas.length > 0 ? areaLabels(areas).join(", ") : "Anywhere";
}

/**
 * One compact line for table rows: "3+ beds · Bristol, Gloucester +3 more".
 * `maxAreas` caps the visible cities; pair it with `filterTooltip()` as a title
 * so the truncated names are still readable on hover.
 */
export function filterSummary(f: LeadFilterView, maxAreas = 3): string {
  const beds =
    f.minBedrooms == null && f.maxBedrooms == null
      ? null
      : `${bedroomPhrase(f.minBedrooms, f.maxBedrooms)} beds`;

  let places: string;
  if (f.areas.length === 0) {
    places = "anywhere";
  } else {
    const shown = f.areas.slice(0, maxAreas).map((a) => cityForArea(a) || a);
    const rest = f.areas.length - shown.length;
    places = shown.join(", ") + (rest > 0 ? ` +${rest} more` : "");
  }

  return beds ? `${beds} · ${places}` : places;
}

/**
 * How the filter was chosen, for admin display. A radius filter names the
 * search that produced the areas ("Radius: 15 mi from LE67"); anything else —
 * including every filter set before 0094 recorded the mode — is hand-picked.
 */
export function filterKindLabel(f: LeadFilterView): string {
  if (f.selectionMode === "radius" && f.radiusOutcode && f.radiusMiles) {
    return `Radius: ${f.radiusMiles} mi from ${f.radiusOutcode}`;
  }
  return "Hand-picked areas";
}

/** "£21.43" from 2143. */
export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** Untruncated description for a title attribute. */
export function filterTooltip(f: LeadFilterView): string {
  const parts = [
    `${f.label} lead filter`,
    `Bedrooms: ${bedroomPhrase(f.minBedrooms, f.maxBedrooms)}`,
    `Locations: ${locationText(f.areas)}`,
    `Set by: ${filterKindLabel(f)}`,
  ];
  if (f.expectedLeads != null && f.forecastCostPerLeadPence != null) {
    parts.push(
      `Forecast: at least ${f.expectedLeads}/month at ${formatPence(f.forecastCostPerLeadPence)} a lead` +
        (f.forecastLikelihoodPct != null
          ? ` (${f.forecastLikelihoodPct}% likely)`
          : "")
    );
  }
  if (f.status === "pending_lift") {
    parts.push(
      f.liftDate ? `Lift scheduled for ${f.liftDate}` : "Lift scheduled"
    );
  }
  return parts.join("\n");
}
