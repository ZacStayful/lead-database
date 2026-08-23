import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  buildPublicFilterVolume,
  PUBLIC_VOLUME_STALE_AFTER_MS,
} from "@/lib/publicFilterVolume";

/**
 * Lead volume for the pre-signup estimator, cached and public.
 *
 * Mirrors /api/stats/public: claim the rebuild atomically by moving
 * generated_at forward only when the row is already stale, so a burst of
 * traffic triggers exactly one rebuild rather than one per request. The claim
 * runs on the primary, so read-replica lag cannot let two through.
 *
 * The payload is already contention-adjusted for a newcomer (see
 * publicFilterVolume.ts) — the estimate is honest, and per-area customer counts
 * are not derivable from what is served.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The row IS the cache; a CDN copy on top would only make staleness harder to
// reason about, and the rebuild claim already bounds the work.
const NO_STORE = {
  "Cache-Control": "no-store, max-age=0, must-revalidate",
};

export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const staleBefore = new Date(
    Date.now() - PUBLIC_VOLUME_STALE_AFTER_MS
  ).toISOString();

  const { data: claimed, error: claimError } = await supabase
    .from("public_filter_volume")
    .update({ generated_at: new Date().toISOString() })
    .eq("id", 1)
    .or(`generated_at.is.null,generated_at.lt.${staleBefore}`)
    .select("id");

  if (!claimError && claimed && claimed.length > 0) {
    try {
      const payload = await buildPublicFilterVolume(supabase);
      await supabase
        .from("public_filter_volume")
        .update({ payload, generated_at: payload.generatedAt })
        .eq("id", 1);
      return NextResponse.json(payload, { headers: NO_STORE });
    } catch (err) {
      // The claim already moved generated_at forward, so a failed rebuild will
      // not be retried for a full window — deliberate. Serving the previous
      // payload is better than hammering a struggling database, and the numbers
      // move slowly enough that a stale window costs nobody a correct quote.
      console.error("[filter-estimate] rebuild failed; serving cached", err);
    }
  }

  const { data } = await supabase
    .from("public_filter_volume")
    .select("payload, generated_at")
    .eq("id", 1)
    .maybeSingle();

  if (!data?.payload || Object.keys(data.payload).length === 0) {
    return NextResponse.json(
      { error: "Lead volume is not available right now." },
      { status: 503, headers: NO_STORE }
    );
  }

  return NextResponse.json(data.payload, { headers: NO_STORE });
}
