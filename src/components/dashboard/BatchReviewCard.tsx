import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cycleLabel } from "@/lib/batchReview/settings";

/**
 * The dashboard half of the monthly batch review (§73). Shown on the home page
 * while a review has been sent, is unanswered and its link has not expired.
 *
 * Deliberately not dismissable. It goes when the review is answered or the
 * link expires, and that was the decision: a card that can be waved away is a
 * card that is, and the review is the only place the month's leads get looked
 * at as a batch.
 */
export function BatchReviewCard({
  reviewId,
  productLabel,
  cycleStart,
  cycleEnd,
  delivered,
}: {
  reviewId: string;
  productLabel: string | null;
  cycleStart: string;
  cycleEnd: string;
  delivered: number;
}) {
  return (
    <div className="rounded-xl border-[0.5px] border-brand/40 bg-brand/5 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-brand">
        Monthly review{productLabel ? ` · ${productLabel}` : ""}
      </p>
      <h2 className="mt-1 text-base font-semibold">
        Review your leads from {cycleLabel(cycleStart, cycleEnd)}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {delivered} lead{delivered === 1 ? "" : "s"}, one tap each. About 2 minutes, and it updates your pipeline.
      </p>
      <Button asChild className="mt-3 h-[38px] rounded-lg bg-brand font-semibold text-white hover:bg-brand-dark">
        <Link href={`/dashboard/review/${reviewId}`}>Review my leads →</Link>
      </Button>
    </div>
  );
}
