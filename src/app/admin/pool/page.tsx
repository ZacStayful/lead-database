import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getPoolOverview } from "@/lib/pool";
import { formatDateTime, formatGBP } from "@/lib/utils";
import {
  AdminPoolTable,
  ForcePoolIn,
} from "@/components/admin/AdminPoolTable";

export const dynamic = "force-dynamic";

/**
 * Admin → Expired leads.
 *
 * Both pools read-only, the manual override, and the claim log.
 *
 * `barred` is given equal billing with `in pool` on purpose. A management pool
 * of six against 151 leads reads as broken until you can see that most of the
 * rest are barred for having been genuinely worked — the small number is the
 * feature succeeding, not failing, and the panel should say so without anyone
 * having to run a query.
 */
export default async function AdminPoolPage() {
  const { unavailable, summary, management, guaranteedRent, claims } =
    await getPoolOverview();

  if (unavailable) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Expired leads</h1>
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">
            The expired leads pool could not be read. This normally means the
            database migrations for this feature have not been applied to this
            environment yet.
          </CardContent>
        </Card>
      </div>
    );
  }

  const byType = (t: string) => summary.find((s) => s.leadType === t);
  const mgmt = byType("management");
  const gr = byType("guaranteed_rent");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Expired leads</h1>
        <p className="text-sm text-muted-foreground">
          Leads nobody worked, open to any subscriber of that product to call and
          claim. The daily sweep runs at 10:30.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {[
          { label: "Management", s: mgmt },
          { label: "Guaranteed Rent", s: gr },
        ].map(({ label, s }) => (
          <Card key={label}>
            <CardContent className="space-y-3 p-5">
              <div className="flex items-baseline justify-between">
                <p className="font-semibold">{label}</p>
                <p className="text-2xl font-bold tabular-nums">
                  {s?.inPool ?? 0}
                </p>
              </div>
              <dl className="space-y-1 text-sm text-muted-foreground">
                <div className="flex justify-between">
                  <dt>Never assigned (still allocatable)</dt>
                  <dd className="tabular-nums">{s?.inPoolUnassigned ?? 0}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Assigned and not worked</dt>
                  <dd className="tabular-nums">{s?.inPoolIgnored ?? 0}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Entering on the next sweep</dt>
                  <dd className="tabular-nums">{s?.pendingEntry ?? 0}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Claimed to date</dt>
                  <dd className="tabular-nums">{s?.claimedTotal ?? 0}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Barred (worked, closed or won)</dt>
                  <dd className="tabular-nums">{s?.barredTotal ?? 0}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Expired / removed by hand</dt>
                  <dd className="tabular-nums">
                    {s?.expiredTotal ?? 0} / {s?.excludedTotal ?? 0}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Longest in the pool</dt>
                  <dd className="tabular-nums">{s?.oldestInPoolDays ?? 0}d</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Management pool</h2>
        <AdminPoolTable
          leads={management}
          emptyLabel="No management leads in the pool. Everything sent out is being worked."
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Guaranteed rent pool</h2>
        <AdminPoolTable
          leads={guaranteedRent}
          emptyLabel="No guaranteed rent leads in the pool."
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Force a lead into the pool</h2>
        <p className="text-sm text-muted-foreground">
          Overrides the 25-day clock and the eligibility bars. A lead somebody has
          already claimed cannot be returned, and neither can one withdrawn on a
          swap.
        </p>
        <ForcePoolIn />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Claim history</h2>
        {claims.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nothing has been claimed yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">Claimed</th>
                  <th className="px-3 py-2 font-medium">Lead</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">Charged</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Their debit now</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.assignmentId} className="border-t">
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDateTime(c.claimedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/leads/${c.leadId}`}
                        className="font-medium hover:underline"
                      >
                        {c.leadName}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/customers/${c.customerId}`}
                        className="hover:underline"
                      >
                        {c.businessName}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="secondary">
                        {c.leadType === "guaranteed_rent"
                          ? "Guaranteed Rent"
                          : "Management"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {formatGBP(c.pricePaid)}
                    </td>
                    <td className="px-3 py-2">{c.status}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {c.customerPoolDebit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
