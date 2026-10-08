import { MATCH_LABELS, type MatchLabel } from "@/lib/leadBrief/types";

/**
 * The expected split of a plan across the four labels — shown as EXPECTED,
 * never guaranteed (locked decision 2, A1). The count is what is guaranteed,
 * through rollover; the mix is a forecast.
 *
 * The share of each label in the leads this brief could receive (each counted
 * at its contention share) is applied to what the area can deliver at
 * confidence. Whatever the area cannot deliver is expected to come as Nearby
 * opportunities — behind-pace leads from beyond the service area (A11) — so a
 * thin area shows a mix leaning to Nearby rather than a smaller plan.
 *
 * Proportional, not best-first: routing sends the highest-scoring leads
 * first, so the real mix should if anything be better than this. Erring that
 * way keeps "expected" honest.
 *
 * Whole numbers that always add up to the plan (largest remainder).
 */
export function computeExpectedMix(args: {
  plan: number;
  /** What the area can deliver at confidence, in leads a month. */
  deliverable: number;
  labelWeights: Partial<Record<MatchLabel, number>>;
}): Record<MatchLabel, number> {
  const mix: Record<MatchLabel, number> = {
    top_match: 0,
    strong_match: 0,
    first_pick: 0,
    nearby_opportunity: 0,
  };
  const total = MATCH_LABELS.reduce((s, l) => s + (args.labelWeights[l] ?? 0), 0);
  const delivered = total > 0 ? Math.max(0, Math.min(args.deliverable, args.plan)) : 0;

  if (delivered > 0) {
    const raw = MATCH_LABELS.map((l) => ({ l, v: ((args.labelWeights[l] ?? 0) / total) * delivered }));
    let assigned = 0;
    for (const { l, v } of raw) {
      mix[l] = Math.floor(v);
      assigned += mix[l];
    }
    // Largest remainder; ties go to the earlier (better) label.
    const order = raw
      .map(({ l, v }, i) => ({ l, frac: v - Math.floor(v), i }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; assigned < delivered; k++, assigned++) mix[order[k % order.length].l] += 1;
  }

  mix.nearby_opportunity += args.plan - delivered;
  return mix;
}
