import { Fragment } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { GoalForm } from "@/components/dashboard/GoalForm";
import { LEAD_PRICE_GBP } from "@/lib/plans";

export const dynamic = "force-dynamic";

/**
 * The long-run conversion assumption behind the pipeline estimate: roughly one
 * signed management client per twenty leads. It is an average over the whole
 * book, not a promise about any twenty leads in particular — which is why it
 * only ever drives the supporting estimate, never the completion check.
 */
const LEADS_PER_WON_CLIENT = 20;

/**
 * Activity behind a lead — the work the operator does, per lead, whether or not
 * that lead ever signs. Derived from analysis of converted customers and shown
 * as ranges because that is what they are: a spread observed across real
 * operators, not a figure this system measures or promises.
 *
 * Presentations are exact and singular on purpose. Every lead gets one income
 * analysis; a range on a constant of 1 would read as false precision dressed up
 * as honesty.
 */
const PRESENTATIONS_PER_LEAD = 1;
const EMAILS_PER_LEAD_LOW = 8;
const EMAILS_PER_LEAD_HIGH = 12;
const CALLS_PER_LEAD_LOW = 4;
const CALLS_PER_LEAD_HIGH = 6;

/**
 * Rows to render in the month-by-month table before collapsing the middle —
 * the opening "Now" row plus two years of plan. A ten-lead plan against a large
 * goal can run to eight years of months, and a table nobody scrolls to the
 * bottom of communicates less than a short one that says what it left out.
 */
const MAX_PROJECTION_ROWS = 25;

type GoalRow = {
  id: string;
  subscription_status: string | null;
  monthly_allocation: number | null;
  management_customer_goal: number | null;
  management_lifetime_leads_received: number | null;
};

/**
 * Goals — management only.
 *
 * Two numbers that must not be confused with one another:
 *
 *   * WON CLIENTS is the goal. It counts assignments the operator has marked
 *     won, and it alone decides whether the goal is met.
 *   * The PIPELINE ESTIMATE is a model. It says how many leads a goal of this
 *     size implies at the long-run rate, and how long that takes at the
 *     current plan. Someone who signs five clients from forty leads has met a
 *     goal of five, even though the model said a hundred.
 *
 * Everything is read through the SESSION client, not the service role: RLS
 * (customers_select_own, lead_assignments_select_own) already restricts both
 * queries to the caller's own rows, so there is nothing the admin client would
 * add except the ability to get the scoping wrong.
 */
export default async function GoalsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await supabase
    .from("customers")
    .select(
      "id, subscription_status, monthly_allocation, management_customer_goal, management_lifetime_leads_received"
    )
    .eq("user_id", user.id)
    .maybeSingle();

  const customer = data as GoalRow | null;
  if (!customer) redirect("/dashboard");

  // Enforced here as well as in the nav and again in the RPC. Hiding a nav item
  // is presentation; this is the page's own check.
  if (customer.subscription_status !== "active") redirect("/dashboard");

  // Won, management only. lead_assignments carries no lead_type of its own, so
  // the product filter has to come from the joined lead — an inner join, so a
  // GR assignment cannot fall through into the count.
  const { count: wonCount } = await supabase
    .from("lead_assignments")
    .select("id, leads!inner(lead_type)", { count: "exact", head: true })
    .eq("customer_id", customer.id)
    .eq("status", "won")
    .eq("leads.lead_type", "management")
    // The goal is signed clients won FROM THE MARKETPLACE — it is what the
    // subscription is for, and the pipeline estimate beside it is modelled on
    // leads we deliver. A customer who imported fifty existing clients and
    // marked them won would otherwise "achieve" the goal on their own book.
    .is("leads.owner_customer_id", null);

  const goal = customer.management_customer_goal;
  const won = wonCount ?? 0;
  const lifetime = customer.management_lifetime_leads_received ?? 0;
  const allocation = customer.monthly_allocation ?? 0;

  const leadsNeededTotal = (goal ?? 0) * LEADS_PER_WON_CLIENT;
  const leadsStillNeeded = Math.max(leadsNeededTotal - lifetime, 0);
  // Guarded against a zero or missing allocation, which would otherwise divide
  // to Infinity and render "approximately Infinity more months".
  const months =
    allocation > 0 ? Math.ceil(leadsStillNeeded / allocation) : null;

  // Achieved is decided by won count alone, never by leads received. It is
  // therefore true the moment a goal is set at or below the number already won,
  // not only after time passes.
  const achieved = goal !== null && won >= goal;

  // Investment, in pounds. Per-lead price comes from lib/plans so this figure
  // cannot drift from what a delivered lead is actually recorded at; see the
  // note there about three copies of the price going stale.
  const investmentTotal = leadsNeededTotal * LEAD_PRICE_GBP.management;
  const investmentRemaining = leadsStillNeeded * LEAD_PRICE_GBP.management;

  // Activity projection. Anchored to the same lead figures as everything above:
  // totals to the whole goal, per-month to the customer's actual allocation.
  // `allocation` is a real per-month lead count on this page, so there is no
  // need to derive one from the timeline — and `months` divides leads STILL
  // needed, not the total, so deriving from it would be wrong for anyone who
  // has already received leads.
  const totalPresentations = leadsNeededTotal * PRESENTATIONS_PER_LEAD;
  const totalEmails = roundedRange(
    leadsNeededTotal * EMAILS_PER_LEAD_LOW,
    leadsNeededTotal * EMAILS_PER_LEAD_HIGH,
    100
  );
  const totalCalls = roundedRange(
    leadsNeededTotal * CALLS_PER_LEAD_LOW,
    leadsNeededTotal * CALLS_PER_LEAD_HIGH,
    100
  );

  const monthlyPresentations = allocation * PRESENTATIONS_PER_LEAD;
  const monthlyEmails = roundedRange(
    allocation * EMAILS_PER_LEAD_LOW,
    allocation * EMAILS_PER_LEAD_HIGH,
    10
  );
  const monthlyCalls = roundedRange(
    allocation * CALLS_PER_LEAD_LOW,
    allocation * CALLS_PER_LEAD_HIGH,
    10
  );

  // The month-by-month path. The per-month figures above are the steady-state
  // workload; this is what that workload accumulates to, month by month, until
  // it reaches the leads the goal implies.
  const projection = buildProjection({
    lifetime,
    leadsNeededTotal,
    allocation,
    won,
  });
  const hiddenMonths = Math.max(projection.length - MAX_PROJECTION_ROWS, 0);
  // Keep the final month whatever happens — it is the row that reaches the
  // goal, and dropping it would end the table in the middle of nowhere.
  const visibleProjection =
    hiddenMonths > 0
      ? [
          ...projection.slice(0, MAX_PROJECTION_ROWS - 1),
          projection[projection.length - 1],
        ]
      : projection;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Goals</h1>
        <p className="text-sm text-muted-foreground">
          Your target for signed management clients from this marketplace.
        </p>
      </div>

      {goal !== null && !achieved && (
        <>
          <section className="rounded-xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold">Won clients</h2>
            <p className="mt-3 text-3xl font-semibold">
              {won} of {goal} won
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {goal - won} more to reach your goal
            </p>
          </section>

          <section className="rounded-xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold">Pipeline estimate</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              What a goal of {goal} implies at the long-run conversion rate.
            </p>
            <dl className="mt-4 space-y-3">
              <EstimateRow label="Leads needed in total" value={leadsNeededTotal} />
              <EstimateRow label="Leads received so far" value={lifetime} />
              <EstimateRow label="Leads still needed" value={leadsStillNeeded} />
              <EstimateRow
                label={`Investment in total, at ${formatGbp(
                  LEAD_PRICE_GBP.management
                )} a lead`}
                value={formatGbp(investmentTotal)}
              />
              <EstimateRow
                label="Investment still to come"
                value={formatGbp(investmentRemaining)}
              />
              <div className="flex flex-wrap justify-between gap-2 border-t border-black/10 pt-3 text-sm">
                <dt className="text-muted-foreground">
                  Estimated time remaining
                </dt>
                <dd className="font-medium">
                  {months === null
                    ? "Not available without an active monthly plan"
                    : leadsStillNeeded === 0
                      ? `You have already received the ${leadsNeededTotal} leads this goal implies`
                      : `Approximately ${months} more ${
                          months === 1 ? "month" : "months"
                        } at your current ${allocation}-lead plan`}
                </dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold">The work behind this goal</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Reaching {goal} customers means running the full process across
              around {formatNumber(totalPresentations)} leads. In total, plan for
              roughly:
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <ActivityFigure
                value={`~${formatNumber(totalPresentations)}`}
                label="presentations"
              />
              <ActivityFigure value={totalEmails} label="emails" />
              <ActivityFigure value={totalCalls} label="calls" />
            </div>

            {allocation > 0 ? (
              <>
                <p className="mt-6 text-sm text-muted-foreground">
                  Month by month, that is about:
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <ActivityFigure
                    value={`~${formatNumber(monthlyPresentations)}`}
                    label="presentations"
                  />
                  <ActivityFigure value={monthlyEmails} label="emails" />
                  <ActivityFigure value={monthlyCalls} label="calls" />
                </div>
              </>
            ) : (
              // Same honesty as the timeline row above: without a monthly
              // allocation there is no per-month figure to show, and inventing
              // a default plan here would put a number on this page that
              // describes nobody.
              <p className="mt-6 text-sm text-muted-foreground">
                Month by month figures are not available without an active
                monthly plan.
              </p>
            )}

            <p className="mt-6 border-t border-black/10 pt-4 text-sm text-muted-foreground">
              Around 1 in 20 leads signs, so the full process runs on every lead
              — not just the ones that convert. Working your whole allocation
              each month is what makes the goal land.
            </p>
          </section>

          {projection.length > 1 && (
            <section className="rounded-xl border border-black/10 bg-white p-6">
              <h2 className="text-lg font-semibold">
                Month by month to your goal
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Where each month leaves you at your current {allocation}-lead
                plan. Every figure is a running total, so the last row is the
                whole goal. Leads and presentations are the same number — one
                analysis per lead.
              </p>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[40rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b-[0.5px] border-border text-left">
                      <th className="pb-2 font-medium">Month</th>
                      <th className="pb-2 text-right font-medium">Leads</th>
                      <th className="pb-2 text-right font-medium">Emails</th>
                      <th className="pb-2 text-right font-medium">Calls</th>
                      <th className="pb-2 text-right font-medium">Invested</th>
                      <th className="pb-2 text-right font-medium">Clients</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleProjection.map((row, index) => (
                      <Fragment key={row.key}>
                        {hiddenMonths > 0 &&
                          index === visibleProjection.length - 1 && (
                            <tr className="border-b-[0.5px] border-border">
                              <td
                                colSpan={6}
                                className="py-2.5 text-muted-foreground"
                              >
                                {hiddenMonths} further{" "}
                                {hiddenMonths === 1 ? "month" : "months"} at the
                                same pace, not shown
                              </td>
                            </tr>
                          )}
                        <tr className="border-b-[0.5px] border-border last:border-0">
                          <td className="py-2.5 font-medium">{row.label}</td>
                          <td className="py-2.5 text-right">
                            {formatNumber(row.leads)}
                          </td>
                          <td className="py-2.5 text-right">
                            {roundedRange(
                              row.leads * EMAILS_PER_LEAD_LOW,
                              row.leads * EMAILS_PER_LEAD_HIGH,
                              100
                            )}
                          </td>
                          <td className="py-2.5 text-right">
                            {roundedRange(
                              row.leads * CALLS_PER_LEAD_LOW,
                              row.leads * CALLS_PER_LEAD_HIGH,
                              100
                            )}
                          </td>
                          <td className="py-2.5 text-right">
                            {formatGbp(row.invested)}
                          </td>
                          <td className="py-2.5 text-right">
                            {row.projected
                              ? `~${formatNumber(row.clients)}`
                              : formatNumber(row.clients)}
                          </td>
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-4 text-sm text-muted-foreground">
                The opening row is where you actually are. Everything below it
                is modelled at the long-run rate, not a forecast of your own
                pipeline — your goal is met by clients you sign and mark as won,
                whenever that happens.
              </p>
            </section>
          )}
        </>
      )}

      {achieved && (
        <section className="rounded-xl border border-black/10 bg-white p-6">
          <h2 className="text-lg font-semibold">Goal reached</h2>
          <p className="mt-3 text-sm">
            Goal reached — {won} of your target {goal} clients won from this
            marketplace. Set a new goal to keep growing.
          </p>
        </section>
      )}

      <GoalForm initialGoal={goal} />

      <p className="text-xs text-muted-foreground">
        This is a long-run modelled estimate, not a per-lead guarantee. Leads
        typically take 4 to 12 weeks from first contact to a signed management
        agreement.
      </p>
    </div>
  );
}

function EstimateRow({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function ActivityFigure({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-black/10 p-4">
      <p className="text-xl font-semibold">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

type ProjectionRow = {
  key: string;
  label: string;
  /** Leads received by the end of this row's month — a running total. */
  leads: number;
  /** Running total spend, in pounds. */
  invested: number;
  /** Signed clients: the real figure on the opening row, modelled on the rest. */
  clients: number;
  projected: boolean;
};

/**
 * Build the month-by-month path from where the customer is now to the leads
 * their goal implies.
 *
 * The opening row is the present, and its client count is the REAL won figure
 * rather than a model — the projection starts from what has actually happened,
 * so the table cannot show somebody a modelled number for a month they have
 * already lived through. Every later row is modelled and marked with a tilde.
 *
 * Clients are floored, not rounded. A projection that overstates progress
 * towards a goal is worse than one that understates it, and the final row still
 * lands exactly on the goal because leadsNeededTotal is an exact multiple of
 * LEADS_PER_WON_CLIENT.
 *
 * The last month is partial whenever the remaining leads do not divide evenly
 * by the allocation, so the table ends on leadsNeededTotal rather than
 * overshooting it. Returns nothing without an allocation to advance by — the
 * caller renders the same "no active plan" wording the timeline row uses.
 */
function buildProjection({
  lifetime,
  leadsNeededTotal,
  allocation,
  won,
}: {
  lifetime: number;
  leadsNeededTotal: number;
  allocation: number;
  won: number;
}): ProjectionRow[] {
  if (allocation <= 0) return [];

  const rows: ProjectionRow[] = [
    {
      key: "now",
      label: "Now",
      leads: lifetime,
      invested: lifetime * LEAD_PRICE_GBP.management,
      clients: won,
      projected: false,
    },
  ];

  let cumulative = lifetime;
  let month = 0;
  while (cumulative < leadsNeededTotal) {
    month += 1;
    cumulative = Math.min(cumulative + allocation, leadsNeededTotal);
    rows.push({
      key: `month-${month}`,
      label: `Month ${month}`,
      leads: cumulative,
      invested: cumulative * LEAD_PRICE_GBP.management,
      clients: Math.floor(cumulative / LEADS_PER_WON_CLIENT),
      projected: true,
    });
  }

  return rows;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-GB");
}

/** Whole pounds. Every figure here is a modelled estimate, so pence would be noise. */
function formatGbp(value: number): string {
  return `£${formatNumber(value)}`;
}

/**
 * The coarsest step is only allowed to move a bound by so much before the
 * rounding stops being presentational and starts being wrong. A fifth of the
 * lower bound is the line: 1,600–2,400 rounds to hundreds happily, but 120–180
 * to the nearest hundred is "100–200", which overstates the spread by more than
 * the figures themselves are worth.
 */
const MAX_ROUNDING_SHARE = 0.2;

/**
 * Round a low/high pair to a clean step so a range reads as an estimate rather
 * than a computation — 1,600–2,400, not 1,584–2,376.
 *
 * Steps are tried coarsest first and rejected on two grounds: distorting a
 * small pair (above), or collapsing the range to a single number. A goal of 1
 * implies 80–120 calls, which to the nearest hundred is "100–100" — the
 * rounding as specified, and visibly broken. Between hundreds and tens sits 50,
 * which is what keeps mid-sized pairs such as 480–720 reading as 500–700 rather
 * than falling all the way back to exact figures.
 *
 * The early rows of the month-by-month table are where this matters: they carry
 * the smallest numbers on the page and would otherwise be the least accurate.
 */
function roundedRange(low: number, high: number, step: number): string {
  // A customer who has received nothing yet has a genuine zero, and "0–0" reads
  // as a broken range rather than as none.
  if (high <= 0) return "0";

  for (const candidate of [step, 50, 10, 1].filter((s) => s <= step)) {
    if (candidate > 1 && candidate > low * MAX_ROUNDING_SHARE) continue;
    const lo = Math.round(low / candidate) * candidate;
    const hi = Math.round(high / candidate) * candidate;
    if (lo > 0 && lo < hi) return `${formatNumber(lo)}–${formatNumber(hi)}`;
  }
  return `${formatNumber(low)}–${formatNumber(high)}`;
}
