/**
 * What the three published pages are allowed to say (CLAUDE.md §51.11).
 *
 * Until 0138 these pages described a product that did not exist: a reject
 * popup that ran an automated contact-detail check and assigned a REPLACEMENT
 * LEAD, an email-verification processor that appears in no code at all, and a
 * cap of two operators per lead that live data contradicts 67 times over. The
 * feature they described was built on a branch abandoned in July 2026.
 *
 * These are legal and commercial statements — the privacy policy's sharing
 * line is a consent statement to landlords, not marketing copy (§36.7) — so
 * they get a test rather than a reviewer's memory.
 *
 * ⚠️ COMMENTS ARE STRIPPED BEFORE MATCHING. Every file that explains why a
 * phrase is banned necessarily contains that phrase, so a naive substring
 * check fails on the explanation and trains the next person to delete the
 * explanation. §46 hit exactly this.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PAGES = {
  "the lead-quality policy": "app/policies/lead-quality-and-data/page.tsx",
  "the privacy policy": "app/privacy-policy/page.tsx",
  "the landing page": "app/page.tsx",
} as const;

/**
 * Source with every comment removed, so a ban can be explained in place, and
 * whitespace collapsed to single spaces.
 *
 * ⚠️ THE COLLAPSE IS PART OF THE GUARD, not tidying. Prettier wraps this copy
 * at 80 columns, so "maximum of two operators" is routinely split across a
 * newline and eleven spaces of indentation — and a pattern matching the raw
 * file would sail straight past the very sentence it exists to forbid. It was
 * a line break that first made this file report a page as clean.
 */
function prose(relative: string): string {
  return readFileSync(resolve(__dirname, "..", "..", relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ");
}

describe("no published page caps a lead at two operators", () => {
  /**
   * Measured on production: 144 leads sit at a cap of three, 24 at four and 9
   * at five, and 67 have actually reached three or more operators. Escalation
   * raises the cap at day 10 and again at day 20 (§18), contention raises it
   * to four (§28.5), and a pool claim bypasses it altogether (§19.4).
   */
  for (const [name, path] of Object.entries(PAGES)) {
    it(`${name} does not`, () => {
      const src = prose(path);
      expect(src).not.toMatch(/maximum of two (operators|subscribers)/i);
      expect(src).not.toMatch(/more than two (operators|subscribers)/i);
      expect(src).not.toMatch(/two (operators|subscribers) simultaneously/i);
      expect(src).not.toMatch(/up to two of those operators/i);
    });
  }
});

describe("no published page promises a replacement lead", () => {
  /**
   * Neither refund route sends one. §39.1 says a filter release "is not a
   * lead-for-lead swap and there is no synchronous re-offer", and
   * `lead_quality_claims.resolution` has no `replacement` value at all, so the
   * database cannot record having sent one.
   */
  for (const [name, path] of Object.entries(PAGES)) {
    it(`${name} does not`, () => {
      const src = prose(path);
      expect(src).not.toMatch(/a replacement is assigned/i);
      expect(src).not.toMatch(/replacement (lead )?is (then )?(assigned|sent|issued)/i);
      expect(src).not.toMatch(/allocation is restored automatically/i);
    });
  }
});

describe("no published page claims a verification vendor we do not use", () => {
  /**
   * ZeroBounce appears in no code anywhere. Twilio is real but sends SMS
   * (`src/lib/sms.ts`); it has never looked a number up. `leadQuality.ts`
   * checks the SHAPE of a phone number and nothing more, and its own header
   * says so: "neither is implemented".
   */
  for (const [name, path] of Object.entries(PAGES)) {
    it(`${name} does not`, () => {
      const src = prose(path);
      expect(src).not.toMatch(/zerobounce/i);
      expect(src).not.toMatch(/verification service/i);
      expect(src).not.toMatch(/third-party verification/i);
    });
  }
});

describe("no published page names the claim allowance", () => {
  /**
   * §51.3's rule, extended to the pages a prospect reads. The mechanism only
   * works while the number is discovered rather than announced: an operator
   * told they get two a month has been handed the count of leads it is safe to
   * write off without evidence.
   */
  for (const [name, path] of Object.entries(PAGES)) {
    it(`${name} does not`, () => {
      const src = prose(path);
      expect(src).not.toMatch(/claim allowance|claims per (month|cycle)/i);
      expect(src).not.toMatch(/\b\d+ (reports?|claims?) (a|per) (month|cycle)/i);
    });
  }
});

describe("the lead-quality page still states the recourse that does exist", () => {
  it("names the credit, and every ending a lead can have", () => {
    const src = prose(PAGES["the lead-quality policy"]);
    expect(src).toMatch(/credit goes back on your account/i);
    expect(src).toMatch(/already appointed/i);
    // All four endings, so the page cannot quietly become about one of them.
    expect(src).toMatch(/Reject it/);
    expect(src).toMatch(/Discard it/);
    expect(src).toMatch(/didn&apos;t work out/i);
  });

  it("still says a lead that merely fails to convert is not refundable", () => {
    expect(prose(PAGES["the lead-quality policy"])).toMatch(
      /doesn&apos;t convert isn&apos;t grounds for a credit/i,
    );
  });
});
