/**
 * Predicted monthly volume against the plan allocation.
 *
 * Moved out of LeadFilteringPanel unchanged so the public estimator can show
 * the same bar rather than an approximation of it. Pure presentational — no
 * session, no data fetching.
 */
export function VolumeBar({
  rate,
  allocation,
  amber,
}: {
  rate: number;
  allocation: number;
  amber: boolean;
}) {
  if (allocation <= 0) return null;
  const pct = Math.min(100, Math.max(0, (rate / allocation) * 100));
  return (
    <div
      className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`~${rate} of ${allocation} plan leads per month`}
    >
      <div
        className={`h-full rounded-full ${amber ? "bg-amber-500" : "bg-brand"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
