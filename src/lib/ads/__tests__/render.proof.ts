import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { AD_TEMPLATES, templateById } from "../templates";
import { flattenSpecText, layoutInputFrom, layoutSpec } from "../layout";
import { renderAdImage } from "../render";
import { fillPattern, serviceListPhrase } from "../resolveSlots";
import { AD_RATIOS } from "../storagePaths";

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
    const headline = fillPattern(t.headlineLocated, slots as never)!;
    const sub = fillPattern(t.subLocated, slots as never)!;
    const cta = fillPattern(t.ctaPattern, slots as never)!;

    for (const ratio of AD_RATIOS) {
      const spec = layoutSpec(
        layoutInputFrom({ template: t, ratio, accent: "#2f6fed", logo: null, slots, selected, headline, sub, cta })
      );
      const res = await renderAdImage(spec);
      expect(res.ok, `${t.id} ${ratio}: ${JSON.stringify(res)}`).toBe(true);
      if (res.ok) writeFileSync(`${OUT}/${t.id}-${ratio}.png`, res.bytes);
    }

    // The flattened text is what the figure check reads. Writing it out makes
    // "is there a number on the card that nobody supplied" a thing you can see.
    const flat = flattenSpecText(
      layoutSpec(layoutInputFrom({ template: t, ratio: "4x5", accent: "#2f6fed", logo: null, slots, selected, headline, sub, cta })).root
    );
    writeFileSync(`${OUT}/${t.id}.txt`, flat);
  }
  // eslint-disable-next-line no-console
  console.log(`wrote ${AD_TEMPLATES.length * AD_RATIOS.length} PNGs to ${OUT}/`);
});
