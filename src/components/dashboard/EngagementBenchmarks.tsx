import { Card, CardContent } from "@/components/ui/card";
import type { LeadType } from "@/lib/types";

/**
 * How the customer's own lead-handling compares to other operators, over a
 * rolling 90 days.
 *
 * Framed as help, not a scorecard. These are habits somebody can change this
 * afternoon — open the lead, ring the number — so the copy points at the next
 * action rather than grading past performance. Nothing here is a league table
 * and nothing identifies another operator.
 *
 * Win rate is deliberately absent: it is self-reported, so comparing it would
 * measure how diligently people update a dropdown rather than how well they
 * sell.
 */

export type BenchmarkRow = {
  lead_type: LeadType;
  metric: "open_rate" | "contact_rate" | "hours_to_first_attempt";
  own_value: number | null;
  own_sample: number;
  cohort_median: number | null;
  cohort_top_quartile: number | null;
  cohort_size: number;
  suppressed: boolean;
};

const METRIC_LABEL: Record<BenchmarkRow["metric"], string> = {
  open_rate: "Leads opened",
  contact_rate: "Leads you tried to contact",
  hours_to_first_attempt: "Typical time to first attempt",
};

const METRIC_HELP: Record<BenchmarkRow["metric"], string> = {
  open_rate: "How often you open a lead you've been sent.",
  contact_rate:
    "How often you click through to call or email the landlord.",
  hours_to_first_attempt:
    "How long a lead usually waits before you first try to reach them.",
};

const PRODUCT_LABEL: Record<LeadType, string> = {
  management: "Management",
  guaranteed_rent: "Guaranteed Rent",
};

function formatValue(
  metric: BenchmarkRow["metric"],
  value: number | null
): string {
  if (value === null || value === undefined) return "—";
  if (metric === "hours_to_first_attempt") {
    const h = Number(value);
    if (h < 1) return `${Math.round(h * 60)} min`;
    if (h < 48) return `${h.toFixed(1)} hrs`;
    return `${(h / 24).toFixed(1)} days`;
  }
  return `${Math.round(Number(value) * 100)}%`;
}

export function EngagementBenchmarks({
  rows,
  telemetryFrom,
}: {
  rows: BenchmarkRow[];
  telemetryFrom: string | null;
}) {
  // Only show a product the customer has actually received leads for — an empty
  // Guaranteed Rent table tells a management-only customer nothing.
  const products = (["management", "guaranteed_rent"] as LeadType[]).filter(
    (p) => rows.some((r) => r.lead_type === p && r.own_sample > 0)
  );

  if (products.length === 0) return null;

  const since = telemetryFrom
    ? new Date(telemetryFrom).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="mb-1 text-lg font-semibold">How you compare</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Your lead-handling habits alongside other operators on the platform,
          over the last 90 days. Nobody else can see your figures.
          {since ? ` Measured from ${since}, when this tracking started.` : ""}
        </p>

        {products.map((product) => {
          const productRows = rows.filter((r) => r.lead_type === product);
          const suppressed = productRows.every((r) => r.suppressed);

          return (
            <div key={product} className="mt-6 first:mt-0">
              {products.length > 1 && (
                <h3 className="mb-2 text-sm font-medium">
                  {PRODUCT_LABEL[product]}
                </h3>
              )}

              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b-[0.5px] border-border text-left">
                      <th className="pb-2 font-medium">Measure</th>
                      <th className="pb-2 text-right font-medium">You</th>
                      <th className="pb-2 text-right font-medium">
                        Typical operator
                      </th>
                      <th className="pb-2 text-right font-medium">
                        Best quarter
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {productRows.map((r) => (
                      <tr
                        key={r.metric}
                        className="border-b-[0.5px] border-border last:border-0"
                      >
                        <td className="py-2.5">
                          <span className="font-medium">
                            {METRIC_LABEL[r.metric]}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {METRIC_HELP[r.metric]}
                          </span>
                        </td>
                        <td className="py-2.5 text-right font-semibold">
                          {formatValue(r.metric, r.own_value)}
                        </td>
                        <td className="py-2.5 text-right text-muted-foreground">
                          {formatValue(r.metric, r.cohort_median)}
                        </td>
                        <td className="py-2.5 text-right text-muted-foreground">
                          {formatValue(r.metric, r.cohort_top_quartile)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Say plainly why cells are empty rather than leaving blanks and
                  letting people invent an explanation. The two reasons are
                  different and the wording must not conflate them: "we haven't
                  measured you yet" is not the same as "we can't compare you
                  yet", and claiming your figures are accurate when they are
                  blank would just be untrue. */}
              {suppressed && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {productRows.every((r) => r.own_value === null)
                    ? "We've only just started measuring this, so there's nothing meaningful to show yet. It'll fill in over the next few weeks as you work your leads."
                    : "There aren't enough other operators with comparable activity yet to show a fair comparison, so those columns are blank. Your own figures above are accurate."}
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
