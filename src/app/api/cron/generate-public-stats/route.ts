import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const SINCE_DATE = '2026-07-01';

// Derive the postcode DISTRICT (the outward code, e.g. "M14", "SW9") from the
// lead's address. This is more specific than a broad region but still covers
// thousands of addresses, so it never identifies a single property. We only
// ever keep this outward half — never the full address or the inward code
// (the "5TP" part), which together would pinpoint an individual property.
// "UK" is an intentional fallback bucket for addresses with no parseable
// postcode — not a gap to close.
const OUTWARD_CODE_REGEX = /\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*\d[A-Z]{2}\b/i;

function deriveLocation(address: string | null | undefined): string {
  if (!address) return 'UK';
  const match = address.match(OUTWARD_CODE_REGEX);
  if (!match) return 'UK';
  return match[1].toUpperCase().replace(/\s+/g, '');
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // The public counter reflects the number of ACTUAL leads passed into the
  // database since launch — one per lead, counted straight off the leads table.
  // Counting lead_assignments would inflate it, since a lead can be distributed
  // to up to two operators and would then be tallied twice. head:true returns
  // only the count (no rows), so this stays accurate as volume grows.
  const { count: totalDistributed, error: countError } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', SINCE_DATE);

  if (countError) {
    return NextResponse.json({ error: countError.message }, { status: 500 });
  }

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

  if (recentError) {
    return NextResponse.json({ error: recentError.message }, { status: 500 });
  }

  const seenLeadIds = new Set<string>();
  const ledger: { location: string; bedrooms: string | number | null; assigned_at: string }[] = [];
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

  const { error: upsertError } = await supabase
    .from('public_activity_stats')
    .upsert({
      id: 1,
      total_distributed: totalDistributed ?? 0,
      since_date: SINCE_DATE,
      ledger,
      generated_at: new Date().toISOString(),
    });

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, totalDistributed, ledgerCount: ledger.length });
}
