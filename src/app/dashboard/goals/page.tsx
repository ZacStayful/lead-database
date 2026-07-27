import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { GoalForm } from "@/components/dashboard/GoalForm";

export const dynamic = "force-dynamic";

/**
 * The long-run conversion assumption behind the pipeline estimate: roughly one
 * signed management client per twenty leads. It is an average over the whole
 * book, not a promise about any twenty leads in particular — which is why it
 * only ever drives the supporting estimate, never the completion check.
 */
const LEADS_PER_WON_CLIENT = 20;

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

function EstimateRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
