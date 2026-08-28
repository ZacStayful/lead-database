/**
 * The recovery ladder (§40.8).
 *
 * Small, but it decides how long a landlord's reply keeps trying to reach the
 * system after the vendor was slow for a moment — and the receiver and the
 * recovery pass both read it, so a second copy would eventually disagree.
 */
import { describe, it, expect } from "vitest";
import { retryDelayMs, retryExhausted, RETRY_WINDOW_MS } from "../webhookRetry";

describe("retryDelayMs", () => {
  it("front-loads: 1m, 5m, 15m, 1h", () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(5 * 60_000);
    expect(retryDelayMs(3)).toBe(15 * 60_000);
    expect(retryDelayMs(4)).toBe(60 * 60_000);
  });

  it("flattens rather than growing without bound", () => {
    // Past the ladder we are in an outage, where asking more often achieves
    // nothing and asking less often risks the 24h window closing first.
    expect(retryDelayMs(5)).toBe(60 * 60_000);
    expect(retryDelayMs(50)).toBe(60 * 60_000);
  });

  it("never returns 0 or a negative delay for a bad attempt count", () => {
    // A 0 delay would spin the pass against the vendor every five minutes.
    for (const n of [0, -1, NaN]) {
      expect(retryDelayMs(n as number)).toBeGreaterThanOrEqual(60_000);
    }
  });
});

describe("retryExhausted", () => {
  const now = Date.parse("2026-08-28T16:00:00Z");

  it("keeps trying inside the 24-hour window", () => {
    expect(retryExhausted(new Date(now - 60_000).toISOString(), now)).toBe(false);
    expect(retryExhausted(new Date(now - RETRY_WINDOW_MS + 60_000).toISOString(), now)).toBe(
      false
    );
  });

  it("gives up after it", () => {
    expect(retryExhausted(new Date(now - RETRY_WINDOW_MS - 1000).toISOString(), now)).toBe(true);
  });

  it("treats an unreadable timestamp as exhausted rather than retrying for ever", () => {
    expect(retryExhausted("not a date", now)).toBe(true);
    expect(retryExhausted("", now)).toBe(true);
  });
});
