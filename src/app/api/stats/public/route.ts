import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  generatePublicStats,
  STALE_AFTER_MS,
  CLEAN_BEDROOM_LABEL,
} from '@/lib/publicStats';

// Always read the live cache row. Without this, Next.js 14 statically caches
// this GET handler's response at build time, so refreshes would never surface
// until the next deploy.
export const dynamic = 'force-dynamic';

// Never let Vercel's CDN (or the browser) serve a cached copy of this response.
// It self-heals on request, so a cached response would hide fresh regenerations
// for hours — every request must reach the origin.
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0, must-revalidate' };

// Warm-instance memo. Production's Supabase read endpoint lags its own writes,
// so the DB-based staleness gate below can't tell that a just-written snapshot
// is fresh and would rebuild on every request. This short in-process memo
// bounds regeneration to ~once per TTL per warm instance regardless of that
// lag; a new deployment (or cold start) starts with an empty memo, so changes
// still surface promptly.
const MEMO_TTL_MS = 5 * 60 * 1000;
let memo: { at: number; payload: ReturnType<typeof serialize> } | null = null;

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
  // Serve a very recent result straight from memory, without touching the DB.
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) {
    return NextResponse.json(memo.payload, { headers: NO_STORE });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data, error } = await supabase
    .from('public_activity_stats')
    .select('total_distributed, since_date, ledger, generated_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }

  const generatedAtMs = data?.generated_at ? new Date(data.generated_at).getTime() : 0;
  const isStale =
    !data || !data.generated_at || Date.now() - generatedAtMs > STALE_AFTER_MS;

  // Also rebuild if the cached ledger predates the current bedroom-label
  // normalisation (any row not in the clean "N Bed" / "N+ Bed" form), so a
  // format change surfaces on the next request instead of after STALE_AFTER_MS.
  const ledger = Array.isArray(data?.ledger) ? (data!.ledger as any[]) : [];
  const isLegacyFormat = ledger.some(
    (e) => !CLEAN_BEDROOM_LABEL.test(String(e?.bedrooms ?? ''))
  );

  // Self-heal: if the snapshot is missing, older than STALE_AFTER_MS, or in an
  // old format, regenerate it here rather than depending on the scheduled cron
  // (which needs a CRON_SECRET and Vercel's scheduler to fire). Best-effort —
  // if regeneration fails, fall back to whatever is cached so the section never
  // hard-fails on a transient DB hiccup.
  if (isStale || isLegacyFormat) {
    try {
      const fresh = await generatePublicStats(supabase);
      const payload = serialize(fresh);
      memo = { at: Date.now(), payload };
      return NextResponse.json(payload, { headers: NO_STORE });
    } catch {
      // fall through to the cached data (or the null-state below)
    }
  }

  if (!data || !data.generated_at) {
    // Nothing cached and regeneration didn't succeed — tell the frontend to
    // hide the section rather than render zeroed or broken stats. Not memoised.
    return NextResponse.json({ generatedAt: null }, { headers: NO_STORE });
  }

  const payload = serialize(data);
  memo = { at: Date.now(), payload };
  return NextResponse.json(payload, { headers: NO_STORE });
}
