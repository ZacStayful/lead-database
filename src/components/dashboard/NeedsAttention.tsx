import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { STALLED_AFTER_DAYS, type WorkSummary } from "@/lib/workSummary";
import { formatDate } from "@/lib/utils";

/**
 * Leads the operator has already started and left unfinished.
 *
 * This is the one block on the dashboard that names a number of THINGS rather
 * than a rate, because both figures point at a specific lead that can be picked
 * up this afternoon. A percentage tells somebody how they are doing; "four
 * callbacks are overdue" tells them what to do next.
 *
 * Tone matters more than usual here. These are leads the operator DID work —
 * they rang, they wrote the date down — so the copy treats an overdue callback
 * as a loose end rather than a failing. Nothing in this block is comparative
 * and nothing mentions other operators; the proof block above already covers
 * that, and stacking a nudge on top of a comparison reads as an accusation.
 *
 * Renders nothing when there is nothing outstanding, which is the good outcome
 * and should look like one — an empty "well done" card would just be noise on
 * every load for the operators who are on top of things.
 */
export function NeedsAttention({ summary }: { summary: WorkSummary }) {
  const { overdueCallbacks, oldestCallbackDate, stalledLeads } = summary;

  if (overdueCallbacks === 0 && stalledLeads === 0) return null;

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="mb-1 text-lg font-semibold">Picked up and left</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Leads you&rsquo;ve already started. These are the shortest route to a
          conversation — the first call is the hard part and it&rsquo;s done.
        </p>

        <div className="space-y-3">
          {overdueCallbacks > 0 && (
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <Link
                  href="/dashboard/leads/priority"
                  className="font-medium underline underline-offset-4"
                >
                  {overdueCallbacks === 1
                    ? "1 callback is past its date"
                    : `${overdueCallbacks} callbacks are past their date`}
                </Link>
                <span className="block text-xs text-muted-foreground">
                  {oldestCallbackDate
                    ? `You set the earliest for ${formatDate(oldestCallbackDate)}.`
                    : "You set a date to ring these landlords back."}
                </span>
              </div>
            </div>
          )}

          {stalledLeads > 0 && (
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <Link
                  href="/dashboard/leads"
                  className="font-medium underline underline-offset-4"
                >
                  {stalledLeads === 1
                    ? "1 lead hasn't moved in a fortnight"
                    : `${stalledLeads} leads haven't moved in a fortnight`}
                </Link>
                <span className="block text-xs text-muted-foreground">
                  Contacted, then nothing recorded for{" "}
                  {STALLED_AFTER_DAYS} days or more. If one of these is done,
                  marking it closes it off.
                </span>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
