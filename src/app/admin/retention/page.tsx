import { Card, CardContent } from "@/components/ui/card";
import { RetentionChart } from "@/components/admin/RetentionChart";
import { getRetentionData, ENGAGEMENT_CHURN_LOOKBACK_DAYS } from "@/lib/retentionData";
import { formatAdminDate } from "@/lib/importedLeadMonths";
import { formatGBP } from "@/lib/utils";
import { cancelReasonLabel } from "@/lib/cancelOptions";
import { pauseReasonLabel } from "@/lib/pauseOptions";
import {
  LEAD_TYPES,
  MIN_COHORT,
  RETENTION_CHECKPOINTS,
  TENURE_BANDS,
  LIFECYCLE_STATE_LABELS,
  REASON_SOURCE_LABELS,
  REASON_THEME_LABELS,
  approachingCheckpoint,
  bandLabel,
  bandedMrr,
  churnedBeforePaying,
  dataQuality,
  engagementComparison,
  isChurned,
  mrrInForceDaily,
  productLabel,
  reasonCrossTab,
  renewalRetention,
  revenueMovement,
  visibleMilestones,
  type LifecycleRow,
} from "@/lib/retention";

export const dynamic = "force-dynamic";

/**
 * Admin → Retention.
 *
 * Where customers drop off, why, and how stable the income is. Nothing else in
 * the product could answer any of the three: /admin reports live capacity and a
 * days-since-activity risk band, and get_customer_risk()'s WHERE clause requires
 * an active subscription — so it structurally cannot see a customer who has left.
 *
 * NO MIGRATION BACKS THIS PAGE. Every fact here already exists in the schema, so
 * it ships with no schema change and nothing that can touch a balance, counter,
 * pacing or capacity column.
 *
 * ⚠️ RETENTION IS COUNTED IN INVOICES, NOT DAYS, and §retention.ts explains why:
 * all three measurable churns sit at exactly 31.0 days, one day past the 1-month
 * line, so a day-based band flips the headline on the boundary. Months are the
 * labels; the invoice count is the arithmetic.
 */

function gbp(pence: number): string {
  return formatGBP(Math.round(pence / 100));
}

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function rate(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function num(value: number | null, digits = 1): string {
  return value === null ? "—" : value.toFixed(digits);
}

const STATE_STYLE: Record<string, string> = {
  active: "bg-brand/10 text-brand",
  cancelling: "bg-amber-50 text-amber-800",
  paused: "bg-amber-50 text-amber-800",
  cancelled: "bg-red-50 text-red-700",
  lapsed: "bg-red-50 text-red-700",
};

function StatePill({ state }: { state: LifecycleRow["state"] }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${STATE_STYLE[state] ?? "bg-muted text-muted-foreground"}`}
    >
      {LIFECYCLE_STATE_LABELS[state]}
    </span>
  );
}

export default async function RetentionPage() {
  const data = await getRetentionData();

  if (data.unavailable) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold">Retention</h1>
          <p className="text-sm text-muted-foreground">
            Where customers drop off, why, and how stable the income is.
          </p>
        </div>
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">
            Retention figures are unavailable — the customers or payments read
            failed. Nothing is wrong with the data; try again in a moment.
          </CardContent>
        </Card>
      </div>
    );
  }

  const asOf = new Date(data.asOf);
  const { lifecycle } = data;
  const quality = dataQuality(lifecycle);
  const neverPaidChurn = churnedBeforePaying(lifecycle);
  const movement = revenueMovement(data.planChanges);
  const approaching = approachingCheckpoint(lifecycle, asOf, 30);
  const engagement = engagementComparison(lifecycle, data.snapshots);
  const churnEvents = lifecycle.filter(isChurned);
  const paused = lifecycle.filter((r) => r.state === "paused");

  // The chart is one line per band across BOTH products: the income-stability
  // question is about the business, and splitting it would halve every series.
  // Retention and churn below are per product (invariant 6).
  const series = mrrInForceDaily(lifecycle, data.payments, asOf);
  const milestones = visibleMilestones(series);

  const perProduct = LEAD_TYPES.map((leadType) => {
    const rows = lifecycle.filter((r) => r.leadType === leadType);
    return {
      leadType,
      rows,
      mrr: bandedMrr(rows),
      retention: RETENTION_CHECKPOINTS.map((c) => renewalRetention(rows, c, asOf)),
      reasons: reasonCrossTab(rows),
    };
  }).filter((p) => p.rows.length > 0);

  const ticketsByCustomer = new Map<string, typeof data.tickets>();
  for (const ticket of data.tickets) {
    if (!ticket.customerId) continue;
    const list = ticketsByCustomer.get(ticket.customerId) ?? [];
    list.push(ticket);
    ticketsByCustomer.set(ticket.customerId, list);
  }

  const totalMrr = perProduct.reduce((sum, p) => sum + p.mrr.totalPence, 0);
  const totalStable = perProduct.reduce((sum, p) => sum + p.mrr.stablePence, 0);
  const totalPausedPence = perProduct.reduce((sum, p) => sum + p.mrr.pausedPence, 0);
  const totalPausedCustomers = perProduct.reduce((sum, p) => sum + p.mrr.pausedCustomers, 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Retention</h1>
        <p className="text-sm text-muted-foreground">
          Where customers drop off, why, and how stable the income is. Counted in
          invoices paid, per product.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Data quality, FIRST and never hidden.

          `payments` is known-incomplete (0064's header records 17 rows against
          20 subscribers at the time), so some customers' tenure falls back to
          signup. Stating it here is what stops the bands being quietly wrong for
          exactly the oldest customers the stability figure leans on. */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">What these figures rest on</h2>
        <Card>
          <CardContent className="space-y-2 p-5 text-sm">
            <p className="text-muted-foreground">
              Tenure is measured from each customer&rsquo;s first paid
              subscription invoice — the same rule the replacement balance uses,
              so the two agree.
            </p>
            <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Tenure from a real invoice</dt>
                <dd className="tabular-nums">{quality.invoiceBacked}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">
                  Live subscription, no invoice — estimated from signup
                </dt>
                <dd className="tabular-nums">{quality.signupEstimated}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">
                  Left having never paid — excluded from every checkpoint
                </dt>
                <dd className="tabular-nums">{quality.neverPaid}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Monthly cohorts on record</dt>
                <dd className="tabular-nums">
                  {quality.cohorts}
                  {quality.earliestFirstPaid
                    ? ` · from ${formatAdminDate(quality.earliestFirstPaid)}`
                    : ""}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Longest tenure reached</dt>
                <dd className="tabular-nums">{num(quality.maxTenureMonths)} months</dd>
              </div>
            </dl>
            {quality.signupEstimated > 0 && (
              <p className="pt-1 text-xs text-muted-foreground">
                A live subscription with no paid invoice is priced at £0 here and
                its tenure is a guess. Both are worth chasing in Stripe.
              </p>
            )}
            {data.partial.length > 0 && (
              <p className="pt-1 text-xs text-amber-800">
                Could not read: {data.partial.join(", ")}. The sections below that
                depend on them are incomplete; the retention and revenue figures
                are not affected.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Income stability — the headline the page exists for. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Income stability</h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {gbp(totalMrr)} a month in force
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Monthly revenue in force</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">{gbp(totalMrr)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Priced from each subscription&rsquo;s latest paid invoice, not from
                its lead allocation
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Past 6 months</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">
                {totalMrr > 0 ? pct(totalStable / totalMrr) : "—"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {gbp(totalStable)} of stable and very stable revenue
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Paused</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">
                {gbp(totalPausedPence)}
              </p>
              {/* ⚠️ Never added to the total above: a paused subscription is
                  billing £0 because Stripe is voiding its invoices. §21's
                  "always two numbers, never one". */}
              <p className="mt-1 text-xs text-muted-foreground">
                {totalPausedCustomers} subscription
                {totalPausedCustomers === 1 ? "" : "s"} billing nothing — not
                counted above
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Customers who have left</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">
                {churnEvents.length}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Counted per product · {neverPaidChurn.length} never paid an invoice
              </p>
            </CardContent>
          </Card>
        </div>

        {perProduct.map((product) => (
          <Card key={`mrr-${product.leadType}`}>
            <CardContent className="space-y-2 p-5">
              <p className="text-sm font-medium">
                {productLabel(product.leadType)} — revenue by tenure
              </p>
              <dl className="space-y-1 text-sm">
                {product.mrr.entries.map((entry) => {
                  const band = TENURE_BANDS.find((b) => b.key === entry.band);
                  return (
                    <div key={entry.band} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">
                        {band?.label} · {band?.stabilityLabel}
                      </dt>
                      <dd className="tabular-nums">
                        {gbp(entry.pence)}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {entry.customers} customer{entry.customers === 1 ? "" : "s"}
                        </span>
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {product.mrr.unpricedCustomers > 0 && (
                <p className="pt-1 text-xs text-amber-800">
                  {product.mrr.unpricedCustomers} live subscription
                  {product.mrr.unpricedCustomers === 1 ? "" : "s"} with no paid
                  invoice, so contributing £0 to the figures above.
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* The trend. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Revenue in force, by tenure</h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {series.length} day{series.length === 1 ? "" : "s"}
            {series.length > 0 ? ` from ${formatAdminDate(series[0].date)}` : ""}
          </span>
        </div>
        <Card>
          <CardContent className="p-5">
            {/* Height set by the parent; the chart is height="100%". */}
            <div style={{ position: "relative", height: 340 }}>
              <RetentionChart series={series} milestones={milestones} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Every point is money that actually cleared: each live subscription
              contributes its most recent paid invoice, placed in the band it was
              in that day. A paused subscription contributes nothing. Dashed lines
              mark platform changes that could plausibly move retention.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Renewal retention. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Did they renew?</h2>
          <span className="text-sm text-muted-foreground">
            Percentages withheld below {MIN_COHORT} eligible customers
          </span>
        </div>
        {perProduct.map((product) => (
          <Card key={`ret-${product.leadType}`}>
            <CardContent className="p-0">
              <div className="border-b-[0.5px] border-border px-4 py-2.5 text-sm font-medium">
                {productLabel(product.leadType)}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-normal">Checkpoint</th>
                      <th className="px-4 py-2 font-normal">Invoice</th>
                      <th className="px-4 py-2 font-normal">Had the chance</th>
                      <th className="px-4 py-2 font-normal">Renewed</th>
                      <th className="px-4 py-2 font-normal">Left</th>
                      <th className="px-4 py-2 font-normal">Unclear</th>
                      <th className="px-4 py-2 font-normal">Paused</th>
                      <th className="px-4 py-2 font-normal">Retained</th>
                    </tr>
                  </thead>
                  <tbody>
                    {product.retention.map((result) => (
                      <tr
                        key={result.checkpoint.months}
                        className="border-b-[0.5px] border-border last:border-0"
                      >
                        <td className="px-4 py-2.5">{result.checkpoint.label}</td>
                        <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                          #{result.checkpoint.invoice}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">{result.eligible}</td>
                        <td className="px-4 py-2.5 tabular-nums">{result.renewed}</td>
                        <td className="px-4 py-2.5 tabular-nums">{result.churned}</td>
                        <td className="px-4 py-2.5 tabular-nums">{result.unclear}</td>
                        <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                          {result.paused || "—"}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {/* Never a bare percentage: the denominator travels
                              with it, and a not-yet-measurable checkpoint names
                              the date rather than reading as a confident zero. */}
                          {result.eligible === 0 ? (
                            <span className="text-xs text-muted-foreground">
                              {result.measurableFrom
                                ? `measurable from ${formatAdminDate(result.measurableFrom)}`
                                : "nothing eligible"}
                            </span>
                          ) : result.pct === null ? (
                            <span className="text-xs text-muted-foreground">
                              {result.renewed} of {result.eligible} · too few to rate
                            </span>
                          ) : (
                            <>
                              {pct(result.pct)}
                              <span className="ml-2 text-xs text-muted-foreground">
                                {result.renewed} of {result.eligible}
                              </span>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="px-4 py-2.5 text-xs text-muted-foreground">
                <strong>Unclear</strong> means the invoice has not cleared and they
                have not left — a failed or in-flight payment. It is deliberately
                not counted as a renewal. <strong>Paused</strong> customers are out
                of the denominator altogether: Stripe voids their invoices, so we
                are the reason the renewal never happened.
              </p>
            </CardContent>
          </Card>
        ))}
        {neverPaidChurn.length > 0 && (
          <Card>
            <CardContent className="p-5 text-sm text-muted-foreground">
              {neverPaidChurn.length} customer
              {neverPaidChurn.length === 1 ? "" : "s"} left having never paid an
              invoice, so they appear in no checkpoint above — they never entered
              the renewal funnel:{" "}
              {neverPaidChurn.map((r) => r.businessName).join(", ")}.
            </CardContent>
          </Card>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Why they left. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Why they left</h2>
          <span className="text-sm text-muted-foreground">
            Cross-tabbed against the tenure they reached
          </span>
        </div>
        {perProduct.map((product) => (
          <Card key={`why-${product.leadType}`}>
            <CardContent className="p-0">
              <div className="border-b-[0.5px] border-border px-4 py-2.5 text-sm font-medium">
                {productLabel(product.leadType)}
              </div>
              {product.reasons.events === 0 ? (
                <p className="p-5 text-sm text-muted-foreground">
                  Nobody has left this product yet.
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                          <th className="px-4 py-2 font-normal">Reason</th>
                          {TENURE_BANDS.map((band) => (
                            <th key={band.key} className="px-4 py-2 font-normal">
                              {band.shortLabel}
                            </th>
                          ))}
                          <th className="px-4 py-2 font-normal">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {product.reasons.rows.map((row) => (
                          <tr
                            key={row.theme}
                            className="border-b-[0.5px] border-border last:border-0"
                          >
                            <td className="px-4 py-2.5">
                              {REASON_THEME_LABELS[row.theme]}
                            </td>
                            {TENURE_BANDS.map((band) => (
                              <td
                                key={band.key}
                                className="px-4 py-2.5 tabular-nums text-muted-foreground"
                              >
                                {row.byBand[band.key] || "—"}
                              </td>
                            ))}
                            <td className="px-4 py-2.5 tabular-nums">{row.total}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="px-4 py-2.5 text-xs text-muted-foreground">
                    {product.reasons.events} departure
                    {product.reasons.events === 1 ? "" : "s"},{" "}
                    {product.reasons.mentions} reason
                    {product.reasons.mentions === 1 ? "" : "s"} given — a
                    cancellation citing two reasons is counted under each, so the
                    totals add up to more than the number who left.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        ))}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Engagement beside the drop-off.

          This is the half that separates "the leads were bad" from "they never
          rang anybody" — stated reasons alone cannot tell you which. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">What they were doing before they left</h2>
          <span className="text-sm text-muted-foreground">
            Churn in the last {ENGAGEMENT_CHURN_LOOKBACK_DAYS} days
          </span>
        </div>
        <Card>
          <CardContent className="p-0">
            {engagement.churned.customers === 0 && engagement.stayed.customers === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                No engagement snapshots available for either group.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                        <th className="px-4 py-2 font-normal" />
                        <th className="px-4 py-2 font-normal">Customers</th>
                        <th className="px-4 py-2 font-normal">Worked</th>
                        <th className="px-4 py-2 font-normal">Opened</th>
                        <th className="px-4 py-2 font-normal">Contacted</th>
                        <th className="px-4 py-2 font-normal">Leads delivered</th>
                        <th className="px-4 py-2 font-normal">Worked none</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          ["Left", engagement.churned],
                          ["Still with us", engagement.stayed],
                        ] as const
                      ).map(([label, group]) => (
                        <tr
                          key={label}
                          className="border-b-[0.5px] border-border last:border-0"
                        >
                          <td className="px-4 py-2.5 font-medium">{label}</td>
                          <td className="px-4 py-2.5 tabular-nums">{group.customers}</td>
                          <td className="px-4 py-2.5 tabular-nums">{rate(group.workedRate)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{rate(group.openRate)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{rate(group.contactRate)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{num(group.delivered)}</td>
                          <td className="px-4 py-2.5 tabular-nums">{group.neverWorkedAny}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="px-4 py-2.5 text-xs text-muted-foreground">
                  A churned customer is read from their last snapshot{" "}
                  <strong>before</strong> they left — snapshots keep being captured
                  afterwards, so their latest row would necessarily show zero and
                  make everyone look disengaged.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Paused — its own section, because of the share of the book it is. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Paused</h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {paused.length} subscription{paused.length === 1 ? "" : "s"} ·{" "}
            {gbp(totalPausedPence)} a month not being billed
          </span>
        </div>
        <Card>
          <CardContent className="p-0">
            {paused.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                Nobody is paused.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                        <th className="px-4 py-2 font-normal">Customer</th>
                        <th className="px-4 py-2 font-normal">Product</th>
                        <th className="px-4 py-2 font-normal">Not billed</th>
                        <th className="px-4 py-2 font-normal">Tenure</th>
                        <th className="px-4 py-2 font-normal">Paused</th>
                        <th className="px-4 py-2 font-normal">Resumes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paused.map((row) => (
                        <tr
                          key={row.key}
                          className="border-b-[0.5px] border-border last:border-0"
                        >
                          <td className="px-4 py-2.5">{row.businessName}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">
                            {productLabel(row.leadType)}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">{gbp(row.mrrPence)}</td>
                          <td className="px-4 py-2.5 tabular-nums">
                            {num(row.tenureMonths)} mo
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">
                            {row.pausedAt ? formatAdminDate(row.pausedAt) : "—"}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">
                            {row.pauseResumesAt ? formatAdminDate(row.pauseResumesAt) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="px-4 py-2.5 text-xs text-muted-foreground">
                  A pause is not churn and is never added to the revenue figures —
                  but billing restarts on the resume date, so each of these is a
                  decision arriving on a known day.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Revenue movement — retention that shrank or grew. */}
      {movement.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-medium">Plan changes</h2>
            <span className="text-sm text-muted-foreground">
              Revenue kept but resized — never counted as churn
            </span>
          </div>
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-normal">Month</th>
                      <th className="px-4 py-2 font-normal">Upgrades</th>
                      <th className="px-4 py-2 font-normal">Gained</th>
                      <th className="px-4 py-2 font-normal">Downgrades</th>
                      <th className="px-4 py-2 font-normal">Lost</th>
                      <th className="px-4 py-2 font-normal">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movement.map((m) => (
                      <tr
                        key={m.month}
                        className="border-b-[0.5px] border-border last:border-0"
                      >
                        <td className="px-4 py-2.5">{m.month}</td>
                        <td className="px-4 py-2.5 tabular-nums">{m.upgrades}</td>
                        <td className="px-4 py-2.5 tabular-nums">{gbp(m.upPence)}</td>
                        <td className="px-4 py-2.5 tabular-nums">{m.downgrades}</td>
                        <td className="px-4 py-2.5 tabular-nums">{gbp(m.downPence)}</td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {m.netPence >= 0 ? "+" : "−"}
                          {gbp(Math.abs(m.netPence))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* The forward view. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Reaching a checkpoint in the next 30 days</h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {approaching.length} due
          </span>
        </div>
        <Card>
          <CardContent className="p-0">
            {approaching.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                Nobody reaches a 1, 3, 6 or 12-month checkpoint in the next 30
                days.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                        <th className="px-4 py-2 font-normal">Customer</th>
                        <th className="px-4 py-2 font-normal">Product</th>
                        <th className="px-4 py-2 font-normal">Reaches</th>
                        <th className="px-4 py-2 font-normal">On</th>
                        <th className="px-4 py-2 font-normal">Days</th>
                        <th className="px-4 py-2 font-normal">Invoices paid</th>
                        <th className="px-4 py-2 font-normal">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {approaching.map((item) => (
                        <tr
                          key={`${item.row.key}-${item.checkpoint.months}`}
                          className="border-b-[0.5px] border-border last:border-0"
                        >
                          <td className="px-4 py-2.5">{item.row.businessName}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">
                            {productLabel(item.row.leadType)}
                          </td>
                          <td className="px-4 py-2.5">{item.checkpoint.label}</td>
                          <td className="px-4 py-2.5 tabular-nums">
                            {formatAdminDate(item.dueOn)}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">{item.daysAway}</td>
                          <td className="px-4 py-2.5 tabular-nums">
                            {item.row.invoicesPaid}
                          </td>
                          <td className="px-4 py-2.5">
                            <StatePill state={item.row.state} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="px-4 py-2.5 text-xs text-muted-foreground">
                  Stated rules, not a prediction — with this few departures on
                  record there is nothing to fit a model to.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Every departure, in full.

          Archived and cancelled customers are shown here deliberately, unlike
          every other admin surface (§18D): a departure is a record of something
          that happened, and the customer's current circulation status does not
          unhappen it. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Every departure</h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {churnEvents.length} recorded
          </span>
        </div>
        <Card>
          <CardContent className="p-0">
            {churnEvents.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                Nobody has left yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-normal">Customer</th>
                      <th className="px-4 py-2 font-normal">Product</th>
                      <th className="px-4 py-2 font-normal">Left</th>
                      <th className="px-4 py-2 font-normal">Tenure</th>
                      <th className="px-4 py-2 font-normal">Invoices</th>
                      <th className="px-4 py-2 font-normal">Reason</th>
                      <th className="px-4 py-2 font-normal">Tickets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {churnEvents.map((row) => {
                      const tickets = ticketsByCustomer.get(row.customerId) ?? [];
                      return (
                        <tr
                          key={row.key}
                          className="border-b-[0.5px] border-border last:border-0 align-top"
                        >
                          <td className="px-4 py-2.5">
                            <div className="flex flex-wrap items-center gap-2">
                              {row.businessName}
                              <StatePill state={row.state} />
                              {row.isArchived && (
                                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                  archived
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">{row.email}</div>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">
                            {productLabel(row.leadType)}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">
                            {row.endedAt ? formatAdminDate(row.endedAt) : "—"}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">
                            {row.tenureBasis === "never_paid" ? (
                              <span className="text-xs text-muted-foreground">
                                never paid
                              </span>
                            ) : (
                              <>
                                {num(row.tenureMonths)} mo
                                <span className="ml-2 text-xs text-muted-foreground">
                                  {bandLabel(row.band)}
                                </span>
                              </>
                            )}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">{row.invoicesPaid}</td>
                          <td className="px-4 py-2.5">
                            <div>
                              {row.reasonThemes
                                .map((t) => REASON_THEME_LABELS[t])
                                .join(", ")}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {REASON_SOURCE_LABELS[row.reasonSource]}
                              {/* The customer's own words survive: the raw keys
                                  and the note, never only the mapped theme. */}
                              {row.reasonRaw.length > 0 &&
                                ` · ${row.reasonRaw
                                  .map((r) =>
                                    row.reasonSource === "pause_reason"
                                      ? pauseReasonLabel(r)
                                      : cancelReasonLabel(r)
                                  )
                                  .join(", ")}`}
                            </div>
                            {row.reasonNote && (
                              <div className="mt-1 max-w-md text-xs italic text-muted-foreground">
                                &ldquo;{row.reasonNote}&rdquo;
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            {tickets.length === 0 ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : (
                              <div className="space-y-0.5">
                                {tickets.map((t) => (
                                  <div key={t.id} className="text-xs">
                                    <span className="text-muted-foreground tabular-nums">
                                      {t.submittedAt
                                        ? formatAdminDate(t.submittedAt)
                                        : "—"}
                                    </span>{" "}
                                    {t.subject}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
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
