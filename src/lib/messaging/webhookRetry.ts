/**
 * When to try an unverified webhook event again (§40.8).
 *
 * Pure, and separate from both callers, so the receiver and the recovery pass
 * cannot drift into two different ladders — the discipline §26.7 records for
 * the presentation seed, applied before the duplication exists.
 */

/**
 * 1m → 5m → 15m → 1h, then 1h for ever until the window closes.
 *
 * Front-loaded because the overwhelming case is the vendor being slow for a
 * moment; the flat tail exists for an outage, where asking more often achieves
 * nothing.
 */
const LADDER_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/** How long an unverified event stays worth retrying, from `received_at`. */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Delay before the attempt numbered `attempts` (1-based).
 *
 * ⚠️ A non-finite count must not fall through the clamp. `Math.max(1, NaN)` is
 * NaN, which indexes the ladder to `undefined` — and an undefined delay written
 * into `next_attempt_at` would either throw or come back due immediately,
 * spinning this against the vendor every five minutes. The unit test is what
 * found it.
 */
export function retryDelayMs(attempts: number): number {
  const n = Number.isFinite(attempts) ? Math.floor(attempts) : 1;
  const i = Math.max(1, n) - 1;
  return LADDER_MS[Math.min(i, LADDER_MS.length - 1)];
}

/**
 * Past the window, stop asking.
 *
 * ⚠️ The row is KEPT and its `next_attempt_at` nulled, never deleted. It is the
 * evidence that the event arrived at all, and the payload on it is the only
 * record of what was sent — which is exactly what was missing the day this had
 * to be diagnosed from the vendor instead.
 */
export function retryExhausted(receivedAt: string, now = Date.now()): boolean {
  const t = new Date(receivedAt).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t > RETRY_WINDOW_MS;
}
