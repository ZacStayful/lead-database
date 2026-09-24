import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * File-text guards for things no pure unit test can reach, because
 * vitest.config.mts is PURE UNITS ONLY — no React, so a component's JSX and a
 * hook's effects are invisible to it.
 *
 * ⚠️ Comments are stripped and whitespace collapsed. Every file here explains
 * its own rule, and explaining it means naming the thing being banned — so a
 * raw substring check passes on the explanation and trains the next person to
 * delete the explanation (§51.11). Prettier also wraps freely, so a phrase
 * routinely spans a newline plus indentation.
 */
const SRC = resolve(__dirname, "..", "..", "..");
const source = (rel: string) =>
  readFileSync(resolve(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");

const PANEL = "components/dashboard/LeadFilteringPanel.tsx";
const ESTIMATOR = "components/marketing/LeadEstimator.tsx";
const CONTROLS = "components/filtering/RadiusControls.tsx";
const HOOK = "components/filtering/useRadiusSearch.ts";
const ROUTE = "app/api/customer/filter/route.ts";

describe("the two big files load on intent, not on mount", () => {
  it("⚠️ the estimator gates BOTH fetches on its own wantsGeo", () => {
    // The whole marketing-page risk of this change in one assertion. §28.6
    // records a 562 KB geojson fetch that fired for every visitor to both
    // landing pages because its gate named the DEFAULT mode. There are two
    // files now, so a second unconditional fetch is the same bug twice.
    const src = source(ESTIMATOR);
    expect(src).toContain("enabled: wantsGeo");
    expect(src).not.toContain('fetch("/data/');
  });

  it("the dashboard gates on radius mode", () => {
    const src = source(PANEL);
    expect(src).toContain('enabled: locationMode === "radius"');
    expect(src).not.toContain('fetch("/data/');
  });

  it("⚠️ neither file is ever statically imported", () => {
    // A static import puts the gazetteer in the landing pages' first-load JS,
    // which is a mount-time cost with NO network request to see in devtools —
    // §28.6's own mistake in the form its verification could not catch.
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const offenders = walk(SRC).filter((f) => {
      const src = readFileSync(f, "utf8");
      return /import[^;]*["'].*uk-places\.json["']/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("⚠️ the hook makes no decisions of its own", () => {
    // Everything that branches lives in parseRadiusCentre/resolveRadius,
    // which vitest can reach; a rule inside the hook is a rule nothing tests.
    const src = source(HOOK);
    expect(src).toContain("parseRadiusCentre(");
    expect(src).toContain("resolveRadius(");
    // The gate is the caller's, never re-derived here.
    expect(src).not.toMatch(/locationMode|wantsGeo/);
  });

  it("⚠️ BOTH of the hook's fetches early-return on !enabled", () => {
    // Asserted literally, because vitest cannot render a hook — so an effect
    // losing its gate is invisible to every behavioural test here, and §28.6
    // is a whole section about that exact mistake shipping unnoticed.
    const src = source(HOOK);
    expect(src).toContain("if (!enabled || features || geoFailed) return;");
    expect(src).toContain("if (!enabled || places || placesFailed) return;");
  });
});

describe("one list, one box", () => {
  it("the dropdown maps the constant and carries no mile literal", () => {
    const src = source(CONTROLS);
    expect(src).toContain("RADIUS_MILE_OPTIONS.map(");
    expect(src).not.toMatch(/\[\s*(?:5|10)\s*,\s*(?:10|20)\s*,/);
  });

  it("⚠️ neither caller holds its own default distance", () => {
    // The dashboard held 15, which was not on the list even before it was
    // re-scaled — so its <select> opened with nothing selected.
    for (const f of [PANEL, ESTIMATOR]) {
      expect(source(f), f).toContain("RADIUS_DEFAULT_MILES");
      expect(source(f), f).not.toMatch(/useState<number>\(\s*\d+\s*\)/);
    }
  });

  it("⚠️ the box does not ask Chrome for a postcode", () => {
    // On a box that now takes town names, Chrome offers the saved postcode
    // over our own list and can overwrite a half-typed name.
    expect(source(CONTROLS)).not.toContain('autoComplete="postal-code"');
    expect(source(CONTROLS)).toContain('autoComplete="off"');
  });

  it("the box announces itself as a combobox", () => {
    const src = source(CONTROLS);
    expect(src).toContain('role="combobox"');
    expect(src).toContain('role="listbox"');
    expect(src).toContain('role="option"');
  });

  it("⚠️ neither caller resolves a centre itself any more", () => {
    // Two copies of the ladder is how the dashboard and the estimator would
    // come to disagree about what "Newport" means.
    for (const f of [PANEL, ESTIMATOR]) {
      expect(source(f), f).not.toContain("parseOutcode");
      expect(source(f), f).not.toContain("outcodeCentroid");
    }
  });

  it("⚠️ the coverage list is truncated, not joined whole", () => {
    // At 78 areas a plain join is a ~1,900-character paragraph.
    const src = source(CONTROLS);
    expect(src).toContain("summariseAreas(");
    expect(src).toContain("areas.head.join");
  });

  it("⚠️ nothing block-level is nested inside a <p>", () => {
    // <p> takes phrasing content only. The disclosure was first written as a
    // <details>, which a browser auto-closes the <p> to escape — so the rest
    // of the sentence lands OUTSIDE the paragraph and a server-rendered page
    // then hydrates against a DOM React did not build. tsc is happy, the pure
    // unit suite cannot render, and only a browser shows it. This is the one
    // reachable assertion.
    const src = source(CONTROLS);
    const BLOCK = /<(details|div|ul|ol|li|section|table|h[1-6])\b/;
    let from = 0;
    for (;;) {
      const open = src.indexOf("<p ", from);
      if (open < 0) break;
      const close = src.indexOf("</p>", open);
      expect(close).toBeGreaterThan(open);
      const inner = src.slice(open, close);
      expect(BLOCK.test(inner), `block element inside <p>: ${inner.slice(0, 160)}`).toBe(false);
      from = close + 4;
    }
  });

  it("the panel blocks Apply on an unresolved radius as well as an empty one", () => {
    const src = source(PANEL);
    expect(src).toContain("radiusEmpty || radiusUnresolved");
  });

  it("⚠️ the panel persists the town name, not just the outcode", () => {
    // Without it admin reads "Radius: 20 mi from SP1" for a search the
    // customer made by typing Salisbury.
    expect(source(PANEL)).toContain("radius_place:");
  });

  it("⚠️ the route never stores a town with no centre behind it", () => {
    // A place name that survived while its outcode was rejected renders as
    // "Radius: 20 mi from Salisbury (null)". The route is a Next handler, so
    // vitest cannot call it — this is the only reachable assertion.
    const src = source(ROUTE);
    const at = src.indexOf("const radiusPlace =");
    expect(at).toBeGreaterThan(-1);
    const expr = src.slice(at, src.indexOf(";", at));
    expect(expr).toContain("radiusOutcode !== null");
    expect(expr).toContain('selectionMode === "radius"');
  });
});
