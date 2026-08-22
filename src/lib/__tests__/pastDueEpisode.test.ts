import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  applyPastDueEpisode,
  mapStripeSubscriptionStatus,
} from "@/lib/pastDueEpisode";

const map = (s: string) =>
  mapStripeSubscriptionStatus(s as Stripe.Subscription.Status);

describe("mapStripeSubscriptionStatus", () => {
  it("treats unpaid as a cancellation, not a decline", () => {
    // The whole point of 0097. `unpaid` is the TERMINAL dunning state — every
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
