import { describe, it, expect } from "vitest";
import {
  assessLeadQuality,
  describeLeadQuality,
  isJunkName,
  normaliseUkMobile,
  passesQualityGate,
  ukMobileE164,
  UK_MOBILE_ERRORS,
  type LeadQualityCode,
} from "@/lib/leadQuality";
import { phoneMatchKey } from "@/lib/monday";

const ok = (raw: string) => {
  const r = normaliseUkMobile(raw);
  return r.ok ? r.value : `FAILED:${r.reason}`;
};
const why = (raw: string | null | undefined) => {
  const r = normaliseUkMobile(raw);
  return r.ok ? "ok" : r.reason;
};

describe("normaliseUkMobile — the +44-then-national shape", () => {
  // 89 of 193 live management leads are stored exactly like this. A normaliser
  // that strips "+44" and prefixes "0" yields 007304208011 and rejects them all.
  it.each([
    ["+4407304208011", "07304208011"],
    ["+4407581051622", "07581051622"],
    ["+4407960507778", "07960507778"],
    ["+4407304208011 ", "07304208011"],
    ["+44 (0) 7304 208011", "07304208011"],
  ])("%s → %s", (input, expected) => {
    expect(ok(input)).toBe(expected);
  });
});

describe("normaliseUkMobile — the shapes that must keep working", () => {
  it.each([
    ["+447711387707", "07711387707"],
    ["+447899902092", "07899902092"],
    ["0771 8372520", "07718372520"],
    ["0746 0542745", "07460542745"],
    ["07748315724", "07748315724"],
    ["07748 315724", "07748315724"],
    ["(07748) 315724", "07748315724"],
    ["447711387707", "07711387707"],
    ["00447711387707", "07711387707"],
  ])("%s → %s", (input, expected) => {
    expect(ok(input)).toBe(expected);
  });
});

describe("normaliseUkMobile — rejections, by reason", () => {
  it.each([
    ["0031 687898512", "foreign"],
    ["0096 6538179359", "foreign"],
    ["+971502899537", "foreign"],
    ["+351924303127", "foreign"],
    ["+310628883080", "foreign"],
    ["006421980878", "foreign"],
    ["0041 789430400", "foreign"],
    ["0061 424332086", "foreign"],
    ["0000 0000000", "placeholder"],
    ["00", "placeholder"],
    ["0", "placeholder"],
    ["+447987265439024", "not_mobile"],
    ["0204 5499140", "not_mobile"],
    ["+4401302810200", "not_mobile"],
    ["0793 66089999", "not_mobile"],
    ["0785 123225", "not_mobile"],
    ["7796 72789", "not_mobile"],
    ["0689 768525", "not_mobile"],
    ["6592 395071", "not_mobile"],
    ["", "missing"],
    ["   ", "missing"],
    ["not a number", "missing"],
  ])("%s → %s", (input, reason) => {
    expect(why(input)).toBe(reason);
  });

  it("treats null and undefined as missing", () => {
    expect(why(null)).toBe("missing");
    expect(why(undefined)).toBe("missing");
  });

  it("never mangles a national number into a false positive", () => {
    // 0447… is not a valid UK prefix; it must not be read as a country code.
    expect(why("0447 711910109")).toBe("not_mobile");
  });
});

describe("isJunkName", () => {
  it.each([
    "natalyanaq@gmail.com", // an email pasted into the name field
    "Dbncc",                // no vowel, 5 chars
    "asdf",
    "test",
    "N/A",
    "unknown",
    "xxx",
    "Aaaa",
    "John3",
    "...",
    "A",
  ])("rejects %s", (name) => {
    expect(isJunkName(name)).toBe(true);
  });

  // 87 of 437 live leads carry a single-token name and every one is real.
  it.each([
    "Adam", "Ann", "Josh", "Emily", "Bal", "Seerat", "Chinonye",
    "ANN-MARIE", "O'Brien", "shaya", "sophia", "Ng", "Jean-Luc",
    "Mary Jane Watson", "Renée Dubois", "李伟",
  ])("accepts %s", (name) => {
    expect(isJunkName(name)).toBe(false);
  });

  it("treats an absent name as absent, not junk", () => {
    expect(isJunkName("")).toBe(false);
    expect(isJunkName(null)).toBe(false);
  });
});

describe("assessLeadQuality", () => {
  it("passes a good lead and normalises both fields", () => {
    const v = assessLeadQuality({
      lead_name: "Seerat",
      phone: "+4407304208011",
      email: "Sirat_z@hotmail.com",
    });
    expect(v.ok).toBe(true);
    expect(v.codes).toEqual([]);
    expect(v.normalisedPhone).toBe("07304208011");
    expect(v.normalisedEmail).toBe("sirat_z@hotmail.com");
  });

  it("reports EVERY failing reason, not just the first", () => {
    const v = assessLeadQuality({ lead_name: "asdf", phone: "", email: "nope" });
    expect(v.ok).toBe(false);
    expect(v.codes).toEqual(["name_junk", "phone_missing", "email_malformed"]);
  });

  it("separates a missing name from a junk one", () => {
    expect(assessLeadQuality({ lead_name: "", phone: "07748315724", email: "a@b.co" }).codes)
      .toEqual(["name_missing"]);
  });

  it("separates an overseas number from an unusable one", () => {
    expect(assessLeadQuality({ lead_name: "Mark", phone: "+971508664850", email: "a@b.co" }).codes)
      .toEqual(["phone_foreign"]);
    expect(assessLeadQuality({ lead_name: "Mark", phone: "0204 5499140", email: "a@b.co" }).codes)
      .toEqual(["phone_not_uk_mobile"]);
  });

  it("does not normalise a rejected value", () => {
    const v = assessLeadQuality({ lead_name: "X", phone: "+971508664850", email: "bad" });
    expect(v.normalisedPhone).toBeNull();
    expect(v.normalisedEmail).toBeNull();
  });
});

describe("describeLeadQuality", () => {
  const ALL: LeadQualityCode[] = [
    "name_missing", "name_junk", "phone_missing", "phone_placeholder",
    "phone_foreign", "phone_not_uk_mobile", "email_missing", "email_malformed",
  ];

  it("has text for every code", () => {
    for (const code of ALL) {
      const text = describeLeadQuality([code]);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("undefined");
    }
  });

  it("joins several reasons", () => {
    expect(describeLeadQuality(["name_junk", "phone_missing"])).toContain("·");
  });

  it("says so when there is nothing wrong", () => {
    expect(describeLeadQuality([])).toMatch(/usable/i);
  });
});

describe("passesQualityGate", () => {
  it("passes pending — an unchecked lead is sold, not silently withheld", () => {
    expect(passesQualityGate({ lead_quality_status: "pending" })).toBe(true);
    expect(passesQualityGate({})).toBe(true);
    expect(passesQualityGate({ lead_quality_status: null })).toBe(true);
  });

  it("passes a lead that was checked and cleared", () => {
    expect(passesQualityGate({ lead_quality_status: "passed" })).toBe(true);
  });

  it("blocks a failed lead", () => {
    expect(passesQualityGate({ lead_quality_status: "failed" })).toBe(false);
  });

  it("lets an override through, and re-blocks when it is cleared", () => {
    expect(
      passesQualityGate({
        lead_quality_status: "failed",
        lead_quality_override_at: "2026-08-27T00:00:00Z",
      })
    ).toBe(true);
    expect(
      passesQualityGate({ lead_quality_status: "failed", lead_quality_override_at: null })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ukMobileE164 — the enquiry form's storage format (§49)
// ---------------------------------------------------------------------------

const e164 = (raw: string | null | undefined) => {
  const r = ukMobileE164(raw);
  return r.ok ? r.value : `FAILED:${r.reason}`;
};

describe("ukMobileE164", () => {
  it.each([
    // The shape §36.2 exists for: +44 followed by a FULL national number, which
    // 89 of 193 live management leads use. A naive slice yields +44007304208011.
    ["+4407304208011", "+447304208011"],
    ["07700900123", "+447700900123"],
    ["07700 900 123", "+447700900123"],
    ["+44 7700 900123", "+447700900123"],
    ["447700900123", "+447700900123"],
    ["00447700900123", "+447700900123"],
    ["(07700) 900123", "+447700900123"],
  ])("%s -> %s", (raw, expected) => {
    expect(e164(raw)).toBe(expected);
  });

  it("passes an already-E.164 UK mobile straight through", () => {
    expect(e164("+447711387707")).toBe("+447711387707");
  });

  it.each([
    ["+31 6 12345678", "foreign"],
    // A `+0…` typo reads as an explicit country code that is not ours. The
    // wording of UK_MOBILE_ERRORS.foreign has to cover this case too.
    ["+07700900123", "foreign"],
    ["0117 963 0000", "not_mobile"],
    ["07700", "not_mobile"],
    ["0000 0000000", "placeholder"],
    ["", "missing"],
    [null, "missing"],
    [undefined, "missing"],
  ])("refuses %s as %s", (raw, reason) => {
    expect(e164(raw)).toBe(`FAILED:${reason}`);
  });

  it("never disagrees with normaliseUkMobile about validity", () => {
    for (const raw of [
      "07700900123", "+4407304208011", "0117 963 0000", "+31 612345678",
      "0000", "", "447700900123", "not a number",
    ]) {
      expect(ukMobileE164(raw).ok).toBe(normaliseUkMobile(raw).ok);
    }
  });

  it("has a message for every failure reason", () => {
    // A new reason on UkMobileFailure must not reach a member of the public as
    // `undefined`. The Record type enforces this at compile time; this asserts
    // the strings are actually present and non-empty at runtime.
    for (const reason of ["missing", "placeholder", "foreign", "not_mobile"] as const) {
      expect(UK_MOBILE_ERRORS[reason].length).toBeGreaterThan(0);
    }
  });
});

describe("changing the stored format breaks nothing downstream", () => {
  // These two are the whole basis for storing +44 rather than 07. Neither
  // function is changed by this work; both are asserted because if either ever
  // stopped tolerating a leading +, the damage would be silent — a customer who
  // simply never receives an SMS, or a Monday item that quietly stops matching.

  it("the Monday matcher still resolves a +44 row against an 07 board cell", () => {
    // Tier 2 of matchItemForCustomer (§23.5) compares phoneMatchKey values.
    expect(phoneMatchKey("+447700900123")).toBe(phoneMatchKey("07700900123"));
    expect(phoneMatchKey("+447700900123")).toBe("700900123");
  });

  it("Twilio's own helper leaves an E.164 number untouched", () => {
    // sms.ts keeps toE164UK module-private, so this reproduces it exactly
    // rather than importing it. If that function changes, this must change too.
    const toE164UK = (raw: string) => {
      const cleaned = raw.replace(/[\s\-()]/g, "");
      return cleaned.startsWith("+") ? cleaned : cleaned.replace(/^0/, "+44");
    };
    expect(toE164UK("+447700900123")).toBe("+447700900123");
    expect(toE164UK("07700900123")).toBe("+447700900123");
    // looksLikePhone gates on 10-15 digits; a stored +44 number has 12.
    expect("+447700900123".replace(/\D/g, "").length).toBe(12);
  });
});
