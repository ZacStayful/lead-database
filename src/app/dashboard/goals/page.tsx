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
    .eq("leads.lead_type", "management");

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

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-GB");
}

/** Whole pounds. Every figure here is a modelled estimate, so pence would be noise. */
function formatGbp(value: number): string {
  return `£${formatNumber(value)}`;
}

/**
 * Round a low/high pair to a clean step so a range reads as an estimate rather
 * than a computation — 1,600–2,400, not 1,584–2,376.
 *
 * Falls back to a finer step when the coarse one would collapse the range or
 * round a bound down to nothing. A goal of 1 implies 80–120 calls, which to the
 * nearest hundred is "100–100" — technically the requested rounding, and
 * visibly broken. The fallback keeps small goals readable without giving large
 * ones spurious precision.
 */
function roundedRange(low: number, high: number, step: number): string {
  for (const candidate of [step, 10, 1].filter((s) => s <= step)) {
    const lo = Math.round(low / candidate) * candidate;
    const hi = Math.round(high / candidate) * candidate;
    if (lo > 0 && lo < hi) return `${formatNumber(lo)}–${formatNumber(hi)}`;
  }
  return `${formatNumber(low)}–${formatNumber(high)}`;
}
