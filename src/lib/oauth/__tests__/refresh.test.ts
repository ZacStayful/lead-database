/**
 * The refresh-race grace window.
 *
 * ⚠️ THIS IS THE MOST CONSEQUENTIAL DECISION IN THE OAUTH FLOW, and the reason
 * it is not simply "a rotated token is a replay, revoke everything".
 *
 * An MCP client issues tool calls in PARALLEL. Two in-flight requests routinely
 * find the access token expired at the same instant and both refresh. One wins
 * and rotates; the other presents a token rotated microseconds ago. On the
 * textbook rule that is a stolen credential and the grant is revoked — so a
 * perfectly healthy connector dies at random, under exactly the load it exists
 * to serve, and reconnecting fixes it just often enough to read as a flaky
 * network rather than a bug.
 *
 * Both sides of the boundary are pinned here so nobody "tightens" it back.
 */
import { describe, expect, it } from "vitest";
import { classifyRotatedToken } from "@/lib/oauth/grants";
import { REFRESH_REUSE_GRACE_MS } from "@/lib/oauth/tokens";

const NOW = 1_800_000_000_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("classifyRotatedToken", () => {
  it("calls a rotation microseconds ago a RACE, not a replay", () => {
    expect(classifyRotatedToken(at(1), "successor-id", NOW)).toBe("race");
  });

  it("calls a rotation just inside the window a race", () => {
    expect(classifyRotatedToken(at(REFRESH_REUSE_GRACE_MS - 1), "successor-id", NOW)).toBe("race");
  });

  it("treats the boundary itself as a race — inclusive, so a clock tick cannot flip it", () => {
    expect(classifyRotatedToken(at(REFRESH_REUSE_GRACE_MS), "successor-id", NOW)).toBe("race");
  });

  it("calls a rotation just OUTSIDE the window a replay", () => {
    expect(classifyRotatedToken(at(REFRESH_REUSE_GRACE_MS + 1), "successor-id", NOW)).toBe("replay");
  });

  it("calls a token rotated an hour ago a replay — the case the rule exists for", () => {
    expect(classifyRotatedToken(at(60 * 60 * 1000), "successor-id", NOW)).toBe("replay");
  });

  it("is a replay when no successor was recorded, even inside the window", () => {
    // Nothing to hand back, so there is no safe race outcome available.
    expect(classifyRotatedToken(at(1), null, NOW)).toBe("replay");
  });

  it("is a replay when the rotation time was never stamped", () => {
    expect(classifyRotatedToken(null, "successor-id", NOW)).toBe("replay");
  });

  it("is a replay on an unparseable timestamp", () => {
    expect(classifyRotatedToken("not a date", "successor-id", NOW)).toBe("replay");
  });

  it("is a replay when the rotation claims to be in the FUTURE", () => {
    // Clock skew is not evidence of a race, and treating it as one would let a
    // forged timestamp buy an unlimited grace window.
    expect(classifyRotatedToken(new Date(NOW + 5000).toISOString(), "successor-id", NOW)).toBe("replay");
  });

  it("keeps the window far shorter than an access token's life", () => {
    // Long enough to cover any plausible race; far too short to be a useful
    // replay window for somebody who must also hold the client id.
    expect(REFRESH_REUSE_GRACE_MS).toBeLessThan(60 * 60 * 1000);
    expect(REFRESH_REUSE_GRACE_MS).toBeGreaterThanOrEqual(30 * 1000);
  });
});
