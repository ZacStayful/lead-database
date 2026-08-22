/**
 * The admin view of API and MCP usage.
 *
 * Reads the same three tables the customer's own panel does, so an admin and a
 * customer are never looking at two different definitions of "how much has this
 * been used".
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface AdminRequestRow {
  id: string;
  request_id: string;
  key_id: string | null;
  customer_id: string | null;
  surface: string;
  operation: string;
  status_code: number;
  error_code: string | null;
  duration_ms: number | null;
  created_at: string;
  business_name: string | null;
}

export interface CustomerApiRollup {
  customerId: string;
  businessName: string;
  liveKeys: number;
  lastUsedAt: string | null;
  last7d: number;
  last30d: number;
  errors7d: number;
}

export interface ApiOverview {
  enabled: boolean;
  customersWithKeys: number;
  liveKeys: number;
  requestsToday: number;
  restToday: number;
  mcpToday: number;
  errorsByCode: { code: string; count: number }[];
  recent: AdminRequestRow[];
  perCustomer: CustomerApiRollup[];
}

export async function getApiOverview(
  recentLimit = 200,
  adminClient?: Admin
): Promise<ApiOverview> {
  const admin = adminClient ?? createAdminClient();
  const now = Date.now();
  const since24h = new Date(now - 86_400_000).toISOString();
  const since7d = new Date(now - 7 * 86_400_000).toISOString();
  const since30d = new Date(now - 30 * 86_400_000).toISOString();

  const [settingRes, keysRes, recentRes, weekRes] = await Promise.all([
    admin.from("system_settings").select("value").eq("key", "api_enabled").maybeSingle(),
    admin
      .from("customer_api_keys")
      .select("id, customer_id, last_used_at, revoked_at, customers(business_name)")
      .is("revoked_at", null),
    admin
      .from("api_request_log")
      .select(
        "id, request_id, key_id, customer_id, surface, operation, status_code, error_code, duration_ms, created_at, customers(business_name)"
      )
      .order("created_at", { ascending: false })
      .limit(recentLimit),
    // 30 days of rows for the rollups. Bounded by the 30-day sweep, so this
    // cannot grow without limit however busy the API gets.
    admin
      .from("api_request_log")
      .select("customer_id, surface, status_code, error_code, created_at")
      .gte("created_at", since30d)
      .limit(20_000),
  ]);

  const enabled = ((settingRes.data as { value?: string } | null)?.value ?? "true").trim() === "true";

  const keys = (keysRes.data ?? []) as unknown as {
    id: string;
    customer_id: string;
    last_used_at: string | null;
    customers: { business_name: string } | null;
  }[];

  const week = (weekRes.data ?? []) as {
    customer_id: string | null;
    surface: string;
    status_code: number;
    error_code: string | null;
    created_at: string;
  }[];

  const rollups = new Map<string, CustomerApiRollup>();
  for (const k of keys) {
    const existing = rollups.get(k.customer_id);
    if (existing) {
      existing.liveKeys += 1;
      if (k.last_used_at && (!existing.lastUsedAt || k.last_used_at > existing.lastUsedAt)) {
        existing.lastUsedAt = k.last_used_at;
      }
    } else {
      rollups.set(k.customer_id, {
        customerId: k.customer_id,
        businessName: k.customers?.business_name ?? "(unknown)",
        liveKeys: 1,
        lastUsedAt: k.last_used_at,
        last7d: 0,
        last30d: 0,
        errors7d: 0,
      });
    }
  }

  let requestsToday = 0;
  let restToday = 0;
  let mcpToday = 0;
  const errorCounts = new Map<string, number>();

  for (const row of week) {
    const isToday = row.created_at >= since24h;
    const isWeek = row.created_at >= since7d;

    if (isToday) {
      requestsToday += 1;
      if (row.surface === "mcp") mcpToday += 1;
      else restToday += 1;
    }
    if (isWeek && row.error_code) {
      errorCounts.set(row.error_code, (errorCounts.get(row.error_code) ?? 0) + 1);
    }

    if (!row.customer_id) continue;
    const roll = rollups.get(row.customer_id);
    if (!roll) continue;
    roll.last30d += 1;
    if (isWeek) {
      roll.last7d += 1;
      if (row.status_code >= 400) roll.errors7d += 1;
    }
  }

  const recent = ((recentRes.data ?? []) as unknown as (AdminRequestRow & {
    customers: { business_name: string } | null;
  })[]).map((r) => ({ ...r, business_name: r.customers?.business_name ?? null }));

  return {
    enabled,
    customersWithKeys: rollups.size,
    liveKeys: keys.length,
    requestsToday,
    restToday,
    mcpToday,
    // Array.from rather than spreading the iterator: this project's TS target
    // predates Map iteration, the same constraint /api/auth/forgot-password
    // documents where it uses forEach over for..of.
    errorsByCode: Array.from(errorCounts.entries())
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    recent,
    // Busiest first, so a runaway integration is the top row rather than
    // something to scroll for.
    perCustomer: Array.from(rollups.values()).sort((a, b) => b.last7d - a.last7d),
  };
}
