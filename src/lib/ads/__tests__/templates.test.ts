import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AD_TEMPLATES,
  AD_TEMPLATE_IDS,
  AD_SLOT_KEYS,
  DEFAULT_TEMPLATE_ID,
  serviceTokensFor,
  slotsForTemplate,
  slotsInPattern,
  templateById,
  type AdTemplate,
} from "../templates";
import { META_CTA_TYPES, META_TRUNCATION_MARKS, AD_COPY_MAX } from "../metaFields";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/0156_ad_builder.sql"),
  "utf8"
);

/** A pattern slot is either declared on the template, or derived from one that is. */
const DERIVED: Record<string, string> = { included_list: "included", handled_list: "handled" };

function patternsOf(t: AdTemplate): string[] {
  return [t.exampleHeadlineLocated, t.exampleHeadlineUnlocated, t.exampleSubLocated, t.exampleSubUnlocated, t.ctaPattern];
}

function firstSentence(text: string): string {
  const m = text.match(/^[^.!?]+[.!?]/);
  return (m ? m[0] : text).toLowerCase();
}

describe("the registry covers the four templates the spec calls gate-free", () => {
  it("ships exactly the four, and templateById finds each", () => {
    expect(AD_TEMPLATES).toHaveLength(4);
    expect(AD_TEMPLATES.map((t) => t.id).sort()).toEqual([...AD_TEMPLATE_IDS].sort());
    for (const id of AD_TEMPLATE_IDS) expect(templateById(id)?.id).toBe(id);
    expect(templateById("your-worst-case")).toBeNull();
  });

  it("makes T7 the default, as the spec asks", () => {
    expect(DEFAULT_TEMPLATE_ID).toBe("what-would-it-earn");
    expect(templateById(DEFAULT_TEMPLATE_ID)).not.toBeNull();
  });

  /**
   * ⚠️ TWO INDEPENDENT PROPERTIES, AND THIS USED TO ASSERT THEM UNDER ONE
   * TITLE — "every claims gate is none — a photo template must not sneak in".
   * They are not the same rule and they gate different work: six of the spec's
   * eight core templates have a claims gate of `none`, so that is not what
   * selected these four, and a reader taking the old title at face value
   * concludes T4 and T5 need the claims gate when all they need is a
   * photograph.
   */
  it("makes no claim needing evidence, so no claims gate is owed", () => {
    for (const t of AD_TEMPLATES) expect(t.claimsGate).toBe("none");
  });

  it("needs no photo layer, which is what selected these four", () => {
    // ⚠️ "required" is not expressible: the union is "none" | "optional", so
    // tsc refuses a photo template before a test could. T7 stays declared
    // `optional` because the spec says so; what this pins is that the other
    // three are `none` and that no layout reads the field yet.
    expect(AD_TEMPLATES.map((t) => `${t.id}:${t.photo}`).sort()).toEqual([
      "never-see-the-messages:none",
      "rules-keep-changing:none",
      "what-would-it-earn:optional",
      "years-properties-review:none",
    ]);
  });
});

describe("addressing — the rule that stops the ad reading as a riddle", () => {
  it("every template names its audience and its category, as tokens not sentences", () => {
    for (const t of AD_TEMPLATES) {
      expect(t.addressedTo.trim().length).toBeGreaterThan(0);
      expect(t.audienceTokens.length).toBeGreaterThan(0);
      expect(t.categoryTokens.length).toBeGreaterThan(0);
      // Tokens must be lowercase needles, or the matcher silently never fires.
      for (const tok of [...t.audienceTokens, ...t.categoryTokens]) {
        expect(tok).toBe(tok.toLowerCase());
        expect(tok.trim()).toBe(tok);
      }
      // The declared sentence must actually contain its own audience token.
      expect(t.audienceTokens.some((tok) => t.addressedTo.toLowerCase().includes(tok))).toBe(true);
    }
  });

  it("⚠️ T8's headline names no audience — which is why addressedTo is on the card", () => {
    const t8 = templateById("years-properties-review")!;
    const head = t8.exampleHeadlineLocated.toLowerCase();
    expect(t8.audienceTokens.some((tok) => head.includes(tok))).toBe(false);
    expect(t8.addressedTo).toBe("Landlords comparing managers");
  });
});

describe("the copy patterns", () => {
  it("every template carries BOTH headline forms and BOTH sub forms", () => {
    for (const t of AD_TEMPLATES) {
      for (const p of patternsOf(t)) expect(p.trim().length).toBeGreaterThan(0);
      // The located form names a city; the unlocated one must not.
      expect(slotsInPattern(t.exampleHeadlineLocated)).toContain("city");
      expect(slotsInPattern(t.exampleHeadlineUnlocated)).not.toContain("city");
    }
  });

  it("⚠️ T8's sub differs between the forms — {areas} is unresolvable when they decline to narrow", () => {
    const t8 = templateById("years-properties-review")!;
    expect(slotsInPattern(t8.exampleSubLocated)).toContain("areas");
    expect(slotsInPattern(t8.exampleSubUnlocated)).not.toContain("areas");
    expect(t8.exampleSubLocated).not.toBe(t8.exampleSubUnlocated);
  });

  it("every {slot} in every pattern is declared, or derived from one that is", () => {
    for (const t of AD_TEMPLATES) {
      const declared = new Set<string>(slotsForTemplate(t));
      for (const pattern of patternsOf(t)) {
        for (const slot of slotsInPattern(pattern)) {
          expect(AD_SLOT_KEYS as readonly string[]).toContain(slot);
          const source = DERIVED[slot];
          if (source) expect(declared.has(source)).toBe(true);
          else expect(declared.has(slot)).toBe(true);
        }
      }
    }
  });

  it("⚠️ the subs with a multi-select are BUILT from it, never fixed", () => {
    // The spec's own subs hardcode five services for T3 and four for T6, while
    // both are multi-selects and T6's claims note says "Only items they tick
    // may appear". A fixed sub publishes what the customer does not provide.
    for (const t of AD_TEMPLATES) {
      if (!t.services) continue;
      const slot = `${t.services.slot}_list`;
      expect(slotsInPattern(t.exampleSubLocated)).toContain(slot);
    }
  });

  it("gives every template five primary-text angles", () => {
    for (const t of AD_TEMPLATES) expect(t.angles).toHaveLength(5);
  });

  it("uses only call-to-action types Meta actually accepts", () => {
    for (const t of AD_TEMPLATES) expect(META_CTA_TYPES).toContain(t.metaCta);
  });

  it("gives T6 the spec's fixed footer, and nobody else one", () => {
    expect(templateById("rules-keep-changing")!.footerLine)
      .toBe("Responsibility stays with the property owner; we manage the process.");
    expect(AD_TEMPLATES.filter((t) => t.footerLine)).toHaveLength(1);
  });
});

/**
 * ⚠️ THE "default primary text" SUITE IS GONE BECAUSE THE FIELDS ARE.
 *
 * It asserted that `defaultPrimaryText`, `defaultHeadline` and
 * `defaultDescription` would survive the validator with nothing ticked — a good
 * test of a bad idea. What a rejected generation collapsed to was an ad we
 * stored, stamped with a model id, and rendered under "the words were drafted
 * by AI": production shows both calls recording `not_configured` and copy
 * byte-identical to T7's three defaults. If the model did not write it, it is
 * not an ad, and the replacement assertion is in `generate.test.ts` — zero
 * surviving variants never reaches `ready`.
 */

describe("the angle registry", () => {
  it("pairs five keys with five angles, positionally", () => {
    for (const t of AD_TEMPLATES) {
      expect(t.angleKeys).toHaveLength(t.angles.length);
      expect(new Set(t.angleKeys).size).toBe(t.angleKeys.length);
    }
  });

  it("⚠️ keys are stable tokens, never prose — the model returns them", () => {
    for (const t of AD_TEMPLATES) {
      for (const key of t.angleKeys) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("⚠️ every key is unique ACROSS templates, so a stored key names one angle", () => {
    const all = AD_TEMPLATES.flatMap((t) => t.angleKeys.map((k) => `${t.id}:${k}`));
    expect(new Set(all).size).toBe(all.length);
  });

  it("⚠️ no angle name contains a service token as a whole word", () => {
    // This is the measurement `angleListFor` cites for NOT filtering the angle
    // list on the multi-select vocabulary: the filter would be dead code. If
    // this ever fails, an angle has been written that invites a word the
    // validator refuses, and the filter has to exist.
    for (const t of AD_TEMPLATES) {
      const { forbidden } = serviceTokensFor(t, []);
      for (const angle of t.angles) {
        for (const tok of forbidden) {
          const re = new RegExp(`(?:^|[^a-z0-9])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i");
          expect(re.test(angle), `${t.id} "${angle}" names "${tok}"`).toBe(false);
        }
      }
    }
  });
});

describe("required slots — what makes the ad impossible", () => {
  it("⚠️ is a SUBSET of setupSlots, never a new question", () => {
    for (const t of AD_TEMPLATES) {
      for (const slot of t.requiredSlots) {
        expect(t.setupSlots, `${t.id} requires ${slot}`).toContain(slot);
      }
    }
  });

  it("⚠️ never demands the review quote — a quote is a bonus angle", () => {
    const t8 = templateById("years-properties-review")!;
    expect(t8.requiredSlots).not.toContain("review_quote");
    expect(t8.requiredSlots).not.toContain("review_quote_source");
    // But it does demand the four figures the argument IS.
    for (const slot of ["years_trading", "properties_managed", "review_score", "review_count"]) {
      expect(t8.requiredSlots).toContain(slot);
    }
  });

  it("every template needs the company name, for the button", () => {
    for (const t of AD_TEMPLATES) expect(t.requiredSlots).toContain("company_name");
  });
});

describe("the multi-select vocabularies", () => {
  it("splits allowed from forbidden on what the customer ticked", () => {
    const t3 = templateById("never-see-the-messages")!;
    const { allowed, forbidden } = serviceTokensFor(t3, ["cleaning", "linen"]);
    expect(allowed).toContain("cleaning");
    expect(allowed).toContain("linen");
    expect(forbidden).toContain("pricing");
    expect(forbidden).toContain("guest messaging");
    expect(allowed.some((tok) => forbidden.includes(tok))).toBe(false);
  });

  it("⚠️ T6 offers the spec's six, so two-of-six is a real case", () => {
    const t6 = templateById("rules-keep-changing")!;
    expect(t6.services!.options).toHaveLength(6);
    const { allowed, forbidden } = serviceTokensFor(t6, ["licensing", "insurance"]);
    expect(allowed).toEqual(expect.arrayContaining(["licensing", "insurance"]));
    expect(forbidden).toEqual(expect.arrayContaining(["registration", "fire safety"]));
  });

  it("⚠️ keeps every token tight enough not to reject good copy", () => {
    // A loose token does not announce itself: the generation is rejected, the
    // retry is rejected, and the ad silently comes back generic.
    // Bare common words only. "licence" and "registration" are domain-specific
    // and safe; "fire" would match "fireplace", "gas" would match "gas bill",
    // "id" would match "idea", "check" would match "check it out".
    const tooLoose = ["fire", "gas", "id", "check", "safety", "records"];
    for (const t of AD_TEMPLATES) {
      for (const option of t.services?.options ?? []) {
        for (const tok of option.tokens) {
          expect(tok).toBe(tok.toLowerCase());
          expect(tooLoose).not.toContain(tok);
        }
      }
    }
  });

  it("only the templates the spec gives a multi-select carry one", () => {
    expect(AD_TEMPLATES.filter((t) => t.services).map((t) => t.id).sort())
      .toEqual(["never-see-the-messages", "rules-keep-changing"]);
  });
});

describe("⚠️ the SQL CHECK and this union cannot drift", () => {
  it("0156's template_id CHECK names exactly these four", () => {
    const block = migration.match(/ad_drafts_template_id_check[\s\S]*?\);/)?.[0] ?? "";
    expect(block).not.toBe("");
    const inSql = Array.from(block.matchAll(/'([a-z-]+)'/g)).map((m) => m[1]).sort();
    expect(inSql).toEqual([...AD_TEMPLATE_IDS].sort());
  });

  it("0156's ratio CHECK names exactly the three the renderer produces", () => {
    const block = migration.match(/ad_creatives_ratio_check[\s\S]*?\);/)?.[0] ?? "";
    const inSql = Array.from(block.matchAll(/'([0-9]+x[0-9]+)'/g)).map((m) => m[1]).sort();
    expect(inSql).toEqual(["1x1", "4x5", "9x16"]);
  });
});
