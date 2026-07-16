import type { SupabaseClient } from '@supabase/supabase-js';

// Marketplace launch anchor — the "…since 1 July 2026" date shown on the
// landing page. Both the counter and the ledger are scoped to on/after this.
export const SINCE_DATE = '2026-07-01';

// How long a cached snapshot is considered fresh. Past this, the public
// endpoint regenerates it on the next request (see /api/stats/public), so the
// section refreshes on its own WITHOUT depending on the scheduled cron or the
// CRON_SECRET. Kept short (a few hours) so new leads — and any change to how
// the snapshot is built — surface within hours rather than after a full day.
// Regeneration is gated on staleness, so this bounds DB work to a few rebuilds
// per day regardless of traffic. The cron remains a belt-and-braces refresh.
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

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

// Normalise the free-text bedroom count (from Monday/the enquiry form) into a
// tidy public label. The raw field is messy — "3 Bed", "2 bedrooms",
// "1 bedrooms", "4+ bed", "12 bedrooms", even "5-77 bedrooms" — so we take the
// first integer and render "N Bed", bucketing anything 5+ as "5+ Bed" (large or
// nonsensical counts should never appear verbatim on the marketing page).
// Returns null when there's no usable number, so the caller can drop the row.
export function normalizeBedrooms(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  const match = text.match(/\d+/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 5) return '5+ Bed';
  const hasPlus = new RegExp(`${n}\\s*\\+`).test(text);
  return `${n}${hasPlus ? '+' : ''} Bed`;
}

// A ledger entry is in the current clean format iff its label looks like
// "3 Bed" / "4+ Bed" / "5+ Bed". Used by the public endpoint to force a rebuild
// when a cached snapshot predates this normalisation.
export const CLEAN_BEDROOM_LABEL = /^\d+\+? Bed$/;

export type LedgerEntry = {
  location: string;
  bedrooms: string;
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

  // Ledger: the most recent leads received into the marketplace, rendered as up
  // to 20 rows that are each visibly distinct. We show recent *arrivals* (by
  // created_at) rather than distribution events, so the list refreshes daily as
  // new enquiries come in — distributions can stall (few active operators) while
  // leads keep arriving. Over-fetch, then skip a row when its bedroom count
  // doesn't parse or another row already shows the same "<beds> · <district>".
  const { data: recent, error: recentError } = await supabase
    .from('leads')
    .select('created_at, address, bedrooms')
    .gte('created_at', SINCE_DATE)
    .order('created_at', { ascending: false })
    .limit(150);
  if (recentError) throw new Error(recentError.message);

  const seenDisplay = new Set<string>();
  const ledger: LedgerEntry[] = [];
  for (const row of (recent ?? []) as any[]) {
    const bedrooms = normalizeBedrooms(row.bedrooms);
    if (!bedrooms) continue;
    const location = deriveLocation(row.address);
    const display = `${bedrooms}|${location}`;
    if (seenDisplay.has(display)) continue;
    seenDisplay.add(display);
    // `assigned_at` is the public timestamp the frontend renders as "… ago";
    // for a leads-sourced ledger it carries the lead's arrival time.
    ledger.push({ location, bedrooms, assigned_at: row.created_at });
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
