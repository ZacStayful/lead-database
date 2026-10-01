/**
 * How a reviewed batch is converting (§73). Server component; figures only.
 *
 * ⚠️ The benchmark is a long-run average and a single month rarely meets it,
 * because most deals close after the month ends. So the LIFETIME rate is the
 * one set against it, and the batch figures are shown as counts and rates with
 * no verdict attached. Wording is "benchmark", never a promise (§28.0).
 */
import { formatRate, rate } from "@/lib/batchReview/metrics";
import type { ReviewResults } from "@/lib/batchReview/review";
import { cycleLabel } from "@/lib/batchReview/settings";

function Tile({ label, count, of }: { label: string; count: number; of: number }) {
  return (
    <div className="rounded-lg border-[0.5px] border-border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{count}</p>
      <p className="text-xs text-muted-foreground">{formatRate(rate(count, of))} of {of}</p>
    </div>
  );
}

export function BatchReviewResults({
  results,
  productLabel,
}: {
  results: ReviewResults;
  productLabel: string;
}) {
  const { counts, benchmark } = results;
  const position =
    benchmark.position === "above"
      ? "above"
      : benchmark.position === "below"
        ? "below"
        : benchmark.position === "level"
          ? "level with"
          : null;
  return (
    <section className="space-y-4 rounded-lg border-[0.5px] border-border bg-muted/30 p-4">
      <h2 className="text-sm font-medium">How this batch is going</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Interested" count={counts.interested} of={counts.delivered} />
        <Tile label="Meetings booked" count={counts.meetings} of={counts.delivered} />
        <Tile label="Likely to sign later" count={counts.likelyLater} of={counts.delivered} />
        <Tile label="Signed" count={counts.signed} of={counts.delivered} />
      </div>
      <p className="text-sm leading-relaxed">
        Across all your {productLabel.toLowerCase()} leads you have signed {results.lifetimeSigned} of{" "}
        {results.lifetimeReceived} ({formatRate(benchmark.lifetimeRate)}).{" "}
        {position
          ? `That is ${position} the ${formatRate(benchmark.benchmark)} benchmark, which is the long-run average across operators.`
          : `The benchmark is ${formatRate(benchmark.benchmark)} over the long run; there are too few leads yet to compare against it.`}{" "}
        Most deals close after the month the lead arrived, so one batch on its own will usually read lower.
      </p>
      {counts.notCalled > 0 && (
        <p className="text-sm text-muted-foreground">
          {counts.notCalled} lead{counts.notCalled === 1 ? " has" : "s have"} not been called yet. Leads rung in
          their first few days convert best.
        </p>
      )}
      {results.trend.length > 1 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Your earlier batches</p>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 font-medium">Batch</th>
                <th className="py-1 text-right font-medium">Leads</th>
                <th className="py-1 text-right font-medium">Interested</th>
                <th className="py-1 text-right font-medium">Meetings</th>
                <th className="py-1 text-right font-medium">Signed</th>
              </tr>
            </thead>
            <tbody>
              {results.trend.map((t) => (
                <tr key={t.cycleEnd} className="border-t-[0.5px] border-border">
                  <td className="py-1">{cycleLabel(t.cycleStart, t.cycleEnd)}</td>
                  <td className="py-1 text-right">{t.delivered}</td>
                  <td className="py-1 text-right">{t.interested}</td>
                  <td className="py-1 text-right">{t.meetings}</td>
                  <td className="py-1 text-right">{t.signed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
