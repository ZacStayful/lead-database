/**
 * /admin/api — what the API and MCP server are actually doing.
 *
 * REST AND MCP SIDE BY SIDE THROUGHOUT. They are one feature with two front
 * doors, and a view that showed only one would hide exactly the half somebody
 * investigating an integration came looking for.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ApiKillSwitch } from "@/components/admin/ApiKillSwitch";
import { getApiOverview } from "@/lib/api/adminUsage";
import { RATE_LIMIT_PER_DAY, RATE_LIMIT_PER_MINUTE } from "@/lib/api/limits";

export const dynamic = "force-dynamic";

function when(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border-[0.5px] border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default async function AdminApiPage() {
  const overview = await getApiOverview();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">API and MCP</h1>
        <p className="text-sm text-muted-foreground">
          Read-only access customers use from their own tools. Limits are{" "}
          {RATE_LIMIT_PER_MINUTE} requests a minute per key and{" "}
          {RATE_LIMIT_PER_DAY.toLocaleString("en-GB")} a day per customer.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Service</CardTitle>
        </CardHeader>
        <CardContent>
          <ApiKillSwitch enabled={overview.enabled} />
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Customers with a live key" value={String(overview.customersWithKeys)} />
        <Stat label="Live keys" value={String(overview.liveKeys)} />
        <Stat
          label="Requests today"
          value={String(overview.requestsToday)}
          hint={`${overview.restToday} REST · ${overview.mcpToday} MCP`}
        />
        <Stat
          label="Errors this week"
          value={String(overview.errorsByCode.reduce((n, e) => n + e.count, 0))}
        />
      </div>

      {overview.errorsByCode.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Errors, last 7 days</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {overview.errorsByCode.map((e) => (
                <Badge key={e.code} variant="muted">
                  {e.code}: {e.count}
                </Badge>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              A run of <code>rate_limited</code> means the limits are set wrong for
              real use. A run of <code>invalid_api_key</code> means somebody is
              either fumbling their setup or probing.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>By customer</CardTitle>
        </CardHeader>
        <CardContent>
          {overview.perCustomer.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No customer holds an API key yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-[0.5px] border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Customer</th>
                    <th className="py-2 pr-3 font-medium">Keys</th>
                    <th className="py-2 pr-3 font-medium">Last used</th>
                    <th className="py-2 pr-3 font-medium">7 days</th>
                    <th className="py-2 pr-3 font-medium">30 days</th>
                    <th className="py-2 font-medium">Errors (7d)</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.perCustomer.map((c) => (
                    <tr key={c.customerId} className="border-b-[0.5px] border-border">
                      <td className="py-2 pr-3">{c.businessName}</td>
                      <td className="py-2 pr-3">{c.liveKeys}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{when(c.lastUsedAt)}</td>
                      <td className="py-2 pr-3">{c.last7d}</td>
                      <td className="py-2 pr-3">{c.last30d}</td>
                      <td className="py-2">
                        {c.errors7d > 0 ? (
                          <span className="text-red-700">{c.errors7d}</span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent requests</CardTitle>
        </CardHeader>
        <CardContent>
          {overview.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing yet. Rejected requests appear here too — a bad key or a
              tripped limit is usually what you are looking for.
            </p>
          ) : (
            <div className="max-h-[32rem] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b-[0.5px] border-border text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">Customer</th>
                    <th className="py-2 pr-3 font-medium">Via</th>
                    <th className="py-2 pr-3 font-medium">Operation</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">ms</th>
                    <th className="py-2 font-medium">Request id</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recent.map((r) => (
                    <tr key={r.id} className="border-b-[0.5px] border-border">
                      <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">
                        {when(r.created_at)}
                      </td>
                      <td className="py-1.5 pr-3">{r.business_name ?? "—"}</td>
                      <td className="py-1.5 pr-3 uppercase text-muted-foreground">{r.surface}</td>
                      <td className="py-1.5 pr-3 font-mono">{r.operation}</td>
                      <td className="py-1.5 pr-3">
                        {r.status_code < 400 ? (
                          <span className="text-emerald-700">{r.status_code}</span>
                        ) : (
                          <span className="text-red-700">
                            {r.status_code} {r.error_code}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground">
                        {r.duration_ms ?? "—"}
                      </td>
                      <td className="py-1.5 font-mono text-muted-foreground">{r.request_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
