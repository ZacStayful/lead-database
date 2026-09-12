/**
 * /admin/allocation — the daily-release switch, and the reading beside it (§54).
 *
 * The headline number is DELIVERY DAYS PER CUSTOMER over the last 30 days. It
 * was 2.0 when this shipped: the whole allocation landed on one or two days
 * and the dashboard sat unopened for the rest of the month. A working switch
 * moves it towards the working days in a month.
 *
 * A switch with no reading next to it is a switch nobody dares press (§40.14),
 * so the position sits on this page rather than a separate one — and the one
 * reading that can silently break the rule, a stale billing anchor, is named
 * here rather than left to be discovered.
 */
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createAdminClient } from "@/lib/supabase/admin";
import { AllocationSettingsPanel } from "@/components/admin/AllocationSettingsPanel";
import { MESSAGING_SETTINGS } from "@/lib/messaging/adminSettings";
import { RELEASE_SETTING_KEYS, londonDate, releaseSettingsFrom } from "@/lib/pacing";
import { deliveryDaysPerCustomer, releaseOverview, stockSummary } from "@/lib/releaseStats";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border-[0.5px] border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ymd(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
}

export default async function AdminAllocationPage() {
  const admin = createAdminClient();
  const now = new Date();
  const today = londonDate(now);
  // A generous window; rows are then filtered to today's LONDON date, which is
  // what the SQL rule counts against the daily cap.
  const todayStartIso = new Date(now.getTime() - 36 * 3_600_000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  const releaseKeys = MESSAGING_SETTINGS.filter((s) => s.key.startsWith("release_")).map(
    (s) => s.key
  );

  const [settingRows, customersRes, todayRes, windowRes, stockRes] = await Promise.all([
    admin.from("system_settings").select("key, value").in("key", releaseKeys),
    admin
      .from("customers")
      .select("*")
      .eq("is_active", true)
      .or("subscription_status.eq.active,gr_subscription_status.eq.active"),
    admin
      .from("lead_assignments")
      .select("customer_id, assigned_at, lead:leads!inner(lead_type, owner_customer_id)")
      .gte("assigned_at", todayStartIso),
    admin
      .from("lead_assignments")
      .select("customer_id, assigned_at, claimed_from_pool_at, lead:leads!inner(owner_customer_id)")
      .gte("assigned_at", thirtyDaysAgo),
    admin
      .from("leads")
      .select("created_at, lead_type, assignment_count, max_assignments")
      .is("owner_customer_id", null)
      .is("withdrawn_at", null)
      .is("pool_expired_at", null),
  ]);

  const settings = releaseSettingsFrom(
    (settingRows.data ?? []).filter((r) =>
      (RELEASE_SETTING_KEYS as readonly string[]).includes((r as { key: string }).key)
    ) as { key: string; value: string }[]
  );
  const stored = new Map(
    (settingRows.data ?? []).map((r) => [(r as { key: string }).key, (r as { value: string }).value])
  );
  const values = Object.fromEntries(
    MESSAGING_SETTINGS.filter((s) => releaseKeys.includes(s.key)).map((s) => [
      s.key,
      stored.get(s.key) ?? s.fallback,
    ])
  );

  const customers = (customersRes.data ?? []) as Customer[];

  const todayCounts = new Map<string, number>();
  for (const row of (todayRes.data ?? []) as unknown as {
    customer_id: string;
    assigned_at: string;
    lead: { lead_type: string; owner_customer_id: string | null } | null;
  }[]) {
    if (londonDate(new Date(row.assigned_at)) !== today) continue;
    const key = `${row.customer_id}:${row.lead?.lead_type ?? "management"}`;
    todayCounts.set(key, (todayCounts.get(key) ?? 0) + 1);
  }

  const overview = releaseOverview(customers, todayCounts, settings, now);

  const windowRows = ((windowRes.data ?? []) as unknown as {
    customer_id: string;
    assigned_at: string;
    claimed_from_pool_at: string | null;
    lead: { owner_customer_id: string | null } | null;
  }[]).filter((r) => r.claimed_from_pool_at == null && r.lead?.owner_customer_id == null);
  const kpi = deliveryDaysPerCustomer(windowRows);

  const stockRows = (stockRes.data ?? []) as {
    created_at: string;
    lead_type: string;
    assignment_count: number | null;
    max_assignments: number | null;
  }[];
  const mgmtStock = stockSummary(stockRows, "management", now);
  const grStock = stockSummary(stockRows, "guaranteed_rent", now);

  const rows = [...overview.rows].sort((a, b) => {
    const ad = a.schedule.nextReleaseDate ?? "9999";
    const bd = b.schedule.nextReleaseDate ?? "9999";
    return ad.localeCompare(bd) || a.businessName.localeCompare(b.businessName);
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Allocation</h1>
        <p className="text-sm text-muted-foreground">
          How a customer&apos;s month of leads is released. One switch, for every
          customer at once; a per-customer exemption lives on their own page.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Delivery days per customer, last 30 days"
          value={String(kpi.perCustomer)}
          hint={`${kpi.deliveryDays} delivery days across ${kpi.customers} customers · was 2.0 before the daily release`}
        />
        <Stat
          label="Slot open today"
          value={String(overview.slotOpenToday)}
          hint={`${overview.heldAtCapToday} at the daily cap · ${overview.onHold} on hold · ${overview.exhausted} had everything this cycle`}
        />
        <Stat
          label="Leads in stock"
          value={`${mgmtStock.count} / ${grStock.count}`}
          hint={`management / GR with a free slot · oldest ${mgmtStock.oldestDays ?? "—"} / ${grStock.oldestDays ?? "—"} days`}
        />
        <Stat
          label="Stale billing anchors"
          value={String(overview.staleAnchors)}
          hint={
            overview.staleAnchors > 0
              ? "older than the cycle — the rule lets these customers through unchecked (CLAUDE.md §11)"
              : "none — every anchor is within the cycle"
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Switch</CardTitle>
        </CardHeader>
        <CardContent>
          <AllocationSettingsPanel
            initial={values}
            slotOpenToday={overview.slotOpenToday}
            onHold={overview.onHold}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where each customer sits today</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active customers.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-[0.5px] border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3">Customer</th>
                    <th className="py-2 pr-3">Product</th>
                    <th className="py-2 pr-3">Working day</th>
                    <th className="py-2 pr-3">Received / owed this cycle</th>
                    <th className="py-2 pr-3">Today</th>
                    <th className="py-2 pr-3">Next lead</th>
                    <th className="py-2 pr-3">Anchor age</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const s = r.schedule;
                    const next = s.mode === "immediate"
                      ? "immediate (exempt)"
                      : s.onHoldUntil
                        ? `on hold until ${r.schedule.onHoldUntil}`
                        : s.exhausted
                          ? "all delivered — renewal"
                          : s.dueToday
                            ? "today"
                            : s.nextReleaseDate
                              ? ymd(s.nextReleaseDate)
                              : "—";
                    return (
                      <tr key={`${r.customerId}:${r.leadType}`} className="border-b-[0.5px] border-border">
                        <td className="py-2 pr-3">
                          <Link href={`/admin/customers/${r.customerId}`} className="underline-offset-2 hover:underline">
                            {r.businessName}
                          </Link>
                        </td>
                        <td className="py-2 pr-3">{r.leadType === "guaranteed_rent" ? "GR" : "Mgmt"}</td>
                        <td className="py-2 pr-3">
                          {s.workingDaysElapsed} of {s.workingDaysInCycle}
                        </td>
                        <td className="py-2 pr-3">
                          {s.received} / {s.entitlement}
                          {s.enabled && s.mode === "daily" ? ` (allowed ${s.allowance})` : ""}
                        </td>
                        <td className="py-2 pr-3">{s.receivedToday}</td>
                        <td className="py-2 pr-3">{next}</td>
                        <td className={`py-2 pr-3 ${r.anchorAgeDays > settings.cycleDays ? "text-red-700" : ""}`}>
                          {r.anchorAgeDays}d
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
    </div>
  );
}
