import type { SupabaseClient } from '@supabase/supabase-js';

// Marketplace launch anchor — the "…since 1 July 2026" date shown on the
// landing page. Both the counter and the ledger are scoped to on/after this.
export const SINCE_DATE = '2026-07-01';

// How long a cached snapshot is considered fresh. Past this, the public
// endpoint regenerates it on the next request (see /api/stats/public), so the
// section refreshes roughly daily WITHOUT depending on the scheduled cron or
// the CRON_SECRET. The cron remains as a belt-and-braces scheduled refresh.
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// Derive the postcode DISTRICT (the outward code, e.g. "M14", "SW9") from the
// lead's address. This is more specific than a broad region but still covers
// thousands of addresses, so it never identifies a single property. We only
// ever keep this outward half — never the full address or the inward code
// (the "5TP" part), which together would pinpoint an individual property.
// "UK" is an intentional fallback bucket for addresses with no parseable
// postcode — not a gap to close.
const OUTWARD_CODE_REGEX = /\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*\d[A-Z]{2}\b/i;

export function deriveLocation(address: string | null | undefined): string {
  if (!address) return 'UK';
  const match = address.match(OUTWARD_CODE_REGEX);
  if (!match) return 'UK';
  return match[1].toUpperCase().replace(/\s+/g, '');
}

export type LedgerEntry = {
  location: string;
  bedrooms: string | number | null;
  assigned_at: string;
};

export type PublicActivityStats = {
  total_distributed: number;
  since_date: string;
  ledger: LedgerEntry[];
  generated_at: string;
};

// Recompute the public activity snapshot from live data and persist it to the
// public_activity_stats singleton (id = 1). Throws on any Supabase error so the
// caller can decide how to handle failure. Requires a service-role client.
export async function generatePublicStats(
  supabase: SupabaseClient
): Promise<PublicActivityStats> {
  // Counter: the number of ACTUAL leads passed into the database since launch —
  // one per lead, counted straight off the leads table. Counting
  // lead_assignments would inflate it, since a lead can be distributed to up to
  // two operators and would then be tallied twice. head:true returns only the
  // count (no rows), so this stays cheap as volume grows.
  const { count, error: countError } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', SINCE_DATE);
  if (countError) throw new Error(countError.message);

  // Ledger: the most recent distributions, de-duplicated to one row per lead so
  // the same property never appears twice (it would otherwise show once per
  // operator it was sent to). Over-fetch, then keep only the newest row per
  // lead until we have 20 unique properties.
  const { data: recent, error: recentError } = await supabase
    .from('lead_assignments')
    .select('lead_id, assigned_at, leads(address, bedrooms)')
    .gte('assigned_at', SINCE_DATE)
    .order('assigned_at', { ascending: false })
    .limit(60);
  if (recentError) throw new Error(recentError.message);

  const seenLeadIds = new Set<string>();
  const ledger: LedgerEntry[] = [];
  for (const row of (recent ?? []) as any[]) {
    if (row.lead_id) {
      if (seenLeadIds.has(row.lead_id)) continue;
      seenLeadIds.add(row.lead_id);
    }
    ledger.push({
      location: deriveLocation(row.leads?.address),
      bedrooms: row.leads?.bedrooms ?? null,
      assigned_at: row.assigned_at,
    });
    if (ledger.length >= 20) break;
  }

  const stats: PublicActivityStats = {
    total_distributed: count ?? 0,
    since_date: SINCE_DATE,
    ledger,
    generated_at: new Date().toISOString(),
  };

  const { error: upsertError } = await supabase
    .from('public_activity_stats')
    .upsert({ id: 1, ...stats });
  if (upsertError) throw new Error(upsertError.message);

  return stats;
}
