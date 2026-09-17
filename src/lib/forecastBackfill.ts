import { activeLeadFilters } from "@/lib/leadFilter";
import {
  predictMonthlyVolume,
  type AreaContention,
  type LeadVolumeAggregate,
} from "@/lib/filterPrediction";
import { forecastVolume, type VolumeForecast } from "@/lib/filterForecast";
import type { Customer, LeadType } from "@/lib/types";

/**
 * Filling in the stored forecast for a filter that never got one (§58).
 *
 * The apply route writes five columns per product when a filter is applied —
 * the figure the customer was SHOWN, which §28.7 deliberately never recomputes.
 * Two populations have no figure at all: filters applied before 0100 (23 Aug
 * 2026), when the columns did not exist, and filters applied while the lead
 * book could not be read. Six of the nine active filters on production when
 * this was written. For them the saved-filter view rendered no cost per lead,
 * no likelihood and no cheaper-plan advice, on any day.
 *
 * This is the decision, pure, for one customer and one product:
 *
 *   - it writes ONLY where nothing is stored — a figure the customer read is
 *     never overwritten by today's, which is §28.7's rule and stays so;
 *   - it writes exactly the five figure columns the apply route writes, from
 *     the same `forecastVolume()` it uses, so the two cannot disagree;
 *   - it NEVER writes `filter_forecast_acknowledged_at`. That column means
 *     "the customer ticked to say they had read this figure", and they did not.
 *     The panel labels a stored-but-unacknowledged figure accordingly.
 */

export type ForecastBackfillDecision =
  | { outcome: "write"; columns: Record<string, number>; forecast: VolumeForecast }
  | { outcome: "skip"; reason: string };

/** The five stored-figure columns, per product. Mirrors cols() in the apply route. */
export function forecastFigureColumns(leadType: LeadType) {
  const prefix = leadType === "guaranteed_rent" ? "gr_" : "";
  return {
    expectedLeads: `${prefix}filter_expected_leads`,
    forecastEstimate: `${prefix}filter_forecast_estimate`,
    forecastLikelihood: `${prefix}filter_forecast_likelihood_pct`,
    forecastCostPence: `${prefix}filter_forecast_cost_per_lead_pence`,
    forecastPricePence: `${prefix}filter_forecast_plan_price_pence`,
  } as const;
}

export function forecastBackfillFor(
  customer: Customer,
  leadType: LeadType,
  aggregate: LeadVolumeAggregate,
  contention: AreaContention | null
): ForecastBackfillDecision {
  const filter = activeLeadFilters(customer).find((f) => f.leadType === leadType);
  if (!filter) return { outcome: "skip", reason: "filter_off" };
  if (filter.expectedLeads != null) {
    return { outcome: "skip", reason: "already_stored" };
  }

  const allocation =
    leadType === "guaranteed_rent"
      ? (customer.gr_monthly_allocation ?? 0)
      : (customer.monthly_allocation ?? 0);

  const prediction = predictMonthlyVolume(
    aggregate[leadType],
    {
      areas: filter.areas,
      minBedrooms: filter.minBedrooms,
      maxBedrooms: filter.maxBedrooms,
    },
    contention
  );
  const forecast = forecastVolume(prediction, allocation, leadType);
  if (!forecast.offerable || forecast.costPerLeadPence == null) {
    return {
      outcome: "skip",
      reason: `not_offerable:${forecast.reason ?? "unknown"}`,
    };
  }

  const c = forecastFigureColumns(leadType);
  return {
    outcome: "write",
    forecast,
    columns: {
      [c.expectedLeads]: forecast.expected,
      [c.forecastEstimate]: forecast.estimate,
      [c.forecastLikelihood]: forecast.likelihoodPct ?? 0,
      [c.forecastCostPence]: forecast.costPerLeadPence,
      [c.forecastPricePence]: forecast.planPricePence,
    },
  };
}
