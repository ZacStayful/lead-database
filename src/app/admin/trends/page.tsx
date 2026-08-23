import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import {
  COVERAGE_FLOOR,
  deltaAvailable,
  getActivitySeries,
  getCommercialSeries,
  isMonthCovered,
  type ActivityMonth,
  type CommercialMonth,
} from "@/lib/monthlySeries";
import { poundsFromPence } from "@/lib/mrr";

export const dynamic = "force-dynamic";

/**
 * Admin → Trends.
 *
 * Month over month: what the customer base is worth, and what operators
 * actually did. Built on the thesis that platform activity predicts retention
 * and therefore lifetime value.
 *
 * ⚠️ TWO SECTIONS, NEVER ONE TABLE. The figures are keyed differently — income
 * and cohort figures are read as-of-now and drift, activity figures settle when
 * the month ends — and on live data the two halves currently tell OPPOSITE
 * stories. See the header of src/lib/monthlySeries.ts.
 *
 * ⚠️ THE THESIS IS NOT TESTED HERE, and there is deliberately no correlation
 * panel. Zero customers have ever cancelled, so retention has nothing to fit
 * against — the position get_customer_risk() and pauseOutlook.ts already take.
 * An empty correlation chart is "You: 0%, Typical operator: 0%" (§10) in a
 * different costume. This page accumulates the evidence that makes the thesis
 * testable; it does not claim to have tested it.
 *
 * A new page rather than a block on /admin/outcomes, which is headed "what
 * happened to the leads after they were sold" — revenue and cancellations are
 * not about leads, and a page whose heading no longer describes it is a page
 * nobody trusts.
 */

function gbp(pence: number): string {
  return `£${poundsFromPence(pence).toLocaleString("en-GB")}`;
}

function monthLabel(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function Pill({ tone, children }: { tone: "open" | "thin" | "ok"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "bg-brand/10 text-brand"
      : tone === "open"
        ? "bg-amber-50 text-amber-800"
        : "bg-black/[0.06] text-muted-foreground";
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
}

export default async function AdminTrendsPage() {
  // Fetched independently: an unapplied migration must cost one section, not
  // the page. Same reasoning as getPauseInsight.
  const [commercial, activity] = await Promise.all([
    getCommercialSeries(),
    getActivitySeries(),
  ]);

  const completeMonths = commercial.months.filter((m) => m.complete).length;
  const coveredMonths = activity.months.filter(isMonthCovered).length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Trends</h1>
        <p className="text-sm text-muted-foreground">
          Month over month: what the customer base is worth, and what operators
          did with what they were sent.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Income by month</h2>
          <p className="text-sm text-muted-foreground">
            Committed revenue, captured — not cash collected
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Priced from each customer&apos;s plan and status, the same arithmetic
          the Overview tile shows, captured daily so the month closes with a
          real reading. Deliberately not built on the payments table, which is
          known incomplete and understates the longest-standing customers worst.
          Paused revenue is listed beside the total and never added to it.
        </p>

        {commercial.unavailable ? (
          <Card>
            <CardContent className="p-5 text-sm text-muted-foreground">
              The income series could not be read. This normally means the
              migration for this feature has not been applied to this
              environment yet.
            </CardContent>
          </Card>
        ) : commercial.months.length === 0 ? (
          <Card>
            <CardContent className="p-5 text-sm text-muted-foreground">
              Nothing captured yet. The first row is written by the daily
              escalation cron; until then there is no month to show.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-normal">Month</th>
                      <th className="px-4 py-2 font-normal">Management</th>
                      <th className="px-4 py-2 font-normal">Guaranteed rent</th>
                      <th className="px-4 py-2 font-normal">Total</th>
                      <th className="px-4 py-2 font-normal">Paused</th>
                      <th className="px-4 py-2 font-normal">Billed</th>
                      <th className="px-4 py-2 font-normal">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {commercial.months.map((m: CommercialMonth) => (
                      <tr key={m.monthStart} className="border-b-[0.5px] border-border last:border-0">
                        <td className="px-4 py-2.5 font-medium">{monthLabel(m.monthStart)}</td>
                        <td className="px-4 py-2.5 tabular-nums">{gbp(m.managementMrrPence)}</td>
                        <td className="px-4 py-2.5 tabular-nums">{gbp(m.grMrrPence)}</td>
                        <td className="px-4 py-2.5 tabular-nums font-medium">{gbp(m.totalMrrPence)}</td>
                        <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                          {m.pausedMrrPence > 0 ? gbp(m.pausedMrrPence) : "—"}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">{m.customersBilled}</td>
                        <td className="px-4 py-2.5">
                          {m.complete ? (
                            <Pill tone="ok">Closed</Pill>
                          ) : (
                            <Pill tone="open">
                              In progress · {m.capturedDays} day
                              {m.capturedDays === 1 ? "" : "s"} captured
                            </Pill>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Activity by month</h2>
          <p className="text-sm text-muted-foreground">
            What operators did, in the month they did it
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Counted when the activity happened, so these settle once a month ends
          and never move again. That makes them the figures worth comparing
          month to month — unlike the conversion table on{" "}
          <Link href="/admin/outcomes" className="underline">
            Outcomes
          </Link>
          , which is keyed on when a lead was <em>delivered</em> and keeps
          drifting upward as old leads are worked.
        </p>

        {activity.unavailable ? (
          <Card>
            <CardContent className="p-5 text-sm text-muted-foreground">
              The activity series could not be read. This normally means the
              migration for this feature has not been applied yet.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-normal">Month</th>
                      <th className="px-4 py-2 font-normal">Leads opened</th>
                      <th className="px-4 py-2 font-normal">Opens</th>
                      <th className="px-4 py-2 font-normal">Contact clicks</th>
                      <th className="px-4 py-2 font-normal">Notes</th>
                      <th className="px-4 py-2 font-normal">Stage changes</th>
                      <th className="px-4 py-2 font-normal">Operators active</th>
                      <th className="px-4 py-2 font-normal">Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.months.map((m: ActivityMonth) => {
                      const covered = isMonthCovered(m);
                      return (
                        <tr key={m.monthStart} className="border-b-[0.5px] border-border last:border-0">
                          <td className="px-4 py-2.5 font-medium">{monthLabel(m.monthStart)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{m.leadsOpened}</td>
                          <td className="px-4 py-2.5 tabular-nums">{m.opens}</td>
                          <td className="px-4 py-2.5 tabular-nums">{m.contactClicks}</td>
                          <td className="px-4 py-2.5 tabular-nums">{m.notesAdded}</td>
                          <td className="px-4 py-2.5 tabular-nums">
                            {m.stageEventsAvailable ? (
                              m.stageChanges
                            ) : (
                              <span className="text-muted-foreground">not recorded</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums font-medium">{m.customersActive}</td>
                          <td className="px-4 py-2.5">
                            {covered ? (
                              <Pill tone="ok">Full month</Pill>
                            ) : (
                              <Pill tone="open">
                                {m.activityDaysCovered} of {m.daysInMonth} days
                              </Pill>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          A month is marked partial until telemetry covers at least{" "}
          {Math.round(COVERAGE_FLOOR * 100)}% of its days. Lead events begin on
          27 July 2026, so July carries only a few covered days and its figures
          are a floor, not a count — comparing it with a full month overstates
          the improvement. Stage changes were not recorded at all before the
          migration that added them, which is why an earlier month reads
          &ldquo;not recorded&rdquo; rather than zero. Opening is counted from
          the lead page only, so this will not match the leaderboard, which also
          counts expanding a card in the feed.
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">What this does not yet show</h2>
        <Card>
          <CardContent className="space-y-3 p-5 text-sm text-muted-foreground">
            <p>
              {deltaAvailable(completeMonths) ? (
                <>
                  There are {completeMonths} closed months of income, so
                  month-on-month movement is now meaningful.
                </>
              ) : (
                <>
                  <span className="font-medium text-foreground">
                    Month-on-month movement is not shown yet.
                  </span>{" "}
                  It needs two closed months and there {completeMonths === 1 ? "is" : "are"}{" "}
                  {completeMonths}. One reading is not a trend, and a two-point
                  line on this data would read as a change that is really just a
                  young month.
                </>
              )}{" "}
              {coveredMonths < 2 && (
                <>
                  The activity series has {coveredMonths} fully covered month
                  {coveredMonths === 1 ? "" : "s"} for the same reason.
                </>
              )}
            </p>
            <p>
              <span className="font-medium text-foreground">
                No lifetime value, and no link between activity and retention.
              </span>{" "}
              No customer has ever cancelled, so there is nothing to measure
              retention against and any figure would be an assertion rather than
              a measurement. Cancellations are now recorded as durable episodes,
              so the question becomes answerable the first time somebody leaves
              — that is what this page is accumulating.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
