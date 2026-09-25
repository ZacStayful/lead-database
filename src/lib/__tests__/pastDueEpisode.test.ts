import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  applyPastDueEpisode,
  clearWriteOffCancellation,
  mapStripeSubscriptionStatus,
} from "@/lib/pastDueEpisode";

const map = (s: string) =>
  mapStripeSubscriptionStatus(s as Stripe.Subscription.Status);

describe("mapStripeSubscriptionStatus", () => {
  it("treats unpaid as a cancellation, not a decline", () => {
    // The whole point of 0152. `unpaid` is the TERMINAL dunning state — every
    // retry exhausted — and while it mapped to 'past_due' it was
    // indistinguishable from the first failed charge, so a dead subscription
    // read as "Wants to pay card declined" for ever and kept its capacity slot.
    expect(map("unpaid")).toBe("canceled");
  });

  it("still maps past_due to past_due", () => {
    // A live decline that Stripe is still retrying is NOT a cancellation. If
    // this ever collapsed into 'canceled', one failed charge would cancel the
    // customer outright.
    expect(map("past_due")).toBe("past_due");
  });

  it.each([
    ["active", "active"],
    ["trialing", "active"],
    ["canceled", "canceled"],
    ["incomplete_expired", "canceled"],
    ["incomplete", "inactive"],
    ["paused", "inactive"],
  ])("maps %s to %s", (input, expected) => {
    expect(map(input)).toBe(expected);
  });
});

describe("applyPastDueEpisode", () => {
  const NOW = "2026-08-22T12:00:00.000Z";
  const run = (
    status: string,
    since: string | null | undefined,
    gr: boolean
  ) => {
    const update: Record<string, unknown> = {};
    applyPastDueEpisode(update, status, since, gr, NOW);
    return update;
  };

  it("stamps the first failure of an episode", () => {
    expect(run("past_due", null, false)).toEqual({ past_due_since: NOW });
  });

  it("does NOT re-stamp on a retry", () => {
    // Load-bearing. Stripe retries a declined card repeatedly over the
    // following weeks and every retry reaches this code with status still
    // past_due. Re-stamping would hold the three-day lapse clock permanently at
    // zero, so a customer with a genuinely dead card would never lapse — the
    // exact failure the clock exists to prevent.
    expect(run("past_due", "2026-08-20T15:16:00Z", false)).toEqual({});
  });

  it("treats an undefined stamp as unstamped", () => {
    // The webhook reads this off a row that may predate the columns.
    expect(run("past_due", undefined, false)).toEqual({ past_due_since: NOW });
  });

  it.each(["active", "canceled", "inactive"])(
    "clears both columns on %s",
    (status) => {
      // Clearing on every non-past_due status is what makes recovery free: a
      // customer who pays comes back with no episode and no write-off, so the
      // label rule returns them to Management Customer with no special
      // handling, and a fresh episode later starts a fresh clock.
      expect(run(status, "2026-08-20T15:16:00Z", false)).toEqual({
        past_due_since: null,
        lapsed_at: null,
      });
    }
  );

  it("touches only gr_ columns for Guaranteed Rent (invariant 6)", () => {
    expect(run("past_due", null, true)).toEqual({ gr_past_due_since: NOW });
    expect(run("active", "x", true)).toEqual({
      gr_past_due_since: null,
      gr_lapsed_at: null,
    });
  });
});


/**
 * Recovery from a write-off must undo the cancellation date the write-off
 * stamped, and MUST NOT touch a real cancellation's date.
 *
 * ⚠️ WHAT BREAKS IF THESE FAIL. `cancelled_at` is what /admin/retention (§70)
 * reads as the churn event. Clear too little and a customer who recovered is
 * recorded as churned for ever, inflating churn and deflating retention with no
 * error anywhere. Clear too much and every real cancellation's date is erased on
 * that customer's next payment — which §18E and §32.1 both depend on surviving.
 * Both directions are mutation-tested.
 */
describe("clearWriteOffCancellation", () => {
  const LAPSED = "2026-09-01T06:00:00.000Z";

  function run(
    lapsedAt: string | null | undefined,
    cancelledAt: string | null | undefined,
    gr = false
  ): Record<string, unknown> {
    const update: Record<string, unknown> = {};
    clearWriteOffCancellation(update, lapsedAt, cancelledAt, gr);
    return update;
  }

  it("clears the date when the write-off is the thing that stamped it", () => {
    expect(run(LAPSED, LAPSED)).toEqual({ cancelled_at: null });
  });

  it("⚠️ MUTATION: leaves a REAL cancellation that preceded the lapse alone", () => {
    // First cancellation wins (§18), and the cron only stamps when the column is
    // null — so an earlier date is somebody who genuinely left before the card
    // ever failed. Erasing it would destroy the churn record this page exists to
    // report.
    expect(run(LAPSED, "2026-08-01T09:00:00.000Z")).toEqual({});
  });

  it("⚠️ MUTATION: does nothing when there was no write-off at all", () => {
    // An ordinary cancellation followed by a re-subscribe (§18E) pays again, and
    // that payment must not wipe the date they left on.
    expect(run(null, "2026-08-01T09:00:00.000Z")).toEqual({});
    expect(run(undefined, "2026-08-01T09:00:00.000Z")).toEqual({});
  });

  it("does nothing when there is no cancellation date to clear", () => {
    expect(run(LAPSED, null)).toEqual({});
    expect(run(LAPSED, undefined)).toEqual({});
    expect(run(null, null)).toEqual({});
  });

  it("compares instants, not strings, so a rendering difference still matches", () => {
    // PostgREST renders timestamptz as +00:00 where we wrote Z. A string compare
    // would read the genuine match as a mismatch and silently reinstate the bug.
    expect(run("2026-09-01T06:00:00+00:00", "2026-09-01T06:00:00.000Z")).toEqual({
      cancelled_at: null,
    });
  });

  it("writes the gr_ column and only that one on the GR side", () => {
    // invariant 6: the GR branch must never touch a management column.
    expect(run(LAPSED, LAPSED, true)).toEqual({ gr_cancelled_at: null });
  });

  it("ignores an unparseable timestamp rather than guessing", () => {
    expect(run("not a date", "not a date")).toEqual({});
  });

  it("a sub-second difference is NOT a match", () => {
    // Defensive: if the cron is ever changed to two separate new Date() calls the
    // stamps would differ by milliseconds, and this test is what makes that
    // change fail loudly instead of quietly stopping the clear.
    expect(run("2026-09-01T06:00:00.000Z", "2026-09-01T06:00:00.001Z")).toEqual({});
  });
});
