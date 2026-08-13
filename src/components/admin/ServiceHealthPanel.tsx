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

function CapacityRow({ c }: { c: ProductCapacity }) {
  const over = c.headroomPerMonth < 0;
  const pct = c.utilisation == null ? null : Math.round(c.utilisation * 100);

  return (
    <div className="border-[0.5px] border-border rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">
          {PRODUCT_LABEL[c.product] ?? c.product}
        </h3>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            over ? "bg-red-100 text-red-800" : "bg-brand/10 text-brand"
          }`}
        >
          {pct == null ? "No supply data" : `${pct}% of supply committed`}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">New leads / month</dt>
          <dd className="tabular-nums">{c.leadsPerMonth}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Sellable slots / month</dt>
          <dd className="tabular-nums">{c.slotsPerMonth}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            Committed ({c.activeCustomers} customers)
          </dt>
          <dd className="tabular-nums">{c.demandPerMonth}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Spare / month</dt>
          <dd className={`tabular-nums ${over ? "text-red-700 font-medium" : ""}`}>
            {c.headroomPerMonth}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-sm text-muted-foreground">
        {over ? (
          <>
            <span className="font-medium text-red-700">Oversubscribed.</span>{" "}
            Customers are promised {Math.abs(c.headroomPerMonth)} more leads a
            month than arrive, so allocations run out early and nobody should be
            added until supply or the escalation ladder closes the gap.
          </>
        ) : (
          <>
            Room for roughly{" "}
            <span className="font-medium text-foreground">
              {c.roomForCustomers.atTwenty} more 20-lead
            </span>{" "}
            or{" "}
            <span className="font-medium text-foreground">
              {c.roomForCustomers.atTen} more 10-lead
            </span>{" "}
            customers.
          </>
        )}{" "}
        {c.openSlotsNow > 0 && (
          <>
            {c.openSlotsNow} slots unfilled right now across the back catalogue
            {c.unsoldLeadsNow > 0
              ? `, ${c.unsoldLeadsNow} leads never sold to anyone.`
              : "."}
          </>
        )}
      </p>
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
            Derived from leads actually ingested over the last 28 days and the
            caps those leads carry, so it moves on its own as volume changes and
            as escalation opens extra slots. Recalculated on every page load.
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
