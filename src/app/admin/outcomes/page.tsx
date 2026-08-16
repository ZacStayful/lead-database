import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { getOutcomeOverview, getPauseInsight } from "@/lib/outcomes";
import { formatDate, formatGBP } from "@/lib/utils";
import { pauseReasonLabel } from "@/lib/pauseOptions";

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

export default async function AdminOutcomesPage() {
  // Fetched independently: an unapplied 0077 must cost this one block, not the
  // whole page. See getPauseInsight.
  const [{ unavailable, wins, scoreboard, needsReview, duplicates }, pauses] =
    await Promise.all([getOutcomeOverview(), getPauseInsight()]);

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
          and a single ranking number would pick one without saying so.
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
