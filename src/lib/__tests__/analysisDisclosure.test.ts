/**
 * The market-data sentence shown where a customer buys the £3 analysis (§71).
 *
 * A paid analysis runs on the Stayful estimate software, which keeps the run in
 * the table STR-Website-2's Market Explorer is built from. The customer is told
 * so at the point of purchase, and the privacy policy says the same thing.
 * Nothing but these guards would notice a surface losing the sentence, so they
 * are pinned on the real files.
 *
 * Comments are stripped and whitespace collapsed first, for the reasons
 * publishedClaims.test.ts gives: an explanation must never satisfy a guard on
 * its own, and Prettier wraps copy at 80 columns.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ANALYSIS_MARKET_DATA_NOTE } from "../analysisDisclosure";

function code(relative: string): string {
  return readFileSync(resolve(__dirname, "..", "..", relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ");
}

describe("the sentence itself", () => {
  it("says what is kept, and what never is", () => {
    expect(ANALYSIS_MARKET_DATA_NOTE).toMatch(/postcode/);
    expect(ANALYSIS_MARKET_DATA_NOTE).toMatch(/bedrooms/);
    expect(ANALYSIS_MARKET_DATA_NOTE).toMatch(/market data/);
    expect(ANALYSIS_MARKET_DATA_NOTE).toMatch(/without the landlord’s name, contact details or street address/);
  });

  it("promises nothing about who can see the lead", () => {
    // §32.9: an analysed lead a customer added may be sold on once, and nothing
    // tells the uploader. This sentence is about market data only, so it must
    // never claim the lead itself stays private.
    expect(ANALYSIS_MARKET_DATA_NOTE).not.toMatch(/only (visible )?to you|private|never shared/i);
  });

  it("lives in an import-free module, because client components render it", () => {
    const src = readFileSync(resolve(__dirname, "..", "analysisDisclosure.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\b/m);
  });
});

describe("every surface that sells the analysis shows it", () => {
  const SURFACES = {
    "the offer panel (import result and lead page)": "components/dashboard/AnalysisOfferPanel.tsx",
    "the manual-add checkbox": "components/dashboard/ManualLeadForm.tsx",
  } as const;

  for (const [name, path] of Object.entries(SURFACES)) {
    it(name, () => {
      const src = code(path);
      expect(src).toMatch(/import \{ ANALYSIS_MARKET_DATA_NOTE \} from "@\/lib\/analysisDisclosure";/);
      expect(src).toMatch(/\{ANALYSIS_MARKET_DATA_NOTE\}/);
    });
  }

  it("the offer panel shows it before the buy button, not after", () => {
    const src = code("components/dashboard/AnalysisOfferPanel.tsx");
    const note = src.indexOf("{ANALYSIS_MARKET_DATA_NOTE}");
    const armed = src.indexOf("{armed ? (");
    expect(note).toBeGreaterThan(-1);
    expect(armed).toBeGreaterThan(-1);
    expect(note).toBeLessThan(armed);
  });
});

describe("the privacy policy says the same thing", () => {
  it("has a section on the paid analysis and what is kept from it", () => {
    const src = code("app/privacy-policy/page.tsx");
    expect(src).toMatch(/5\.3 Leads you add yourself, and the paid analysis/);
    expect(src).toMatch(/We never send the landlord&apos;s name, email address or phone number/);
    expect(src).toMatch(/not the street address/);
    expect(src).toMatch(/never against a single postcode/);
  });

  it("never claims a customer's figures are always pooled with others", () => {
    // STR-Website-2 shows an area from its first report, and each bedroom size
    // however few, so a figure can rest on one analysed lead (CLAUDE.md §71.2).
    // "Never against a single postcode" is true; "pooled with other reports"
    // would not be.
    const src = code("app/privacy-policy/page.tsx");
    expect(src).not.toMatch(/pooled|combined with other|alongside other reports/i);
  });
});
