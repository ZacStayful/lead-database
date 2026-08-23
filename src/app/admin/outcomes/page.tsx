import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import {
  getOutcomeOverview,
  getPauseInsight,
  getWorkedConversion,
} from "@/lib/outcomes";
import { formatDate, formatGBP } from "@/lib/utils";
import { pauseReasonLabel } from "@/lib/pauseOptions";
import {
  MATURITY_DAYS,
  WORKED_CONVERSION_FLOORS,
} from "@/lib/workedConversion";

const PAUSE_OUTCOME_LABEL: Record<string, string> = {
  active: "Still paused",
  resumed_retained: "Came back and stayed",
  resumed_then_left: "Came back, then left",
  left_during_pause: "Left during the pause",
  ended_untracked: "Ended (date not recorded)",
};

export const dynamic = "force-dynamic";

/**
 * Admin → Outcomes.
 *
 * Four tables that together answer "is this working": what has been won, how
 * customers compare, which recorded outcomes are not backed by anything the
 * operator actually did, and which landlords have been sold more than once.
 *
 * Wins lead, because they are the case-study material and the eventual
 * leaderboard. The review queue sits under them deliberately — a win is only
 * worth celebrating if it is real, and one of the three in production is not.
 */

const EVIDENCE_STYLE: Record<string, string> = {
  strong: "bg-brand/10 text-brand",
  partial: "bg-amber-50 text-amber-800",
  none: "bg-red-50 text-red-700",
};

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

/**
 * get_worked_conversion returns percentages already scaled 0-100, where the
 * scoreboard's rates are 0-1 fractions. Two helpers rather than one so neither
 * call site has to remember which shape it is holding.
 *
 * Null renders as an em dash, never 0% — a suppressed rate shown as zero is the
 * failure §10 named when it explained why benchmarks are withheld at launch
 * rather than displayed empty.
 */
function pct100(v: number | null): string {
  return v == null ? "—" : `${v}%`;
}

/** One figure in the conversion funnel. Mirrors the stat tiles on /admin. */
function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</dd>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function cohortLabel(month: string): string {
  const d = new Date(month);
  return isNaN(d.getTime())
    ? month
    : d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export default async function AdminOutcomesPage() {
  // Fetched independently: an unapplied 0077 must cost this one block, not the
  // whole page. See getPauseInsight.
  const [
    { unavailable, wins, scoreboard, needsReview, duplicates },
    pauses,
    conversion,
  ] = await Promise.all([
    getOutcomeOverview(),
    getPauseInsight(),
    getWorkedConversion(),
  ]);

  if (unavailable) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Outcomes</h1>
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">
            Outcome reporting could not be read. This normally means the database
            migration for this feature has not been applied to this environment
            yet.
          </CardContent>
        </Card>
      </div>
    );
  }

  const escalatedWins = wins.filter((w) => w.wasEscalated).length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Outcomes</h1>
        <p className="text-sm text-muted-foreground">
          What happened to the leads after they were sold.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {!conversion.unavailable && conversion.total && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">
            Do the leads convert when they are worked?
          </h2>
          <p className="text-sm text-muted-foreground">
            Both rates, always. The gap between them is the finding: leads an
            operator takes into their pipeline convert many times better than
            the book as a whole, and very few of them get that far. Either
            number on its own misleads in a different direction.
          </p>

          <Card>
            <CardContent className="p-5">
              <dl className="grid gap-4 sm:grid-cols-4">
              <Figure label="Delivered" value={String(conversion.total.delivered)} />
              <Figure
                label="Contacted"
                value={String(conversion.total.contacted)}
                note={pct100(
                  conversion.total.delivered > 0
                    ? Math.round(
                        (conversion.total.contacted /
                          conversion.total.delivered) *
                          1000
                      ) / 10
                    : null
                )}
              />
              <Figure
                label="Worked past cold"
                value={String(conversion.total.workedPastCold)}
                note={`win rate ${pct100(conversion.total.winRateWorked)}`}
              />
              <Figure
                label="Won"
                value={String(conversion.total.won)}
                note={`${pct100(conversion.total.winRateDelivered)} of delivered`}
              />
              </dl>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            &ldquo;Worked past cold&rdquo; means the operator moved the lead out
            of <span className="font-medium">cold</span> into their own
            pipeline. It is a different, smaller population than the{" "}
            <span className="font-medium">Worked</span> column in the scoreboard
            below, which counts any open, click, note or file. Advancing a stage
            without doing the work would enlarge this denominator and{" "}
            <em>depress</em> the rate, so it is conservative against padding —
            but an operator who works leads in their own CRM and never updates
            the stage is excluded from it entirely, which flatters it. Wins are
            self-reported: {conversion.corroboratedWins} of{" "}
            {conversion.total.won} carry strong supporting evidence.
          </p>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-normal">Cohort</th>
                      <th className="px-4 py-2 font-normal">Delivered</th>
                      <th className="px-4 py-2 font-normal">Contacted</th>
                      <th className="px-4 py-2 font-normal">Worked past cold</th>
                      <th className="px-4 py-2 font-normal">Won</th>
                      <th className="px-4 py-2 font-normal">Win rate of worked</th>
                      <th className="px-4 py-2 font-normal">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conversion.cohorts.map((c) => (
                      <tr
                        key={c.cohortMonth}
                        className="border-b-[0.5px] border-border last:border-0"
                      >
                        <td className="px-4 py-2.5 font-medium">
                          {cohortLabel(c.cohortMonth as string)}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">{c.delivered}</td>
                        <td className="px-4 py-2.5 tabular-nums">{c.contacted}</td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {c.workedPastCold}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums font-medium">
                          {c.won}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {pct100(c.winRateWorked)}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="flex flex-wrap gap-1">
                            {!c.mature && (
                              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                                Still open
                              </span>
                            )}
                            {c.thin && (
                              <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-xs text-muted-foreground">
                                Too few to read
                              </span>
                            )}
                            {c.mature && !c.thin && (
                              <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand">
                                Settled
                              </span>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            A cohort is <span className="font-medium">still open</span> until
            every lead in it is {MATURITY_DAYS} days old — wins have taken up to
            24 days, so a young cohort always understates itself and a raw
            month-on-month comparison reads as a collapse that is not there. It
            is <span className="font-medium">too few to read</span> below{" "}
            {WORKED_CONVERSION_FLOORS.minWorked} worked,{" "}
            {WORKED_CONVERSION_FLOORS.minWins} wins and{" "}
            {WORKED_CONVERSION_FLOORS.minOperators} operators, where the rate is
            withheld rather than shown. Leads are counted in the month they were
            delivered but their status is read today, so a cohort&rsquo;s rate
            can still rise after it settles.
          </p>
        </section>
      )}

      {/* ---------------------------------------------------------------- */}
      {!pauses.unavailable && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-medium">Why customers pause and leave</h2>
            <p className="text-sm text-muted-foreground">
              {pauses.total} pause{pauses.total === 1 ? "" : "s"} recorded ·{" "}
              {pauses.completed} finished
            </p>
          </div>

          {pauses.total === 0 ? (
            <Card>
              <CardContent className="p-5 text-sm text-muted-foreground">
                Nobody has paused yet. Reasons are captured from the moment
                someone does.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardContent className="space-y-2 p-5">
                  <p className="text-sm font-medium">Reasons given</p>
                  {/* Counts, not rates. A pause citing two reasons appears under
                      both, so these sum to more than the pause count. */}
                  <dl className="space-y-1 text-sm">
                    {pauses.reasonCounts.map((r) => (
                      <div key={r.reason} className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">
                          {pauseReasonLabel(r.reason)}
                        </dt>
                        <dd className="tabular-nums">{r.count}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="pt-1 text-xs text-muted-foreground">
                    A pause citing two reasons is counted under each, so these add
                    up to more than {pauses.total}.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="space-y-2 p-5">
                  <p className="text-sm font-medium">What happened next</p>
                  <dl className="space-y-1 text-sm">
                    {pauses.outcomeCounts.map((o) => (
                      <div key={o.outcome} className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">
                          {PAUSE_OUTCOME_LABEL[o.outcome] ?? o.outcome}
                        </dt>
                        <dd className="tabular-nums">{o.count}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>

              <Card className="md:col-span-2">
                <CardContent className="space-y-2 p-5">
                  <p className="text-sm font-medium">
                    Which reasons come back, and which do not
                  </p>
                  {pauses.crossTabSuppressed ? (
                    // Withheld rather than shown thin: below the threshold one
                    // customer moves a whole cell, and this block would read as a
                    // rate drawn from a handful of people.
                    <p className="text-sm text-muted-foreground">
                      Held back until more pauses have finished —{" "}
                      {pauses.completed} so far. Until then a single customer
                      would swing the whole picture, and this would read as a
                      pattern rather than an anecdote.
                    </p>
                  ) : (
                    <dl className="space-y-1 text-sm">
                      {pauses.crossTab.map((x) => (
                        <div
                          key={`${x.reason}-${x.outcome}`}
                          className="flex justify-between gap-4"
                        >
                          <dt className="text-muted-foreground">
                            {pauseReasonLabel(x.reason)} —{" "}
                            {PAUSE_OUTCOME_LABEL[x.outcome] ?? x.outcome}
                          </dt>
                          <dd className="tabular-nums">{x.count}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </CardContent>
              </Card>

              {(pauses.cancellationFeedback.length > 0 ||
                pauses.cancellationComments.length > 0) && (
                <Card className="md:col-span-2">
                  <CardContent className="space-y-2 p-5">
                    <p className="text-sm font-medium">
                      Reasons given when cancelling outright
                    </p>
                    <dl className="space-y-1 text-sm">
                      {pauses.cancellationFeedback.map((f) => (
                        <div key={f.feedback} className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">{f.feedback}</dt>
                          <dd className="tabular-nums">{f.count}</dd>
                        </div>
                      ))}
                    </dl>
                    {pauses.cancellationComments.map((c) => (
                      <p
                        key={c.businessName}
                        className="whitespace-pre-wrap text-sm italic text-muted-foreground"
                      >
                        {c.businessName}: {c.comment}
                      </p>
                    ))}
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </section>
      )}

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Wins</h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {wins.length} recorded
            {escalatedWins > 0 &&
              ` · ${escalatedWins} on a lead another operator ignored first`}
          </span>
        </div>
        <Card>
          <CardContent className="p-0">
            {wins.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                No wins recorded yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-normal">Customer</th>
                      <th className="px-4 py-2 font-normal">Landlord</th>
                      <th className="px-4 py-2 font-normal">Enquiry type</th>
                      <th className="px-4 py-2 font-normal">Days to win</th>
                      <th className="px-4 py-2 font-normal">Income est.</th>
                      <th className="px-4 py-2 font-normal">Won</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wins.map((w) => (
                      <tr
                        key={w.assignmentId}
                        className="border-b-[0.5px] border-border last:border-0"
                      >
                        <td className="px-4 py-2.5 font-medium">
                          {w.businessName}
                        </td>
                        <td className="px-4 py-2.5">
                          {w.leadName}
                          {w.wasEscalated && (
                            <span className="ml-2 rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand">
                              escalated
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {w.leadProfile ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {w.daysToWin ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {w.incomeEstimate ? formatGBP(w.incomeEstimate) : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {formatDate(w.wonAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Customer scoreboard</h2>
        <p className="text-sm text-muted-foreground">
          Several columns rather than one score, on purpose: the operator who
          converts best and the one who works hardest are rarely the same person,
          and a single ranking number would pick one without saying so.{" "}
          <span className="font-medium">Worked</span> is any activity at all;{" "}
          <span className="font-medium">Past cold</span> is the narrower
          measure the conversion figures above use.
        </p>
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-normal">Customer</th>
                    <th className="px-4 py-2 font-normal">Delivered</th>
                    <th className="px-4 py-2 font-normal">Worked</th>
                    <th className="px-4 py-2 font-normal">Past cold</th>
                    <th className="px-4 py-2 font-normal">Attempted</th>
                    <th className="px-4 py-2 font-normal">Wins</th>
                    <th className="px-4 py-2 font-normal">Win rate</th>
                    <th className="px-4 py-2 font-normal">Median days</th>
                  </tr>
                </thead>
                <tbody>
                  {scoreboard.map((r) => (
                    <tr
                      key={r.customerId}
                      className="border-b-[0.5px] border-border last:border-0"
                    >
                      <td className="px-4 py-2.5 font-medium">
                        <Link
                          href={`/admin/customers/${r.customerId}`}
                          className="hover:underline"
                        >
                          {r.businessName}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">{r.delivered}</td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {r.worked}{" "}
                        <span className="text-muted-foreground">
                          ({pct(r.workedRate)})
                        </span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {r.workedPastCold}{" "}
                        <span className="text-muted-foreground">
                          ({pct(r.winsPerWorkedPastCold)} won)
                        </span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">{r.attempted}</td>
                      <td className="px-4 py-2.5 tabular-nums font-medium">
                        {r.wins}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {pct(r.winsPerAttempted)}
                        <span className="text-muted-foreground"> of tried</span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {r.medianDaysToWin ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Outcomes worth a look</h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {needsReview.length} flagged
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Recorded outcomes where the operator&apos;s own notes and activity
          don&apos;t support what was claimed. Almost always a mis-click rather
          than anything else — a win carries no credit, so there is nothing to
          gain from a false one.
        </p>
        <Card>
          <CardContent className="p-0">
            {needsReview.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                Nothing flagged. Every recorded outcome is supported.
              </p>
            ) : (
              <div className="divide-y-[0.5px] divide-border">
                {needsReview.map((r) => (
                  <div key={r.assignmentId} className="p-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{r.leadName}</span>
                      <span className="text-sm text-muted-foreground">
                        · {r.businessName}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                        {r.status}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          EVIDENCE_STYLE[r.evidenceLevel] ?? ""
                        }`}
                      >
                        {r.evidenceLevel} evidence
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-amber-800">
                      {r.reviewReason}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                      {r.contactAttempts} contact attempts · {r.opens} opens ·{" "}
                      {r.noteCount} notes · stage {r.pipelineStage}
                    </p>
                    {r.notes && (
                      <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-xs text-[#52514e]">
                        {r.notes}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Duplicate landlords</h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {duplicates.reduce((s, d) => s + d.copies - 1, 0)} redundant copies ·{" "}
            {duplicates.reduce((s, d) => s + d.assignmentsMade, 0)} assignments
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Already ingested, from before duplicate blocking existed. New ones are
          now refused at ingest. &ldquo;Probable&rdquo; means the name and phone
          match but the email differs — never blocked automatically, because
          deciding two addresses belong to one person is a judgement.
        </p>
        <Card>
          <CardContent className="p-0">
            {duplicates.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                No duplicate landlords found.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-normal">Landlord</th>
                      <th className="px-4 py-2 font-normal">Confidence</th>
                      <th className="px-4 py-2 font-normal">Copies</th>
                      <th className="px-4 py-2 font-normal">Sold</th>
                      <th className="px-4 py-2 font-normal">Product</th>
                      <th className="px-4 py-2 font-normal">First seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {duplicates.map((d) => (
                      <tr
                        key={`${d.confidence}-${d.leadName}-${d.phone}-${d.leadType}`}
                        className="border-b-[0.5px] border-border last:border-0"
                      >
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{d.leadName}</div>
                          <div className="text-xs text-muted-foreground">
                            {d.email} · {d.phone}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              d.confidence === "exact"
                                ? "bg-red-50 text-red-700"
                                : "bg-amber-50 text-amber-800"
                            }`}
                          >
                            {d.confidence}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">{d.copies}</td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {d.assignmentsMade}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {d.leadType === "guaranteed_rent" ? "GR" : "Management"}
                          {d.spansProducts && " · both"}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {formatDate(d.firstSeen)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
