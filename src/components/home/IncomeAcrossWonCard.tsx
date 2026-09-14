import { formatRangeGbp, type IncomeAcrossWon } from "@/lib/home/incomeAcrossWon";
import { CardTitleRow, HomeCard } from "./HomeCard";

/** Stayful's projection summed across signed management landlords (§56.7). */
export function IncomeAcrossWonCard({ data }: { data: IncomeAcrossWon }) {
  const p = data.projection;
  return (
    <HomeCard>
      <CardTitleRow title="Income projection" />
      <p className="mt-0.5 text-[13px] text-ink-2">
        Across your {data.signed} signed {data.signed === 1 ? "landlord" : "landlords"}
        {data.withFigures < data.signed && ` (${data.withFigures} with an analysis)`}
      </p>
      <div className="mt-3.5 grid grid-cols-2 gap-3.5">
        <div className="rounded-[10px] bg-[#f7f9f7] p-3.5">
          <div className="text-xs text-ink-2">Est. gross income</div>
          <div className="mt-1 font-display text-[22px] font-semibold leading-tight">
            {formatRangeGbp(p.grossAnnualLow, p.grossAnnualHigh)}
          </div>
          <div className="text-xs text-ink-2">a year</div>
        </div>
        <div className="rounded-[10px] bg-brand-light p-3.5 text-brand-dark">
          <div className="text-xs">Your management fee</div>
          <div className="mt-1 font-display text-[22px] font-semibold leading-tight">
            {formatRangeGbp(p.feeAnnualLow, p.feeAnnualHigh)}
          </div>
          <div className="text-xs">a year at 15%</div>
        </div>
      </div>
      <p className="mt-3 text-xs text-ink-2">
        Stayful&rsquo;s short-term-let projection for each property, shown 10% either side of the estimate.
      </p>
    </HomeCard>
  );
}
