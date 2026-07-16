import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generatePublicStats, STALE_AFTER_MS, SINCE_DATE } from '@/lib/publicStats';

// Always read the live cache row. Without this, Next.js 14 statically caches
// this GET handler's response at build time, so refreshes would never surface
// until the next deploy.
export const dynamic = 'force-dynamic';

// Never let Vercel's CDN (or the browser) serve a cached copy of this response.
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0, must-revalidate' };

function serialize(s: {
  total_distributed: number | null;
  since_date: string | null;
  ledger: unknown;
  generated_at: string | null;
}) {
  return {
    totalDistributed: s.total_distributed,
    sinceDate: s.since_date,
    ledger: s.ledger,
    generatedAt: s.generated_at,
  };
}

export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Atomically claim the right to rebuild: flip generated_at forward only when
  // the row is already older than the staleness window. Runs on the primary, so
  // exactly one request per window rebuilds regardless of read-replica lag.
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from('public_activity_stats')
    .update({ generated_at: new Date().toISOString() })
    .eq('id', 1)
    .lt('generated_at', staleBefore)
    .select('id');

  if (!claimError && claimed && claimed.length > 0) {
    try {
      const fresh = await generatePublicStats(supabase);
      return NextResponse.json(serialize(fresh), { headers: NO_STORE });
    } catch {
      // fall through and serve whatever is currently stored
    }
  }

  // Read the current snapshot. IMPORTANT: this project serves plain SELECTs from
  // a read replica that lags the primary badly (~hours), which would show a
  // stale snapshot. An UPDATE always executes on the primary, so we read via a
  // no-op write (set since_date to the constant it already holds) with
  // RETURNING — guaranteeing the row we return is the authoritative primary
  // copy, not a stale replica read.
  const { data, error } = await supabase
    .from('public_activity_stats')
    .update({ since_date: SINCE_DATE })
    .eq('id', 1)
    .select('total_distributed, since_date, ledger, generated_at')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }

  if (!data || !data.generated_at) {
    // Nothing cached — tell the frontend to hide the section rather than render
    // zeroed or broken stats.
    return NextResponse.json({ generatedAt: null }, { headers: NO_STORE });
  }

  return NextResponse.json(serialize(data), { headers: NO_STORE });
}
