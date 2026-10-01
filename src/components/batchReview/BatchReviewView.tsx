/**
 * The body of a monthly batch review (§73), shared by the one-tap link page and
 * the dashboard page so the two cannot drift. Server component.
 */
import { BatchReviewForm } from "./BatchReviewForm";
import { BatchReviewResults } from "./BatchReviewResults";
import { answersFor } from "@/lib/batchReview/answers";
import type { LoadedReview, ReviewResults } from "@/lib/batchReview/review";
import { cycleLabel } from "@/lib/batchReview/settings";
import { isShortfall, shortfallSummaryLine } from "@/lib/batchReview/shortfall";

export function BatchReviewView({
  loaded,
  results,
  productLabel,
  submitUrl,
  leadHrefBase,
}: {
  loaded: LoadedReview;
  results: ReviewResults | null;
  productLabel: string;
  submitUrl: string;
  leadHrefBase: string;
}) {
  const { review, items } = loaded;
  const submitted = review.submitted_at != null;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">
          Your {productLabel.toLowerCase()} leads, {cycleLabel(review.cycle_start, review.cycle_end)}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {items.length} lead{items.length === 1 ? "" : "s"}. Tap where each one got to; anything already in your
          pipeline is filled in. Your answers update your pipeline.
        </p>
        {isShortfall({
          allocation: review.allocation,
          delivered: review.delivered,
          balance_at_reset: review.balance_at_reset,
        }) && (
          <p className="mt-2 text-sm">
            {shortfallSummaryLine({
              allocation: review.allocation,
              delivered: review.delivered,
              balance_at_reset: review.balance_at_reset,
            })}
          </p>
        )}
      </div>
      {submitted && results && <BatchReviewResults results={results} productLabel={productLabel} />}
      <BatchReviewForm
        items={items}
        options={answersFor(review.lead_type)}
        submitUrl={submitUrl}
        leadHrefBase={leadHrefBase}
        initialRating={review.quality_rating}
        initialComment={review.comment}
        submitted={submitted}
      />
    </div>
  );
}
