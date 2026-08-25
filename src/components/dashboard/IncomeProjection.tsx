import { formatGBP } from "@/lib/utils";
import {
  MANAGEMENT_FEE_LABEL,
  buildIncomeProjection,
  incomeBasis,
} from "@/lib/incomeProjection";
import type { LeadType } from "@/lib/types";

/**
 * Stayful's projected gross income for a lead's property, and what it is worth
 * to the operator at a 15% management fee. Both as ranges 10% either side of
 * the estimate.
 *
 * ONE COMPONENT, THREE SURFACES — the expanded feed card, the lead detail page
 * and the expired-leads pool. An operator meets the same figure in the feed,
 * on the page they work the lead from and on the card where they decide
 * whether a pooled landlord is worth ringing, and a second implementation
 * would eventually show them two different numbers for the same property.
 *
 * THE REPORT ITSELF SITS BESIDE THIS, not inside it. IncomeReportLink is a
 * separate component on the same two surfaces (0092), because a lead can have a
 * stored PDF and no trustworthy figures, or figures and no stored PDF, and
 * folding them together would make each conditional on the other.
 *
 * Renders NOTHING without a parsed figure, rather than a zero or an em dash. A
 * lead with no analysis should look like a lead from before this existed, not
 * like a property worth nothing.
 *
 * ⚠️ THE FEE HALF IS MANAGEMENT ONLY, and it always was — this used to refuse
 * a Guaranteed Rent lead outright. A GR operator earns the margin between the
 * rent they pay and what the property makes, so a management fee is not their
 * revenue: showing it would be a WRONG number, not a missing one.
 *
 * What changed is that a GR lead can now HAVE figures. Nothing produced them
 * before — the Monday sweep is management-only — so refusing the whole
 * component cost nothing. Paid analysis (0104/0105) produces them for either
 * product, and gross income, nightly rate and occupancy are exactly as true for a
 * GR property as a management one: they are what the operator prices their
 * guaranteed rent against.
 *
 * So the fee half is suppressed for GR and the rest renders. Do not restore the
 * early return: it would silently hide figures a customer has paid for.
 */
export function IncomeProjection({
  lead,
  variant = "full",
  className,
}: {
  lead: {
    lead_type: LeadType;
    gross_annual_income: number | null;
    avg_nightly_rate: number | null;
    occupancy_rate: number | null;
  };
  variant?: "full" | "compact";
  className?: string;
}) {
  const p = buildIncomeProjection(lead);
  if (!p) return null;

  // See the header: the fee is what a MANAGEMENT operator earns.
  const showFee = lead.lead_type === "management";

  const grossYear = `${formatGBP(p.grossAnnualLow)} – ${formatGBP(p.grossAnnualHigh)}`;
  const grossMonth = `${formatGBP(p.grossMonthlyLow)} – ${formatGBP(p.grossMonthlyHigh)}`;
  const feeYear = `${formatGBP(p.feeAnnualLow)} – ${formatGBP(p.feeAnnualHigh)}`;
  const feeMonth = `${formatGBP(p.feeMonthlyLow)} – ${formatGBP(p.feeMonthlyHigh)}`;

  // The nightly rate and occupancy the report states (0090).
  //
  // TWO WORDINGS, ONE RULE. Where rate x 365 x occupancy actually produces the
  // gross above, the pair IS what that number is built from and gets said so.
  // Where it does not, the report's own caption is the honest reading — its
  // nightly rate is captioned "ADR across comp set", so on a property that
  // prices unlike its comparables the figures describe the comp set rather than
  // the projection. Both are worth an operator's attention; only one of them
  // can claim to explain the money above it.
  const b = incomeBasis(lead);
  const figures = b
    ? `${formatGBP(b.nightlyRate)} a night at ${b.occupancyPct}% occupancy`
    : null;

  if (variant === "compact") {
    return (
      <div className={className}>
        <p className="text-sm">
          <span className="text-muted-foreground">Est. gross</span>{" "}
          <span className="font-medium">{grossYear}</span>
          <span className="text-muted-foreground">
            {showFee ? " a year · your fee " : " a year"}
          </span>
          {showFee && <span className="font-medium">{feeYear}</span>}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {figures ? (
            <>
              {b?.reconciles ? "Based on" : "Comparable properties average"}{" "}
              {figures}.{" "}
            </>
          ) : null}
          {showFee ? (
            <>
              Fee assumes a {MANAGEMENT_FEE_LABEL}; both shown 10% either side of
              Stayful&rsquo;s estimate for this property.
            </>
          ) : (
            <>
              Shown 10% either side of Stayful&rsquo;s estimate for this property.
            </>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className={`rounded-md bg-muted/50 p-3 ${className ?? ""}`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs text-muted-foreground">Estimated gross income</p>
          <p className="mt-0.5 text-sm font-semibold">{grossYear} a year</p>
          <p className="text-xs text-muted-foreground">{grossMonth} a month</p>
        </div>
        {showFee && (
          <div>
            <p className="text-xs text-muted-foreground">
              What it earns a management company
            </p>
            <p className="mt-0.5 text-sm font-semibold">{feeYear} a year</p>
            <p className="text-xs text-muted-foreground">{feeMonth} a month</p>
          </div>
        )}
      </div>
      {figures && (
        <p className="mt-3 text-sm">
          <span className="text-muted-foreground">
            {b?.reconciles ? "Based on" : "Comparable properties average"}
          </span>{" "}
          <span className="font-medium">{figures}</span>
          <span className="text-muted-foreground">.</span>
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {showFee ? (
          <>
            Management revenue is based on a {MANAGEMENT_FEE_LABEL}. Gross is
            Stayful&rsquo;s short-term-let projection for this property, shown as a
            range 10% either side of the estimate.
          </>
        ) : (
          <>
            Gross is Stayful&rsquo;s short-term-let projection for this property,
            shown as a range 10% either side of the estimate. What you earn
            depends on the rent you guarantee, so no fee is shown.
          </>
        )}
      </p>
    </div>
  );
}
