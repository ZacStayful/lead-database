"use client";

import {
  GROSS_THRESHOLDS,
  canFilterByGross,
  formatGrossThreshold,
  type ProductVolume,
} from "@/lib/filterPrediction";
import type { LeadType } from "@/lib/types";

/**
 * The minimum projected gross annual revenue — the third filter dimension,
 * beside areas/radius and the bedroom range.
 *
 * The figure is §25's `leads.gross_annual_income`: what Stayful's own property
 * analysis projects the property would gross on a short let, in POUNDS. It is
 * the PROPERTY's revenue, never the operator's, and every string here says so —
 * "revenue" alone reads as the customer's own income, which is a different
 * number and not one we hold.
 *
 * ⚠️ MANAGEMENT ONLY, and it renders NOTHING — not a disabled control — for
 * guaranteed rent. All 291 GR leads carry no gross figure, because §25's
 * analysis is management-only by design, so a floor would match nothing at all.
 * There is no `gr_filter_min_gross` column for it to write to either.
 *
 * ⚠️ AND NOTHING WHEN THE SOURCE CANNOT ANSWER A REVENUE QUESTION.
 * `canFilterByGross` is false when `areaBedBandCounts` is null, which is what a
 * public payload built before 0158 yields — §18.3's three outcomes, never two.
 * The honest answer for the ≤6 hours between a deploy and the first cache
 * rebuild is to hide the dimension rather than quote zero against it, which is
 * §58.2's failure self-inflicted on a marketing page.
 */
export function RevenueFloor({
  idPrefix,
  product,
  volume,
  value,
  onChange,
}: {
  /**
   * ⚠️ Present for the reason `BedroomRange` has one: the dashboard scopes its
   * input ids by product and the estimator needs its own, and two mounted
   * copies sharing an id break the `htmlFor` label SILENTLY.
   */
  idPrefix: string;
  product: LeadType;
  volume: ProductVolume;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  if (product !== "management" || !canFilterByGross(volume)) return null;

  return (
    <div>
      <label
        htmlFor={`${idPrefix}-gross`}
        className="text-sm font-medium"
      >
        Minimum property revenue
      </label>
      <p className="text-xs text-muted-foreground">
        Only send leads where our analysis projects the property would gross at
        least this much a year on a short let. Leave it on Any to accept every
        lead.
      </p>
      <select
        id={`${idPrefix}-gross`}
        className="mt-2 h-10 w-full rounded-md border-[0.5px] border-input bg-background px-3 text-sm sm:max-w-[16rem]"
        value={value == null ? "" : String(value)}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : parseInt(e.target.value, 10))
        }
      >
        <option value="">Any</option>
        {GROSS_THRESHOLDS.map((t) => (
          <option key={t} value={String(t)}>
            {formatGrossThreshold(t)} a year or more
          </option>
        ))}
      </select>
      {value != null && (
        <p className="mt-1 text-xs text-muted-foreground">
          Leads we hold no revenue analysis for are excluded while a minimum is
          set.
        </p>
      )}
    </div>
  );
}
