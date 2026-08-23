import { describe, it, expect } from "vitest";
import {
  toProductVolume,
  areasInPayload,
  type PublicFilterVolume,
} from "@/lib/publicFilterVolume";
import {
  predictMonthlyVolume,
  contentionShare,
  INGEST_EPOCH_ISO,
  type AreaContention,
} from "@/lib/filterPrediction";
import { CONTENDED_FILTERED_CUSTOMERS } from "@/lib/types";

const payload: PublicFilterVolume = {
  management: {
    windowStart: INGEST_EPOCH_ISO,
    weeksElapsed: 7.5,
    totalLeads: 40,
    matchableLeads: 30,
    areaBedCounts: { LS: { "3": 20 }, BD: { "2": 10 } },
  },
  guaranteed_rent: {
    windowStart: INGEST_EPOCH_ISO,
    weeksElapsed: 7.5,
    totalLeads: 10,
    matchableLeads: 10,
    areaBedCounts: { M: { "3": 10 } },
  },
  generatedAt: "2026-08-23T00:00:00Z",
};

describe("toProductVolume", () => {
  it("selects the right product", () => {
    expect(toProductVolume(payload, "management").areaBedCounts).toHaveProperty("LS");
    expect(toProductVolume(payload, "guaranteed_rent").areaBedCounts).toHaveProperty("M");
  });

  // A cached payload ages. Trusting its stored weeksElapsed would divide this
  // month's leads by a six-hour-old window and drift the rate upward.
  it("recomputes the window from the epoch rather than trusting the cache", () => {
    const v = toProductVolume(payload, "management", new Date("2026-09-23T00:00:00Z"));
    expect(v.weeksElapsed).toBeGreaterThan(payload.management.weeksElapsed);
  });

  it("survives a payload missing fields", () => {
    const empty = { generatedAt: "" } as unknown as PublicFilterVolume;
    const v = toProductVolume(empty, "management");
    expect(v.areaBedCounts).toEqual({});
    expect(v.totalLeads).toBe(0);
  });
});

describe("areasInPayload", () => {
  it("unions both products and sorts", () => {
    expect(areasInPayload(payload)).toEqual(["BD", "LS", "M"]);
  });
});

// The published counts are already the share a newcomer could expect. That is
// what lets the estimate be honest WITHOUT the payload carrying how many
// customers hold each area — shipping raw counts plus a contention map would
// quote the same number and hand anyone with devtools our customer list.
describe("contention is pre-applied, not published", () => {
  function applyContention(
    counts: Record<string, Record<string, number>>,
    contention: AreaContention
  ) {
    const out: Record<string, Record<string, number>> = {};
    for (const [area, beds] of Object.entries(counts)) {
      const share = contentionShare(area, contention, true);
      const scaled: Record<string, number> = {};
      for (const [bed, n] of Object.entries(beds)) {
        const v = Math.floor(n * share);
        if (v > 0) scaled[bed] = v;
      }
      if (Object.keys(scaled).length > 0) out[area] = scaled;
    }
    return out;
  }

  it("leaves an uncontended area at full volume", () => {
    const c: AreaContention = {
      filteredCustomers: { LS: 1 },
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    expect(applyContention({ LS: { "3": 20 } }, c)).toEqual({ LS: { "3": 20 } });
  });

  it("scales a crowded area down", () => {
    const c: AreaContention = {
      filteredCustomers: { LS: 7 },
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    // 8 competitors including the newcomer -> 4/8 -> 10 of 20.
    expect(applyContention({ LS: { "3": 20 } }, c)).toEqual({ LS: { "3": 10 } });
  });

  it("produces the same quote as the logged-in path would", () => {
    const c: AreaContention = {
      filteredCustomers: { LS: 7 },
      maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
    };
    const raw = { LS: { "3": 20 } };
    const vol = { windowStart: INGEST_EPOCH_ISO, weeksElapsed: 7.5, totalLeads: 20, matchableLeads: 20, areaBedCounts: raw };
    const sel = { areas: ["LS"], minBedrooms: null, maxBedrooms: null };

    // Dashboard: raw counts + contention passed in at predict time.
    const loggedIn = predictMonthlyVolume(vol, sel, c);
    // Public: counts already scaled, no contention passed.
    const publicVol = { ...vol, areaBedCounts: applyContention(raw, c) };
    const anonymous = predictMonthlyVolume(publicVol, sel);

    expect(anonymous.matchingLeads).toBe(loggedIn.matchingLeads);
  });

  it("never scales a count up", () => {
    for (const existing of [0, 1, 3, 4, 9, 40]) {
      const c: AreaContention = {
        filteredCustomers: { LS: existing },
        maxPerLead: CONTENDED_FILTERED_CUSTOMERS,
      };
      const out = applyContention({ LS: { "3": 20 } }, c);
      expect(out.LS?.["3"] ?? 0).toBeLessThanOrEqual(20);
    }
  });
});
