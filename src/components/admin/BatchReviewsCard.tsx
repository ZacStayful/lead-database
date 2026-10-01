import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { countAnswers, formatRate, rate } from "@/lib/batchReview/metrics";
import { cycleLabel } from "@/lib/batchReview/settings";
import { isShortfall, shortfallCause } from "@/lib/batchReview/shortfall";
import type { AdminReview } from "@/lib/batchReview/adminStats";
import type { BatchAnswer } from "@/lib/batchReview/answers";

export type CustomerBatchReview = AdminReview & {
  items: { answer: BatchAnswer | null }[] | null;
};

const CAUSE = { hold: "their hold", filter: "their filter", supply: "our supply" } as const;

/**
 * One customer's monthly batch reviews (§73): each month's figures, what they
 * said, and whether the month came up short and why.
 *
 * Renders nothing until the first month is recorded. An empty card is noise
 * (the FilterReleasesCard rule).
 */
export function BatchReviewsCard({ reviews }: { reviews: CustomerBatchReview[] }) {
  if (reviews.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Monthly lead reviews</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {reviews.map((r) => {
          const c = countAnswers(r.delivered, (r.items ?? []).map((i) => i.answer));
          const short = isShortfall(r);
          return (
            <div key={r.id} className="rounded-md border-[0.5px] border-border p-3 text-sm">
              <p className="font-medium">
                {r.lead_type === "guaranteed_rent" ? "GR" : "Mgmt"} · {cycleLabel(r.cycle_start, r.cycle_end)} ·{" "}
                {r.delivered} of {r.allocation} delivered
                {short ? `, ${r.balance_at_reset} owed (${CAUSE[shortfallCause(r)]})` : ""}
              </p>
              {r.submitted_at ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Called {c.called} · interested {c.interested} ({formatRate(rate(c.interested, c.delivered))}) ·
                  meetings {c.meetings} · likely later {c.likelyLater} · signed {c.signed}
                  {r.quality_rating != null ? ` · rated ${r.quality_rating}/5` : ""}
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {r.survey_sent_at ? "Review sent, not answered yet." : "Review not sent yet."}
                </p>
              )}
              {r.comment && <p className="mt-1 whitespace-pre-wrap text-xs">&ldquo;{r.comment}&rdquo;</p>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
