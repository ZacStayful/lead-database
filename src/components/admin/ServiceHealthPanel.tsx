import { Card, CardContent } from "@/components/ui/card";
import type {
  CustomerRisk,
  ProductCapacity,
  RiskBand,
  ServiceHealth,
} from "@/lib/serviceHealth";

/**
 * Service health panel: what the lead supply can carry, and who looks like
 * leaving.
 *
 * Deliberately leads with capacity rather than the risk list. The risk list is
 * the thing you act on today; capacity is the thing that decides whether acting
 * on it matters — losing a customer when you are oversubscribed costs nothing,
 * and losing one when you have spare supply costs the full subscription.
 */

const PRODUCT_LABEL: Record<string, string> = {
  management: "Management",
  guaranteed_rent: "Guaranteed Rent",
};

const BAND_STYLE: Record<RiskBand, { label: string; className: string }> = {
  critical: { label: "Critical", className: "bg-red-100 text-red-800" },
  high: { label: "High", className: "bg-red-50 text-red-700" },
  medium: { label: "Medium", className: "bg-amber-50 text-amber-800" },
  watch: { label: "Watch", className: "bg-muted text-muted-foreground" },
  ok: { label: "Active", className: "bg-brand/10 text-brand" },
};

function gbp(n: number): string {
  return `£${n.toLocaleString("en-GB")}`;
}

/** Thin sample: a rate off this few assignments is indicative, not solid. */
const THIN_SAMPLE = 30;

/**
 * At or above this share of the physical maximum, the ceiling is assuming
 * near-total abandonment and has no margin left. Said out loud rather than
 * discounted away — the discount was considered and deliberately rejected
 * (0071), so the honest alternative is to show the exposure.
 */
const NO_MARGIN_RATIO = 0.9;

function CapacityRow({ c }: { c: ProductCapacity }) {
  const short = c.demandPerMonth - c.slotsPerMonth;
  const fromRecycling = c.sustainableCustomers - c.sustainableCustomersNewOnly;
  const thinSample = c.recyclingSample < THIN_SAMPLE;
  const noMargin =
    c.physicalMaxSlotsPerMonth > 0 &&
    c.serviceableSlotsPerMonth >= c.physicalMaxSlotsPerMonth * NO_MARGIN_RATIO;

  return (
    <div className="border-[0.5px] border-border rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">
          {PRODUCT_LABEL[c.product] ?? c.product}
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {c.fullyServed} of {c.activeCustomers} fully served this cycle
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-5">
        <div>
          <dt className="text-xs text-muted-foreground">New-lead slots / mo</dt>
          <dd className="tabular-nums">{c.slotsPerMonth}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Recycled slots / mo</dt>
          <dd className="tabular-nums">+{c.recycledSlotsPerMonth}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Promised / mo</dt>
          <dd className="tabular-nums">{c.demandPerMonth}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Actually delivered / mo</dt>
          <dd className="tabular-nums">{c.deliveredPerMonth}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Unsold in stock</dt>
          <dd className="tabular-nums">{c.inventorySlotsNow}</dd>
        </div>
      </dl>

      <p className="mt-3 text-sm">
        <span className="font-medium">
          Can carry {c.sustainableCustomers} customers at {c.avgAllocation} leads
          each. You have {c.activeCustomers}.
        </span>{" "}
        {c.roomForCustomers > 0 ? (
          <span className="text-muted-foreground">
            Room for {c.roomForCustomers} more.
          </span>
        ) : (
          <span className="text-muted-foreground">No room at current volume.</span>
        )}
      </p>

      {/* The split. Never let the combined number stand on its own — the gap is
          exactly how much headroom depends on customers staying inactive. */}
      <p className="mt-1 text-sm text-muted-foreground">
        {c.sustainableCustomersNewOnly} of those come from new leads alone
        {fromRecycling > 0 && (
          <>
            {" "}
            and {fromRecycling} from recycling leads nobody worked
            {c.unworkedRate != null && (
              <> ({Math.round(c.unworkedRate * 100)}% go unworked)</>
            )}
          </>
        )}
        . If everyone started working their leads, the ceiling would fall back to{" "}
        {c.sustainableCustomersNewOnly}.
      </p>

      {noMargin && fromRecycling > 0 && (
        <p className="mt-2 text-sm text-amber-800">
          This assumes almost every lead is sold the full 5 times —{" "}
          {c.serviceableSlotsPerMonth} of a hard maximum of{" "}
          {c.physicalMaxSlotsPerMonth}. There is no slack left in the figure, so
          treat the top of that range as a stretch rather than a plan.
        </p>
      )}

      {thinSample && (
        <p className="mt-2 text-sm text-muted-foreground">
          Recycling rate measured over just {c.recyclingSample}{" "}
          {c.recyclingSample === 1 ? "lead" : "leads"} — too few to rely on yet.
        </p>
      )}

      {c.recyclingBacklogNow > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          Plus a one-off backlog of {c.recyclingBacklogNow} ignored leads ready
          to escalate now. Like unsold stock, that clears once and does not come
          back, so it seats nobody permanently.
        </p>
      )}

      {c.borrowingFromInventory && (
        <p className="mt-2 text-sm text-amber-800">
          Promising {short} more leads a month than arrive as new, and covering
          it from the {c.inventorySlotsNow} unsold slots in stock. Everyone is
          being served today; that stops when the stock runs out — unless
          recycling keeps pace.
        </p>
      )}

      {!c.borrowingFromInventory && c.unsoldLeadsNow > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          {c.unsoldLeadsNow} leads have never been sold to anyone — there are
          more leads here than customers to buy them.
        </p>
      )}
    </div>
  );
}

function RiskRow({ r }: { r: CustomerRisk }) {
  const band = BAND_STYLE[r.band];
  return (
    <tr className="border-b-[0.5px] border-border last:border-0">
      <td className="py-2.5 pr-3">
        <div className="font-medium">{r.businessName}</div>
        <div className="text-xs text-muted-foreground">{r.email}</div>
      </td>
      <td className="py-2.5 pr-3">
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${band.className}`}
        >
          {band.label}
        </span>
      </td>
      <td className="py-2.5 pr-3 text-sm text-muted-foreground">{r.reason}</td>
      <td className="py-2.5 pr-3 text-sm tabular-nums">
        {r.lifetimeWorked}/{r.lifetimeDelivered}
        {r.lifetimeWorkedRate != null && (
          <span className="text-muted-foreground">
            {" "}
            ({Math.round(r.lifetimeWorkedRate * 100)}%)
          </span>
        )}
      </td>
      <td className="py-2.5 text-sm tabular-nums">{gbp(r.monthlyValueGbp)}/mo</td>
    </tr>
  );
}

export function ServiceHealthPanel({ health }: { health: ServiceHealth }) {
  // Say so plainly rather than rendering convincing zeros. An empty capacity
  // panel reading "0 leads a month, room for 0 customers" is worse than no
  // panel: it is a wrong answer presented in the same shape as a right one.
  if (health.unavailable) {
    return (
      <Card>
        <CardContent className="p-5">
          <h2 className="text-base font-medium">Service health unavailable</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The capacity and churn-risk figures could not be read. This normally
            means the database migration for this feature has not been applied to
            this environment yet. Everything else on this page is unaffected.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Everyone active in the last week is hidden by default. A list that includes
  // the customers doing fine is a list nobody reads twice, and re-engagement is
  // supposed to remove somebody from view — showing them anyway would make that
  // invisible.
  const flagged = health.risk.filter((r) => r.band !== "ok");
  const healthy = health.risk.length - flagged.length;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5">
          <h2 className="text-base font-medium">How many customers can we serve</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Two things refill every month and both count: new leads arriving, and
            leads nobody worked coming back through escalation. One-off stock —
            unsold leads and the ignored-lead backlog — is shown separately and
            never added, because it seats a customer once and never again.
            Delivered is what actually happened, as the check on all of it.
            Recalculated on every page load.
          </p>
          <div className="mt-4 space-y-3">
            {health.capacity.map((c) => (
              <CapacityRow key={c.product} c={c} />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-medium">Customers who may leave</h2>
            <span className="text-sm">
              <span className="text-muted-foreground">At risk: </span>
              <span className="font-medium tabular-nums">
                {gbp(health.revenueAtRiskGbp)}/mo
              </span>
              <span className="text-muted-foreground">
                {" "}
                of {gbp(health.totalMonthlyRevenueGbp)}
              </span>
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Ranked on how long a customer has gone without touching the platform,
            and how much of what they were sent they have ever worked. Anyone who
            signs in or opens a lead drops off this list automatically. These are
            stated rules, not a prediction — no customer has cancelled yet, so
            there is nothing to learn a real model from.
          </p>

          {flagged.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Nobody is currently flagged. All {healthy} active customers have
              used the platform in the last week.
            </p>
          ) : (
            <>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b-[0.5px] border-border text-xs text-muted-foreground">
                      <th className="pb-2 pr-3 font-normal">Customer</th>
                      <th className="pb-2 pr-3 font-normal">Risk</th>
                      <th className="pb-2 pr-3 font-normal">Why</th>
                      <th className="pb-2 pr-3 font-normal">Leads worked</th>
                      <th className="pb-2 font-normal">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flagged.map((r) => (
                      <RiskRow key={r.customerId} r={r} />
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {healthy} other active {healthy === 1 ? "customer" : "customers"}{" "}
                used the platform in the last week and {healthy === 1 ? "is" : "are"}{" "}
                not shown.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
