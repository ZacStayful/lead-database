/**
 * Reading API usage back out, for the customer's settings panel and for admin.
 *
 * SHARED BY BOTH SURFACES so the customer and the admin are never looking at
 * two different definitions of "how much has this key been used".
 *
 * Usage is DERIVED, never counted on the request path. The 24-hour figure is
 * summed live from the rate-limit windows (which exist anyway and are swept
 * daily), and the 30-day figure comes from the rollup the sweep writes before it
 * deletes them. A request_count column on customer_api_keys would have been
 * simpler to read and would have turned every API read into a database write.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface KeyUsage {
  last24h: number;
  last30d: number;
}

export interface RecentRequest {
  request_id: string;
  surface: string;
  operation: string;
  status_code: number;
  error_code: string | null;
  created_at: string;
}

/** Per-key usage for a set of key ids. Missing keys simply have no entry. */
export async function usageForKeys(
  keyIds: string[],
  adminClient?: Admin
): Promise<Record<string, KeyUsage>> {
  const out: Record<string, KeyUsage> = {};
  if (keyIds.length === 0) return out;

  const admin = adminClient ?? createAdminClient();
  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const [windows, rollup] = await Promise.all([
    admin
      .from("api_rate_limits")
      .select("subject_id, request_count")
      .eq("subject_kind", "key")
      .in("subject_id", keyIds)
      .gte("window_start", since24h),
    admin
      .from("api_usage_daily")
      .select("key_id, request_count")
      .in("key_id", keyIds)
      .gte("day", since30d),
  ]);

  for (const id of keyIds) out[id] = { last24h: 0, last30d: 0 };

  for (const row of (windows.data ?? []) as { subject_id: string; request_count: number }[]) {
    const entry = out[row.subject_id];
    if (entry) entry.last24h += row.request_count;
  }
  for (const row of (rollup.data ?? []) as { key_id: string; request_count: number }[]) {
    const entry = out[row.key_id];
    if (entry) entry.last30d += row.request_count;
  }

  // The rollup only covers windows the sweep has already folded in, so today's
  // traffic would be missing from the 30-day figure until tomorrow morning.
  for (const id of keyIds) out[id]!.last30d += out[id]!.last24h;

  return out;
}

/** The most recent requests for one customer — their own rows only. */
export async function recentRequestsForCustomer(
  customerId: string,
  limit = 20,
  adminClient?: Admin
): Promise<RecentRequest[]> {
  const admin = adminClient ?? createAdminClient();
  const { data, error } = await admin
    .from("api_request_log")
    .select("request_id, surface, operation, status_code, error_code, created_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[api] recent requests read failed", error);
    return [];
  }
  return (data ?? []) as RecentRequest[];
}
