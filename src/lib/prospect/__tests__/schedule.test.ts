import { describe, it, expect } from "vitest";
import {
  FINAL_STEP,
  PROSPECT_STEPS,
  claimKey,
  dueAt,
  prospectWork,
} from "@/lib/prospect/schedule";

const T0 = new Date("2026-09-13T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("the ladder's shape", () => {
  it("is three steps, at 2 minutes, 24 hours and 48 hours", () => {
    expect(PROSPECT_STEPS.map((s) => s.afterMs)).toEqual([
      2 * MIN,
      24 * HOUR,
      48 * HOUR,
    ]);
    expect(FINAL_STEP).toBe(3);
  });

  it("sends BOTH channels on step 1 and one each afterwards", () => {
    // The brief: a WhatsApp and an email land together about two minutes in.
    expect(PROSPECT_STEPS[0].channels).toEqual(["whatsapp", "email"]);
    // One channel each afterwards — three emails in three days is what gets a
    // sending domain marked as spam.
    expect(PROSPECT_STEPS[1].channels).toEqual(["whatsapp"]);
    expect(PROSPECT_STEPS[2].channels).toEqual(["email"]);
  });
});

describe("prospectWork", () => {
  it("owes nothing in the first two minutes", () => {
    const w = prospectWork(T0, at(90_000), new Set());
    expect(w.kind).toBe("waiting");
    if (w.kind === "waiting") expect(w.nextDueAt).toEqual(at(2 * MIN));
  });

  it("owes both channels the moment step 1 falls due", () => {
    const w = prospectWork(T0, at(2 * MIN), new Set());
    expect(w).toEqual({ kind: "due", step: 1, channels: ["whatsapp", "email"] });
  });

  it("owes only the channel that has not been claimed", () => {
    const w = prospectWork(T0, at(3 * MIN), new Set([claimKey(1, "whatsapp")]));
    expect(w).toEqual({ kind: "due", step: 1, channels: ["email"] });
  });

  it("waits for step 2 once step 1 is fully claimed", () => {
    const sent = new Set([claimKey(1, "whatsapp"), claimKey(1, "email")]);
    const w = prospectWork(T0, at(HOUR), sent);
    expect(w.kind).toBe("waiting");
    if (w.kind === "waiting") expect(w.nextDueAt).toEqual(at(24 * HOUR));
  });

  it("owes step 2 a day later", () => {
    const sent = new Set([claimKey(1, "whatsapp"), claimKey(1, "email")]);
    expect(prospectWork(T0, at(24 * HOUR), sent)).toEqual({
      kind: "due",
      step: 2,
      channels: ["whatsapp"],
    });
  });

  it("is complete once all three steps are claimed", () => {
    const sent = new Set([
      claimKey(1, "whatsapp"),
      claimKey(1, "email"),
      claimKey(2, "whatsapp"),
      claimKey(3, "email"),
    ]);
    expect(prospectWork(T0, at(72 * HOUR), sent)).toEqual({ kind: "complete" });
  });

  /**
   * ⚠️ THE ONE THAT MATTERS MOST.
   *
   * A ladder whose step 1 never got claimed — the cron was down, or Calendly
   * was unreachable for a day — must retry STEP 1, not skip to step 2 because
   * the clock moved on. Otherwise the very first thing a prospect ever hears
   * from us is "didn't manage to get you in the diary yesterday".
   */
  it("retries the earliest unfinished step rather than skipping ahead", () => {
    const w = prospectWork(T0, at(50 * HOUR), new Set());
    expect(w).toEqual({ kind: "due", step: 1, channels: ["whatsapp", "email"] });
  });

  it("moves on to a later step only once the earlier one is claimed", () => {
    const sent = new Set([claimKey(1, "whatsapp"), claimKey(1, "email")]);
    expect(prospectWork(T0, at(50 * HOUR), sent)).toEqual({
      kind: "due",
      step: 2,
      channels: ["whatsapp"],
    });
  });

  it("treats a claimed-but-failed send as claimed — the provider was called", () => {
    // The ledger records the CLAIM, not the success. A failed step 1 whatsapp
    // must not be retried, or a provider hiccup becomes two messages.
    const w = prospectWork(T0, at(5 * MIN), new Set([claimKey(1, "whatsapp")]));
    expect(w).toEqual({ kind: "due", step: 1, channels: ["email"] });
  });
});

describe("dueAt", () => {
  it("is plain elapsed time — no working days, no quiet hours", () => {
    // Deliberate: both channels fire immediately whatever the hour (§55).
    // A 23:00 enquiry is due at 23:02, not at 09:00 the next morning.
    const night = new Date("2026-09-13T22:00:00.000Z");
    expect(dueAt(night, PROSPECT_STEPS[0])).toEqual(
      new Date("2026-09-13T22:02:00.000Z")
    );
  });
});
