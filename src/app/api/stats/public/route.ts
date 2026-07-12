import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generatePublicStats, STALE_AFTER_MS } from '@/lib/publicStats';

// Always read the live cache row. Without this, Next.js 14 statically caches
// this GET handler's response at build time, so refreshes would never surface
// until the next deploy.
export const dynamic = 'force-dynamic';

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

  const { data, error } = await supabase
    .from('public_activity_stats')
    .select('total_distributed, since_date, ledger, generated_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const generatedAtMs = data?.generated_at ? new Date(data.generated_at).getTime() : 0;
  const isStale =
    !data || !data.generated_at || Date.now() - generatedAtMs > STALE_AFTER_MS;

  // Self-heal: if the snapshot is missing or older than STALE_AFTER_MS,
  // regenerate it here rather than depending on the scheduled cron (which needs
  // a CRON_SECRET and Vercel's scheduler to fire). Best-effort — if
  // regeneration fails, fall back to whatever is cached so the section never
  // hard-fails on a transient DB hiccup.
  if (isStale) {
    try {
      const fresh = await generatePublicStats(supabase);
      return NextResponse.json(serialize(fresh));
    } catch {
      // fall through to the cached data (or the null-state below)
    }
  }

  if (!data || !data.generated_at) {
    // Nothing cached and regeneration didn't succeed — tell the frontend to
    // hide the section rather than render zeroed or broken stats.
    return NextResponse.json({ generatedAt: null });
  }

  return NextResponse.json(serialize(data));
}
