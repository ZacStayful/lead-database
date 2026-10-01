/**
 * The body of a monthly batch review (§73), shared by the one-tap link page and
 * the dashboard page so the two cannot drift. Server component.
 */
import { BatchReviewForm } from "./BatchReviewForm";
import { BatchReviewResults } from "./BatchReviewResults";
import { answersFor } from "@/lib/batchReview/answers";
import type { LoadedReview, ReviewResults } from "@/lib/batchReview/review";
import { cycleLabel, longDate } from "@/lib/batchReview/settings";
import { isShortfall, nextDue, nextGrant, shortfallSummaryLine } from "@/lib/batchReview/shortfall";
import { OUTCOME_LABEL } from "@/lib/batchReview/replacements";
import type { LeadSummary, ReplacementView } from "@/lib/batchReview/review";
import { REPLACEMENT_PATH } from "@/lib/quality/replacementEntitlement";

function describe(l: LeadSummary): string {
  const beds = l.bedrooms ? (Number.isFinite(Number(l.bedrooms)) ? `${Number(l.bedrooms)} bed` : l.bedrooms) : null;
  const meta = [l.postcodeArea, beds].filter(Boolean).join(" · ");
  return meta ? `${l.name} (${meta})` : l.name;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Leads the customer reported in this batch, and what came of each (§73.8).
 * Only their own reports, never a Stayful-pipeline withdrawal (§64's decision
 * that those are swapped without notice). See replacements.ts.
 */
function ReplacedSection({ replacements }: { replacements: ReplacementView[] }) {
  if (replacements.length === 0) return null;
  return (
    <section className="rounded-lg border-[0.5px] border-border bg-background p-4">
      <h2 className="text-sm font-medium">Leads you reported this month</h2>
      <ul className="mt-2 space-y-2">
        {replacements.map((r) => (
          <li key={r.claimId} className="text-sm">
            <p>
              <span className="font-medium">{describe(r.original)}</span>
              <span className="text-muted-foreground"> · {r.reasonLabel}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {OUTCOME_LABEL[r.outcome]}
              {r.replacement ? ` with ${describe(r.replacement)}` : ""}
              {r.note ? `: ${r.note}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What carries into the next month (§73.8).
 *
 * ⚠️ LEAD credits only, as a number. The replacement count is published on one
 * surface and nothing else restates it (§53.1), so it is linked, never quoted.
 */
function CarriedForward({
  balance,
  due,
  grant,
  nextStart,
  replacementHref,
}: {
  balance: number;
  due: number;
  grant: number;
  nextStart: string;
  replacementHref: string;
}) {
  return (
    <section className="rounded-lg border-[0.5px] border-border bg-background p-4 text-sm">
      <h2 className="font-medium">Carried forward</h2>
      <p className="mt-1">
        {balance > 0
          ? `${plural(balance, "lead credit")} carried into your month from ${longDate(nextStart)}, on top of ${plural(grant, "new lead")}: ${due} due in all.`
          : `Nothing carried forward: your month from ${longDate(nextStart)} starts with ${plural(grant, "new lead")}.`}{" "}
        Credits never expire.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Replacement credits carry over too. See them on{" "}
        <a href={replacementHref} className="underline">
          Replace a lead
        </a>
        .
      </p>
    </section>
  );
}

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
  const { review, items, replacements } = loaded;
  const grant = nextGrant(review);
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
      <CarriedForward
        balance={review.balance_at_reset}
        due={nextDue(review)}
        grant={grant}
        nextStart={review.cycle_end}
        replacementHref={REPLACEMENT_PATH}
      />
      {replacements && <ReplacedSection replacements={replacements} />}
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
