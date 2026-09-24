import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The wiring guards for §69.
 *
 * ⚠️ `vitest.config.mts` is PURE UNITS ONLY — no React — so none of what these
 * assert can be reached behaviourally. §66.2 is the standing proof of what that
 * costs: `radiusCoverage` was correct and unit-tested, `RadiusControls` carried
 * both wordings, and `LeadEstimator` simply never called it — so every Northern
 * Ireland visitor read advice that could not work, for two weeks, with the whole
 * suite green. A correct pure function whose caller never reads it is invisible
 * here.
 *
 * ⚠️ Comments are stripped and whitespace collapsed first, the arrangement the
 * top-up guard already uses. Every one of these files EXPLAINS the rule it is
 * being checked against, and explaining it means naming the same identifiers —
 * so a raw substring check passes on the explanation and trains the next person
 * to delete the explanation (§46, §51.11). Prettier also wraps freely, so a
 * required phrase is routinely split across a newline and eleven spaces.
 */
const source = (file: string) =>
  readFileSync(resolve(__dirname, "..", "..", file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");

const PANEL = "components/dashboard/LeadFilteringPanel.tsx";
const HOME = "app/dashboard/page.tsx";
const TOKEN_PAGE = "app/topup/[token]/page.tsx";
const TOKEN_CONFIRM = "app/topup/[token]/TopupConfirm.tsx";
const PORTAL_ROUTE = "app/api/customer/topup/route.ts";
const TOKEN_ROUTE = "app/api/topup/[token]/route.ts";

describe("planVsFilter stays reachable from a client component", () => {
  it("⚠️ is import-free, so the two 'use client' consumers can hold it", () => {
    // The featureRequest.ts (§21.8) / deadLeadCopy.ts (§51.6) rule.
    const src = source("lib/planVsFilter.ts");
    expect(src).not.toMatch(/\bimport\s/);
    expect(src).not.toMatch(/\bfrom\s+"/);
  });
});

describe("the saved-filter box actually renders the comparison", () => {
  it("feeds it the RESOLVED figure, not the raw stored column", () => {
    // shownLeads carries §58.3's stored-vs-live fallback. Passing
    // props.expectedLeads instead silently drops every customer whose filter
    // predates 0100 back to no comparison at all.
    const src = source(PANEL);
    expect(src).toContain("expected: shownLeads");
    expect(src).not.toContain("expected: props.expectedLeads");
  });

  it("feeds it the balance", () => {
    expect(source(PANEL)).toContain("balance: props.leadBalance");
  });

  it("computes both sentences from the verdict", () => {
    const src = source(PANEL);
    expect(src).toContain("planGapSentence(savedGap)");
    expect(src).toContain("bankedCreditSentence(savedGap)");
  });

  it("⚠️ renders each one, GATED on its own value and not on a re-call", () => {
    // The gate and the render must be distinguishable strings. Written as
    // `{f(x) && <p>{f(x)}</p>}` they are identical, so deleting the gate leaves
    // this green while the line stops rendering — which is exactly what
    // happened on the first pass of this guard.
    const src = source(PANEL);
    expect(src).toContain("{savedGapLines && (");
    expect(src).toContain("{savedGapLines.gap}");
    expect(src).toContain("{savedGapLines?.banked && (");
    expect(src).toContain("{savedGapLines.banked}");
  });

  it("⚠️ consults downgradeRelief before calling a cheaper plan a fix", () => {
    // recommendedDowngrade offers the £150/10 plan to a customer forecast at 1
    // lead a month — £150 a lead, cheaper and not a fix (§28.3).
    const src = source(PANEL);
    expect(src).toContain("downgradeRelief(");
    expect(src).toContain('"cheaper_but_still_poor"');
  });
});

describe("the dashboard home caption", () => {
  it("⚠️ is given the renewal date, so the balance facts can reach it", () => {
    // filterMessage REPLACES the zero-credit and pacing captions, so a filtered
    // management customer was the one person who read neither.
    expect(source(HOME)).toContain("filterMessage(customer, renewalDate)");
  });

  it("calls the shared verdict rather than restating the comparison", () => {
    const src = source(HOME);
    expect(src).toContain("planVsFilter({");
    expect(src).toContain("bankedCreditSentence(gap)");
  });

  it("⚠️ names the revenue floor, which §68 shipped and this sentence missed", () => {
    const src = source(HOME);
    expect(src).toContain("filterCriteriaPhrase(");
    expect(src).toContain("customer.filter_min_gross ?? null");
  });
});

describe("the emailed top-up path", () => {
  it("⚠️ carries the figure-specific warning to the page", () => {
    // This is the surface a short customer actually reaches, and until §69 it
    // had the generic delivery note and nothing else.
    expect(source(TOKEN_PAGE)).toContain("filterWarning={view.filterWarning}");
  });

  it("renders it and gates the button on the tick", () => {
    const src = source(TOKEN_CONFIRM);
    expect(src).toContain("{filterWarning}");
    expect(src).toContain("filterWarning != null && !acknowledged");
    expect(src).toContain("acknowledge_filter: acknowledged");
  });

  it("⚠️ resolves the warning failing OPEN, never into a refusal", () => {
    // A transient read failure must cost a sentence, never a sale (§16). The
    // select widened, so what can fail widened with it.
    const src = source("lib/topup.ts");
    expect(src).toMatch(/filterWarning: customer \? topupFilterWarning\(/);
    expect(src).toMatch(/\)\s*: null,/);
  });

  it("⚠️ uses ONE select literal so supabase-js can infer the row", () => {
    // A concatenated select string collapses the inferred type to
    // GenericStringError and every field read stops typechecking.
    const src = source("lib/topup.ts");
    expect(src).not.toMatch(/\.select\(\s*"[^"]*"\s*\+/);
  });
});

describe("the acknowledgement is enforced server-side, not just on screen", () => {
  it.each([
    ["the in-portal route", PORTAL_ROUTE],
    ["the emailed-link route", TOKEN_ROUTE],
  ])("%s refuses an un-acknowledged purchase with a 400", (_name, file) => {
    // Until §69 the warning was cosmetic: neither route consulted the filter or
    // the balance, so the server charged whatever the screen had said (§40.10).
    const src = source(file);
    expect(src).toContain("topupFilterWarning(");
    expect(src).toContain("acknowledge_filter !== true");
    expect(src).toContain('code: "topup_not_acknowledged"');
    expect(src).toContain("status: 400");
  });

  it("⚠️ the emailed route RELEASES the claim before refusing", () => {
    // The token is single-use. Refusing without releasing burns the customer's
    // only link on a refusal we invited them to clear by ticking a box.
    const src = source(TOKEN_ROUTE);
    const gate = src.indexOf("const filterWarning = topupFilterWarning(");
    const refusal = src.indexOf('code: "topup_not_acknowledged"');
    const release = src.indexOf("release_lead_topup_token", gate);
    expect(gate).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(gate);
    expect(release).toBeGreaterThan(gate);
    expect(release).toBeLessThan(refusal);
  });
});
