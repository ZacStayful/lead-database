import { describe, expect, it } from "vitest";
import { funnelConfirmationInitial, radiusChangedSincePayment } from "@/lib/funnel/confirmation";
import { offerSetPassword } from "@/lib/funnel/passwordPrompt";

/**
 * What a funnel payer's first sign-in opens on (02 Phase 5, C1), and the
 * "set a password" card that follows it (C2).
 */

const ANSWERS = {
  basePostcode: "YO10 5DD",
  priorityOutcodes: ["YO1"],
  travelLimitMiles: 25,
  minBedrooms: 2,
  minGross: null,
  similarAreas: ["YO24"],
};

function plan(p: 10 | 20, miles: number) {
  return { plan: p, serviceRadiusMiles: miles, basePostcode: "YO10 5DD", coverage: [] };
}
const SNAPSHOT = { plans: [plan(10, 12), plan(20, 18)], similarAreas: ["YO31"] };

describe("funnelConfirmationInitial", () => {
  it("prefills every answer, and the radius shown for THEIR plan", () => {
    expect(funnelConfirmationInitial(ANSWERS, SNAPSHOT, 10)).toEqual({
      basePostcode: "YO10 5DD",
      priorityOutcodes: ["YO1"],
      travelLimitMiles: 25,
      minBedrooms: 2,
      minGross: null,
      similarAreas: ["YO24"],
      shownRadiusMiles: 12,
    });
    expect(funnelConfirmationInitial(ANSWERS, SNAPSHOT, 20)?.shownRadiusMiles).toBe(18);
  });

  it("'Anywhere' (null) is an answer, kept as null, not a reason to ask again", () => {
    const initial = funnelConfirmationInitial({ ...ANSWERS, travelLimitMiles: null }, SNAPSHOT, 10);
    expect(initial).not.toBeNull();
    expect(initial?.travelLimitMiles).toBeNull();
  });

  it("answers that cannot be previewed open the questions instead", () => {
    const { travelLimitMiles: _travel, ...noTravel } = ANSWERS;
    expect(funnelConfirmationInitial(noTravel, SNAPSHOT, 10)).toBeNull();
    expect(funnelConfirmationInitial({ ...ANSWERS, basePostcode: "" }, SNAPSHOT, 10)).toBeNull();
    expect(funnelConfirmationInitial(null, SNAPSHOT, 10)).toBeNull();
  });

  it("an unreadable snapshot still prefills, with no radius to compare against", () => {
    const initial = funnelConfirmationInitial(ANSWERS, { plans: "nope" }, 10);
    expect(initial?.shownRadiusMiles).toBeNull();
    expect(radiusChangedSincePayment(initial, 40)).toBe(false);
  });

  it("takes the ticked similar areas from the snapshot when the answers lack them", () => {
    const { similarAreas: _s, ...rest } = ANSWERS;
    expect(funnelConfirmationInitial(rest, SNAPSHOT, 10)?.similarAreas).toEqual(["YO31"]);
  });
});

describe("radiusChangedSincePayment (locked decision 6)", () => {
  it("is told only when the recalculated radius differs from the one paid against", () => {
    const initial = funnelConfirmationInitial(ANSWERS, SNAPSHOT, 10);
    expect(radiusChangedSincePayment(initial, 12)).toBe(false);
    expect(radiusChangedSincePayment(initial, 15)).toBe(true);
    expect(radiusChangedSincePayment(null, 15)).toBe(false);
  });
});

describe("offerSetPassword (C2)", () => {
  const funnel = { signup_source: "funnel", password_set_at: null, lead_brief_completed_at: "2026-10-09T12:00:00Z" };

  it("offers a password to a funnel customer once their brief is confirmed", () => {
    expect(offerSetPassword(funnel)).toBe(true);
  });

  it("never before the brief, never once a password is set, never to a call customer", () => {
    expect(offerSetPassword({ ...funnel, lead_brief_completed_at: null })).toBe(false);
    expect(offerSetPassword({ ...funnel, password_set_at: "2026-10-09T13:00:00Z" })).toBe(false);
    // password_set_at is null on every pre-0165 customer, who all have a password.
    expect(offerSetPassword({ ...funnel, signup_source: "call" })).toBe(false);
    expect(offerSetPassword(null)).toBe(false);
  });
});
