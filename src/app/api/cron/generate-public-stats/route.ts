import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SINCE_DATE = '2026-07-01';

// Approximate UK postcode-area -> region mapping, used only to derive a
// broad region for display — never store or return the underlying address.
// "Other region" is an intentional fallback bucket, not a gap to close —
// do not remove it or force an unmatched postcode into a guessed region.
const POSTCODE_AREA_REGION: Record<string, string> = {
  E: 'London', EC: 'London', N: 'London', NW: 'London', SE: 'London', SW: 'London', W: 'London', WC: 'London',
  BN: 'South East', CT: 'South East', GU: 'South East', ME: 'South East', OX: 'South East', PO: 'South East',
  RG: 'South East', RH: 'South East', SL: 'South East', SO: 'South East', TN: 'South East', KT: 'South East',
  SM: 'South East', CR: 'South East', DA: 'South East', TW: 'South East',
  BA: 'South West', BH: 'South West', BS: 'South West', DT: 'South West', EX: 'South West', GL: 'South West',
  PL: 'South West', SN: 'South West', SP: 'South West', TA: 'South West', TQ: 'South West', TR: 'South West',
  AL: 'East of England', CB: 'East of England', CM: 'East of England', CO: 'East of England', IP: 'East of England',
  LU: 'East of England', NR: 'East of England', PE: 'East of England', SG: 'East of England', SS: 'East of England',
  EN: 'East of England', RM: 'East of England', IG: 'East of England',
  B: 'West Midlands', CV: 'West Midlands', DY: 'West Midlands', HR: 'West Midlands', ST: 'West Midlands',
  TF: 'West Midlands', WR: 'West Midlands', WS: 'West Midlands', WV: 'West Midlands',
  DE: 'East Midlands', LE: 'East Midlands', LN: 'East Midlands', NG: 'East Midlands', NN: 'East Midlands',
  BD: 'Yorkshire and the Humber', DN: 'Yorkshire and the Humber', HD: 'Yorkshire and the Humber',
  HG: 'Yorkshire and the Humber', HU: 'Yorkshire and the Humber', HX: 'Yorkshire and the Humber',
  LS: 'Yorkshire and the Humber', S: 'Yorkshire and the Humber', WF: 'Yorkshire and the Humber', YO: 'Yorkshire and the Humber',
  BB: 'North West', BL: 'North West', CA: 'North West', CH: 'North West', CW: 'North West', FY: 'North West',
  L: 'North West', LA: 'North West', M: 'North West', OL: 'North West', PR: 'North West', SK: 'North West',
  WA: 'North West', WN: 'North West',
  DH: 'North East', DL: 'North East', NE: 'North East', SR: 'North East', TS: 'North East',
  AB: 'Scotland', DD: 'Scotland', DG: 'Scotland', EH: 'Scotland', FK: 'Scotland', G: 'Scotland', IV: 'Scotland',
  KA: 'Scotland', KW: 'Scotland', KY: 'Scotland', ML: 'Scotland', PA: 'Scotland', PH: 'Scotland', TD: 'Scotland', ZE: 'Scotland',
  CF: 'Wales', LD: 'Wales', LL: 'Wales', NP: 'Wales', SA: 'Wales', SY: 'Wales',
  BT: 'Northern Ireland',
};

const POSTCODE_REGEX = /\b([A-Z]{1,2})\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/i;

function deriveRegion(address: string | null | undefined): string {
  if (!address) return 'Other region';
  const match = address.match(POSTCODE_REGEX);
  if (!match) return 'Other region';
  return POSTCODE_AREA_REGION[match[1].toUpperCase()] ?? 'Other region';
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

  const { count: totalDistributed, error: countError } = await supabase
    .from('lead_assignments')
    .select('*', { count: 'exact', head: true })
    .gte('assigned_at', SINCE_DATE);

  if (countError) {
    return NextResponse.json({ error: countError.message }, { status: 500 });
  }

  const { data: latest, error: latestError } = await supabase
    .from('lead_assignments')
    .select('assigned_at, leads(address, bedrooms)')
    .gte('assigned_at', SINCE_DATE)
    .order('assigned_at', { ascending: false })
    .limit(5);

  if (latestError) {
    return NextResponse.json({ error: latestError.message }, { status: 500 });
  }

  const ledger = (latest ?? []).map((row: any) => ({
    region: deriveRegion(row.leads?.address),
    bedrooms: row.leads?.bedrooms ?? null,
    assigned_at: row.assigned_at,
  }));

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
