import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generatePublicStats } from '@/lib/publicStats';

export const dynamic = 'force-dynamic';

// Scheduled (daily) refresh of the public activity snapshot. This is now a
// belt-and-braces path: /api/stats/public also self-heals a stale snapshot on
// demand, so the section stays current even if this cron never fires (e.g. a
// missing CRON_SECRET or a plan limit).
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    const stats = await generatePublicStats(supabase);
    return NextResponse.json({
      ok: true,
      totalDistributed: stats.total_distributed,
      ledgerCount: stats.ledger.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'Failed to generate public stats' },
      { status: 500 }
    );
  }
}
