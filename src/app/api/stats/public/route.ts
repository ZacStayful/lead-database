import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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

  if (!data || !data.generated_at) {
    // No cron run yet — tell the frontend to hide the section entirely
    // rather than render zeroed or broken stats.
    return NextResponse.json({ generatedAt: null });
  }

  return NextResponse.json({
    totalDistributed: data.total_distributed,
    sinceDate: data.since_date,
    ledger: data.ledger,
    generatedAt: data.generated_at,
  });
}
