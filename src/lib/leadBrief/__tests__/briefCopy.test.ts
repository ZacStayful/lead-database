import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GROSS_THRESHOLDS } from "@/lib/filterPrediction";
import { MAX_MIN_BEDROOMS } from "@/lib/leadBrief/plans";
import { BOOKING_URL } from "@/lib/prospect/copy";
import {
  BRIEF_BEDROOM_OPTIONS,
  BRIEF_BOOKING_URL,
  BRIEF_GROSS_OPTIONS,
  ISSUE_QUESTION,
  LABEL_EXPLANATIONS,
  LABEL_NAMES,
  bottleneckLines,
  competitionLine,
  coverageLine,
  firstPickLine,
  includingPhrase,
  issueMessage,
  switchExplainer,
  tradeoffLine,
} from "@/lib/leadBrief/briefCopy";
import { MATCH_LABELS } from "@/lib/leadBrief/types";

/**
 * The questionnaire's copy rules (A1, A6, A9, locked decisions 7 and 8).
 *
 * Read from the real files rather than a restatement of them (§42.8): every
 * string literal in the copy module and every string or JSX text in the two
 * questionnaire components, comments stripped first.
 */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
function stringLiterals(src: string): string {
  const out: string[] = [];
  const re = /"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  for (const m of Array.from(strip(src).matchAll(re))) out.push(m[0]);
  return out.join("\n");
}
function jsxText(src: string): string {
  const out: string[] = [];
  for (const m of Array.from(strip(src).matchAll(/>([^<>{}]+)</g))) out.push(m[1]);
  return out.join("\n");
}

const COPY = readFileSync("src/lib/leadBrief/briefCopy.ts", "utf8");
const LABEL_COPY = readFileSync("src/lib/leadBrief/labelCopy.ts", "utf8");
const WIZARD = readFileSync("src/components/leadBrief/BriefWizard.tsx", "utf8");
const VIEW = readFileSync("src/components/leadBrief/BriefPreviewView.tsx", "utf8");
// Phase 5's label surfaces (labelCopy.ts and the three components) are held to
// the same A9 list as the questionnaire.
const LABEL_COMPONENTS = [
  "src/components/leadBrief/MatchLabelBadge.tsx",
  "src/components/leadBrief/WhyThisLead.tsx",
  "src/components/leadBrief/NotForMe.tsx",
].map((p) => readFileSync(p, "utf8"));
const CUSTOMER_TEXT = [
  stringLiterals(COPY),
  stringLiterals(LABEL_COPY),
  jsxText(WIZARD),
  jsxText(VIEW),
  ...LABEL_COMPONENTS.map(jsxText),
].join("\n");

const A9_BANNED = [
  /\bfilter/i,
  /\bminimum/i,
  /\brestricted/i,
  /\bexpanded/i,
  /\boverride/i,
  /\btop[- ]?up/i,
  /outside your criteria/i,
  /non-?matching/i,
];

describe("brief copy — A9 words to avoid", () => {
  for (const re of A9_BANNED) {
    it(`never says ${re}`, () => {
      expect(CUSTOMER_TEXT).not.toMatch(re);
    });
  }

  it("the scan actually sees the copy (guards the guard)", () => {
    expect(CUSTOMER_TEXT).toContain("Every lead you pay for is delivered");
    expect(CUSTOMER_TEXT).toContain("Where do you operate?");
    expect(CUSTOMER_TEXT).toContain("Why you got this lead");
  });
});

describe("brief copy — A1 and the house style", () => {
  it("states the credit-based promise", () => {
    expect(COPY).toContain(
      "Every lead you pay for is delivered. If a month runs short, the balance carries forward."
    );
  });

  it("never promises a timeframe or a guarantee", () => {
    expect(CUSTOMER_TEXT).not.toMatch(/every cycle/i);
    expect(CUSTOMER_TEXT).not.toMatch(/every month/i);
    expect(CUSTOMER_TEXT).not.toMatch(/full allocation/i);
    expect(CUSTOMER_TEXT).not.toMatch(/guarantee/i);
  });

  it("has no exclamation marks", () => {
    expect(CUSTOMER_TEXT).not.toContain("!");
  });

  it("A5's coverage explainer, verbatim", () => {
    expect(COPY).toContain(
      "Your area is set from live lead supply, so every lead you pay for is delivered. A tighter area means fewer landlords enquire there each month, so a smaller plan keeps your area tighter. Pick the balance that suits how far you're willing to travel."
    );
    expect(coverageLine({ plan: 20, radiusMiles: 35, basePostcode: "YO10 5DD", otherAreas: 0 })).toBe(
      "20 leads a month: within 35 miles of YO10 5DD"
    );
  });
});

describe("brief copy — labels and competition (locked decisions 7 and 8)", () => {
  it("names and explains every label", () => {
    for (const l of MATCH_LABELS) {
      expect(LABEL_NAMES[l]).toBeTruthy();
      expect(LABEL_EXPLANATIONS[l]).toBeTruthy();
    }
  });

  it("never claims exclusivity, first or closest operator", () => {
    expect(CUSTOMER_TEXT).not.toMatch(/closest operator/i);
    expect(CUSTOMER_TEXT).not.toMatch(/first operator/i);
    expect(CUSTOMER_TEXT).not.toMatch(/exclusive|only you|no one else/i);
  });

  it("competition is always from management companies, never our customers", () => {
    expect(competitionLine("high")).toBe("High competition from management companies");
    expect(competitionLine(null)).toBeNull();
    expect(CUSTOMER_TEXT).not.toMatch(/our (network|customers|subscribers)/i);
  });

  it("a first pick says low competition only when the tier is low", () => {
    expect(firstPickLine("YO10", "low")).toContain("low competition");
    expect(firstPickLine("YO10", "medium")).toBe("YO10");
    expect(firstPickLine("YO10", null)).toBe("YO10");
  });
});

describe("brief copy — trade-offs and the bottleneck are gains (A6, A7)", () => {
  it("frames a trade-off as a gain", () => {
    expect(
      tradeoffLine({ essential: "revenue", from: 75000, to: 50000, radiusMiles: 35, milesSaved: 20 })
    ).toBe("Including £50k+ properties brings your area in by 20 miles, to within 35 miles.");
    expect(
      tradeoffLine({ essential: "bedrooms", from: 4, to: 3, radiusMiles: 30, milesSaved: 1 })
    ).toBe("Including 3-bedroom properties brings your area in by 1 mile, to within 30 miles.");
  });

  it("never says drop or remove", () => {
    expect(CUSTOMER_TEXT).not.toMatch(/\bdrop\b|\bremove your\b|requirement/i);
  });

  it("names the essential and the step that works", () => {
    expect(
      bottleneckLines({
        causes: [{ essential: "bedrooms", relaxTo: 3 }],
        current: { minBedrooms: 5, minGross: null },
        radiusMiles: 75,
      })
    ).toEqual([
      "Your 5+ bedroom priority is what's holding your area back.",
      "Including properties with 3 or more bedrooms covers your plan within 75 miles.",
    ]);
  });

  it("names every cause when there are several, each with its own step", () => {
    const lines = bottleneckLines({
      causes: [
        { essential: "revenue", relaxTo: 50000 },
        { essential: "bedrooms", relaxTo: 4 },
      ],
      current: { minBedrooms: 5, minGross: 75000 },
      radiusMiles: 75,
    });
    expect(lines[0]).toContain("£75k+ revenue and 5+ bedroom priorities");
    expect(lines).toContain("Including £50k+ properties.");
    expect(lines).toContain("Including 4-bedroom properties.");
  });

  it("when every cause must go, says so as one combined step (true either way)", () => {
    const lines = bottleneckLines({
      causes: [
        { essential: "revenue", relaxTo: null },
        { essential: "bedrooms", relaxTo: null },
      ],
      current: { minBedrooms: 5, minGross: 75000 },
      radiusMiles: 40,
    });
    expect(lines[0]).toMatch(/^Together, your/);
    expect(lines[1]).toBe(
      "Including properties of every size and at every revenue level covers your plan within 40 miles."
    );
  });

  it("includingPhrase covers dropping an essential", () => {
    expect(includingPhrase("bedrooms", 2, null)).toBe("Including properties of every size");
    expect(includingPhrase("revenue", 25000, null)).toBe("Including properties at every revenue level");
  });
});

describe("brief copy — switching to 10 leads (approved 9 Oct)", () => {
  it("says when it changes and that nothing is charged or refunded today", () => {
    const s = switchExplainer("2026-11-09");
    expect(s).toContain("from your next renewal on 9 November");
    expect(s).toContain("Nothing is charged or refunded today");
    expect(s).toContain("the leads you've paid for this month are still yours");
  });

  it("still reads without a date", () => {
    expect(switchExplainer(null)).toContain("from your next renewal.");
  });
});

describe("brief copy — fixed lists and links", () => {
  it("offers exactly the revenue thresholds the rest of the system uses", () => {
    expect([...BRIEF_GROSS_OPTIONS]).toEqual([...GROSS_THRESHOLDS]);
  });

  it("offers bedrooms 1 to the brief maximum", () => {
    expect([...BRIEF_BEDROOM_OPTIONS]).toEqual(
      Array.from({ length: MAX_MIN_BEDROOMS }, (_, i) => i + 1)
    );
  });

  it("books a call on the one booking link unless the env var says otherwise", () => {
    if (!process.env.NEXT_PUBLIC_BOOKING_URL) expect(BRIEF_BOOKING_URL).toBe(BOOKING_URL);
    expect(COPY).toContain("process.env.NEXT_PUBLIC_BOOKING_URL || BOOKING_URL");
  });

  it("has a sentence and a home question for every input issue the engine can return", () => {
    const codes = [
      "base_postcode_unrecognised",
      "base_outcode_unplaceable",
      "travel_limit_invalid",
      "min_bedrooms_invalid",
      "min_gross_invalid",
      "priority_outcode_unrecognised",
      "similar_area_invalid",
      "ranking_invalid",
      "threshold_invalid",
    ];
    // Every code the engine declares is listed here.
    const input = readFileSync("src/lib/leadBrief/input.ts", "utf8");
    const declared = Array.from(input.matchAll(/code: "([a-z_]+)"/g)).map((m) => m[1]);
    expect(new Set(declared)).toEqual(new Set(codes));
    for (const code of codes) {
      expect(Object.keys(ISSUE_QUESTION)).toContain(code);
      expect(issueMessage({ code })).not.toMatch(/^Something in your answers/);
    }
  });

  it("the copy module stays client-safe: only the import-free booking link", () => {
    const imports = Array.from(strip(COPY).matchAll(/^import .* from "([^"]+)";/gm)).map((m) => m[1]);
    // Phase 5: the label names and money helpers moved to labelCopy.ts, which
    // must itself stay import-free so client components can use it.
    expect(imports).toEqual(["@/lib/prospect/copy", "@/lib/leadBrief/labelCopy"]);
    const prospect = readFileSync("src/lib/prospect/copy.ts", "utf8");
    expect(strip(prospect)).not.toMatch(/^import /m);
    expect(strip(LABEL_COPY)).not.toMatch(/^import /m);
  });
});
