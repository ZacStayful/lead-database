import { describe, it, expect } from "vitest";
import {
  buildLandlordDeck,
  seasonalWeights,
  type DeckLead,
} from "@/lib/landlordDeck";
import { validateAnswers, describeAnswers, WANT_CHIPS } from "@/lib/landlordQuestions";
import { buildReferralCopy } from "@/lib/landlordReferral";

const RISING = [1, 1, 2, 3, 5, 8, 10, 12, 6, 3, 2, 1];

function lead(over: Partial<DeckLead> = {}): DeckLead {
  return {
    lead_type: "management",
    address: "12 Test St, Darlington DL1 1AA",
    gross_annual_income: 36112,
    avg_nightly_rate: 157,
    occupancy_rate: 63,
    monthly_revenue_profile: RISING,
    market_occupancy_rate: 62,
    comp_set_size: 48,
    comp_set_radius_km: 1.5,
    comp_avg_rating: 4.8,
    comp_avg_review_count: 42,
    risk_label: "Low-Medium Risk",
    ...over,
  };
}

describe("buildLandlordDeck — the seven rules", () => {
  it("builds all four cards and a gross headline for a full management lead", () => {
    const d = buildLandlordDeck(lead());
    expect(d.cards.map((c) => c.kind)).toEqual([
      "mechanism", "market", "seasonality", "risk",
    ]);
    expect(d.headline).toEqual({ grossLow: 32501, grossHigh: 39723 });
  });

  // Rule: management only, as a GATE. 0 of 252 GR leads carry a figure.
  it("returns NOTHING for a guaranteed rent lead, however complete", () => {
    const d = buildLandlordDeck(lead({ lead_type: "guaranteed_rent" }));
    expect(d.cards).toEqual([]);
    expect(d.headline).toBeNull();
  });

  // Rules 2 and 3: no fee, no percentage of income, no net figure.
  it("never mentions a fee, a commission or a net figure", () => {
    const d = buildLandlordDeck(lead());
    const text = [
      ...d.cards.map((c) => `${c.title} ${c.body}`),
      String(d.headline?.grossLow),
      String(d.headline?.grossHigh),
    ].join(" ");
    expect(text).not.toMatch(/\bfee\b|commission|management fee|net\b/i);
    // 15% of gross would be ~5417; it must appear nowhere.
    expect(text).not.toContain("5417");
  });

  // Rule 4: risk_score is 0-for-LOW. Only the label is safe to show.
  it("uses the risk LABEL and never the inverted score", () => {
    const d = buildLandlordDeck(lead());
    const risk = d.cards.find((c) => c.kind === "risk");
    expect(risk).toBeTruthy();
    expect(risk && "label" in risk && risk.label).toBe("Low-Medium Risk");
    expect(JSON.stringify(d)).not.toContain("risk_score");
  });

  // Rule 5: a stored 0 means "no comparables found", not 0% occupancy.
  it("drops a zero market occupancy rather than printing 0%", () => {
    const d = buildLandlordDeck(lead({ market_occupancy_rate: 0 }));
    const market = d.cards.find((c) => c.kind === "market");
    expect(market && "marketOccupancyPct" in market && market.marketOccupancyPct).toBeNull();
    expect(market && market.body).not.toContain("0% occupancy");
  });

  // Rule 1: absent is omitted, never defaulted to TOOL_INCOME_DEFAULTS.
  it("invents nothing for a lead with no analysis at all", () => {
    const d = buildLandlordDeck({ lead_type: "management" });
    expect(d.headline).toBeNull();
    expect(d.cards).toEqual([]);
    expect(JSON.stringify(d)).not.toContain("60000");
    expect(JSON.stringify(d)).not.toContain("185");
  });

  it("renders each card independently — a lead with only a rating still gets one", () => {
    const d = buildLandlordDeck({
      lead_type: "management",
      comp_avg_rating: 4.6,
      comp_avg_review_count: 30,
    });
    expect(d.cards.map((c) => c.kind)).toEqual(["market"]);
  });

  it("uses the comp-set wording when the identity does not reconcile", () => {
    // £145 x 365 x 44% = ~£23,300 against a stated £9,573 — the Burslem case.
    const d = buildLandlordDeck(
      lead({ gross_annual_income: 9573, avg_nightly_rate: 145, occupancy_rate: 44 })
    );
    const mech = d.cards.find((c) => c.kind === "mechanism");
    expect(mech?.body).toContain("Comparable properties");
    expect(mech?.body).not.toContain("Based on");
  });

  it("uses the 'Based on' wording when it does reconcile", () => {
    const mech = buildLandlordDeck(lead()).cards.find((c) => c.kind === "mechanism");
    expect(mech?.body).toContain("Based on £157 a night at 63% occupancy");
  });
});

describe("seasonalWeights", () => {
  it("normalises to multipliers of the average month", () => {
    const w = seasonalWeights(RISING)!;
    expect(w).toHaveLength(12);
    expect(w.reduce((a, b) => a + b, 0) / 12).toBeCloseTo(1, 6);
  });
  it("refuses a wrong-length, all-zero or non-numeric profile", () => {
    expect(seasonalWeights([1, 2, 3])).toBeNull();
    expect(seasonalWeights(new Array(12).fill(0))).toBeNull();
    expect(seasonalWeights(null)).toBeNull();
    expect(seasonalWeights(["a", ...new Array(11).fill(1)])).toBeNull();
  });
  it("names the real peak and trough months", () => {
    const s = buildLandlordDeck(lead()).cards.find((c) => c.kind === "seasonality");
    expect(s && "peak" in s && s.peak).toBe("August");
    expect(s && "trough" in s && s.trough).toBe("January");
  });
});

describe("validateAnswers — a public endpoint's closed lists", () => {
  it("accepts a valid submission", () => {
    const v = validateAnswers({
      contact_method: "whatsapp",
      contact_time: "Weekday mornings",
      wants: [WANT_CHIPS[0]],
    });
    expect(v.ok).toBe(true);
  });

  it("rejects an unknown contact method rather than storing it", () => {
    const v = validateAnswers({ contact_method: "carrier_pigeon", contact_time: "x" });
    expect(v.ok && v.answers.contactMethod).toBeNull();
  });

  it("DROPS unknown chips but keeps the valid ones", () => {
    const v = validateAnswers({ wants: [WANT_CHIPS[1], "<script>", "anything"] });
    expect(v.ok && v.answers.wants).toEqual([WANT_CHIPS[1]]);
  });

  it("caps the note and the time rather than letting the CHECK reject the write", () => {
    const v = validateAnswers({ note: "x".repeat(5000), contact_time: "y".repeat(500) });
    expect(v.ok && v.answers.note!.length).toBe(1000);
    expect(v.ok && v.answers.contactTime!.length).toBe(120);
  });

  it("treats an entirely empty submission as a no-op, not an error", () => {
    expect(validateAnswers({})).toEqual({ ok: false, reason: "empty" });
    expect(validateAnswers({ wants: [] })).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses a non-object body", () => {
    expect(validateAnswers(null)).toEqual({ ok: false, reason: "malformed" });
    expect(validateAnswers("hello")).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("describeAnswers", () => {
  // Phrased as a request, not an instruction: three operators can hold one lead
  // and all read this, and "call Tuesday morning" from all three is the pile-on
  // §40.12 exists to prevent.
  it("reads as what the landlord asked for", () => {
    const out = describeAnswers({
      landlord_contact_method: "whatsapp",
      landlord_contact_time: "Weekday mornings",
      landlord_wants: ["How much work is involved for me"],
    });
    expect(out[0]).toBe("Asked to be contacted by WhatsApp");
    expect(out.join(" ")).not.toMatch(/^Call |^Contact them/);
  });
  it("returns nothing when the landlord never answered", () => {
    expect(describeAnswers({})).toEqual([]);
  });
});

describe("the email hook figure", () => {
  const operator = { business_name: "Acme Lets", contact_name: "Bob" };

  it("carries the gross range on a first introduction", () => {
    const c = buildReferralCopy({
      lead: { id: "l1", lead_type: "management", gross_annual_income: 36112, email: "a@b.co" },
      operator, askQuestions: true,
    });
    expect(c.headline).toContain("£32,501");
    expect(c.headline).toContain("£39,723");
    expect(c.headline).toContain("estimate");
  });

  it("carries NO figure for operators two and three", () => {
    const c = buildReferralCopy({
      lead: { id: "l1", lead_type: "management", gross_annual_income: 36112, email: "a@b.co" },
      operator, askQuestions: false,
    });
    expect(c.headline).toBeNull();
  });

  it("carries no figure for a GR lead, and never a fee figure", () => {
    const c = buildReferralCopy({
      lead: { id: "l1", lead_type: "guaranteed_rent", gross_annual_income: 36112, email: "a@b.co" },
      operator, askQuestions: true,
    });
    expect(c.headline).toBeNull();
    expect(JSON.stringify(c)).not.toContain("5417");
  });
});
