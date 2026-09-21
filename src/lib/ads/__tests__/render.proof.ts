import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { AD_TEMPLATES, templateById } from "../templates";
import { flattenSpecText, layoutInputFrom, layoutSpec } from "../layout";
import { renderAdImage } from "../render";
import { fillPattern, serviceListPhrase } from "../resolveSlots";
import { AD_RATIOS } from "../storagePaths";
import { AD_IMAGE_CHARSET, AD_IMAGE_MAX } from "../metaFields";

/**
 * Render every template at every ratio and write the PNGs out, so a human can
 * look at them. `npm run proof:ads`, then open ./ad-proof/.
 *
 * ⚠️ BYTE COUNTS ARE NOT PROOF. Step 1 produced a perfectly valid PNG with a
 * tofu box where a tick should be, and another with the spaces eaten out of
 * the headline. Both passed every check a machine could make.
 */
const OUT = process.env.AD_PROOF_DIR ?? "ad-proof";

const SLOTS: Record<string, string> = {
  company_name: "Northside Lets",
  city: "Leeds",
  areas: "LS, WF and BD",
  years_trading: "8",
  properties_managed: "140",
  review_score: "4.9",
  review_count: "63",
  councils: "Leeds, Wakefield, Bradford and Kirklees",
};
const SELECTED: Record<string, string[]> = {
  "never-see-the-messages": ["guest_messaging", "cleaning", "linen", "check_ins"],
  "rules-keep-changing": ["licensing", "fire_safety", "insurance", "guest_id"],
};

it("renders every template at every ratio", async () => {
  mkdirSync(OUT, { recursive: true });
  for (const t of AD_TEMPLATES) {
    const selected = SELECTED[t.id] ?? [];
    const list = serviceListPhrase(t, selected) ?? undefined;
    const slots = { ...SLOTS, included_list: list, handled_list: list };
    const headline = fillPattern(t.exampleHeadlineLocated, slots as never)!;
    const sub = fillPattern(t.exampleSubLocated, slots as never)!;
    const cta = fillPattern(t.ctaPattern, slots as never)!;

    for (const ratio of AD_RATIOS) {
      const spec = layoutSpec(
        layoutInputFrom({ template: t, ratio, accent: "#2f6fed", logo: null, slots, selected, headline, sub, cta })
      );
      const res = await renderAdImage(spec);
      expect(res.ok, `${t.id} ${ratio}: ${JSON.stringify(res)}`).toBe(true);
      if (res.ok) writeFileSync(`${OUT}/${t.id}-${ratio}.png`, res.bytes);
    }

    /**
     * ⚠️ AND AGAIN WITH A MODEL-WRITTEN HEADLINE, WHICH IS THE NEW RISK.
     *
     * The card used to carry a string from `templates.ts` — ours, ASCII, and
     * length-checked by the eye that wrote it. It now carries whatever the model
     * returns, so the two things that can go wrong are length (neither the
     * headline nor the sub has a `lineClamp`, and `fontStep` stops shrinking at
     * the third step) and glyphs (`sanitiseForFont` DELETES an uncovered
     * character and closes the gap, which renders as a missing word).
     *
     * `AD_IMAGE_MAX` is the bound; this renders AT it, with the punctuation a
     * model actually writes. LOOK AT THESE — a valid PNG with a headline off
     * the bottom of the card is exactly what a byte count cannot tell you.
     */
    const modelHeadline =
      "Landlords in Leeds \u2014 you\u2019ll never see the *3am message*, the Friday " +
      "cancellation, or the \u201Ccheck in early?\u201D";
    const modelSub =
      "Full short let management, run by people who answer \u2026 so you can stop being the one who does.";
    expect(modelHeadline.length).toBeLessThanOrEqual(AD_IMAGE_MAX.headline);
    expect(modelSub.length).toBeLessThanOrEqual(AD_IMAGE_MAX.sub);
    expect(AD_IMAGE_CHARSET.test(modelHeadline)).toBe(true);
    expect(AD_IMAGE_CHARSET.test(modelSub)).toBe(true);

    for (const ratio of AD_RATIOS) {
      const spec = layoutSpec(
        layoutInputFrom({
          template: t, ratio, accent: "#2f6fed", logo: null, slots, selected,
          headline: modelHeadline, sub: modelSub, cta,
        })
      );
      const res = await renderAdImage(spec);
      expect(res.ok, `${t.id} ${ratio} model: ${JSON.stringify(res)}`).toBe(true);
      if (res.ok) writeFileSync(`${OUT}/${t.id}-${ratio}-model.png`, res.bytes);
    }

    // The flattened text is what the figure check reads. Writing it out makes
    // "is there a number on the card that nobody supplied" a thing you can see.
    const flat = flattenSpecText(
      layoutSpec(layoutInputFrom({ template: t, ratio: "4x5", accent: "#2f6fed", logo: null, slots, selected, headline, sub, cta })).root
    );
    writeFileSync(`${OUT}/${t.id}.txt`, flat);
  }
  // eslint-disable-next-line no-console
  console.log(`wrote ${AD_TEMPLATES.length * AD_RATIOS.length * 2} PNGs to ${OUT}/`);
});
