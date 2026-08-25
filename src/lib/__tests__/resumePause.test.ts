import { describe, expect, it } from "vitest";
import { resumeRefusalReason, type ResumeEligibilityFields } from "../resumePause";

function customer(
  over: Partial<ResumeEligibilityFields> = {}
): ResumeEligibilityFields {
  return { paused_at: null, cancel_at_period_end: false, ...over };
}

describe("resumeRefusalReason", () => {
  it("admits a paused customer with nothing scheduled", () => {
    expect(
      resumeRefusalReason(customer({ paused_at: "2026-08-01T00:00:00Z" }))
    ).toBeNull();
  });

  it("refuses a customer who is not paused", () => {
    expect(resumeRefusalReason(customer())).toMatch(/isn't paused/i);
  });

  it("refuses a pending cancellation and names the way out", () => {
    // Not a silent resume: their subscription is on record as ending, so
    // restarting collection for a period they closed would be one route doing
    // two contradictory things. The message has to point at the undo, because
    // clearing the flag is what makes the next daily run resume them normally.
    const reason = resumeRefusalReason(
      customer({ paused_at: "2026-08-01T00:00:00Z", cancel_at_period_end: true })
    );
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/Keep my subscription/);
  });

  it("puts the not-paused check first", () => {
    // A customer who is neither paused nor cancelling must not be told about
    // cancellation, and one who is cancelling but not paused has nothing to
    // resume — "isn't paused" is the honest answer to both.
    expect(
      resumeRefusalReason(customer({ cancel_at_period_end: true }))
    ).toMatch(/isn't paused/i);
  });

  it("tolerates a null cancel flag", () => {
    // The column is NOT NULL since 0087, but the route selects it into a
    // nullable type and a missing value must not read as "cancelling".
    expect(
      resumeRefusalReason({
        paused_at: "2026-08-01T00:00:00Z",
        cancel_at_period_end: null,
      })
    ).toBeNull();
  });
});
