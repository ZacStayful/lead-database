/**
 * The funnel's preview (batch 02 Phase 2).
 *
 * WHAT BREAKS IF THESE FAIL
 * -------------------------
 * Anyone holding a funnel link reaches this response without signing in. A
 * volume or a count in it is our supply position handed to whoever asks (02
 * locked decision 7, 01 A4). A ticked similar area that differs between the
 * two plan columns shows the visitor a radius that is not the one they will
 * get. A postcode lock that refuses a change of spacing turns a typo into a
 * call to Zac.
 */
import { describe, expect, it } from "vitest";
import { parseBriefBody } from "@/lib/leadBrief/briefRequest";
import type { BriefInput } from "@/lib/leadBrief/input";
import { computeBriefPreview, previewForClient } from "@/lib/leadBrief/preview";
import {
  computeFunnelPreviews,
  funnelAnswers,
  funnelPreviewBody,
  FUNNEL_PREVIEW_BODY_KEYS,
  postcodeLockRefuses,
} from "@/lib/funnel/preview";
import { leads, supply } from "../../leadBrief/__tests__/fixtures";

const TODAY = "2026-10-08";

/** York, as leadBrief/__tests__/preview.test.ts places it. */
const YORK = supply({
  leads: [
    ...leads(15, "YO10"),
    ...leads(15, "YO31"),
    ...leads(40, "HG1", { gross: 60000, bedrooms: 4 }),
    ...leads(60, "LS1"),
  ],
});
const YORK_BRIEF: BriefInput = { basePostcode: "YO10 5DD", travelLimitMiles: null };

function body(over: Record<string, unknown> = {}) {
  return parseBriefBody({ basePostcode: "yo105dd", travelLimitMiles: null, ...over });
}

function ok(over: Record<string, unknown> = {}) {
  const r = computeFunnelPreviews(body(over), YORK, { today: TODAY });
  if (!r.ok) throw new Error(`expected previews, got ${JSON.stringify(r.issues)}`);
  return r;
}

describe("computeFunnelPreviews", () => {
  it("computes both plans", () => {
    const r = ok();
    expect(r.previews[10].plan).toBe(10);
    expect(r.previews[20].plan).toBe(20);
    expect(r.previews[10].capMiles).toBeLessThanOrEqual(40);
  });

  it("pre-ticks the 10-lead plan's recommended area, and ticks it in BOTH columns", () => {
    const plain = computeBriefPreview(YORK_BRIEF, 10, YORK, { today: TODAY });
    if (!plain.ok) throw new Error("fixture");
    const recommended = plain.preview.similarAreas.find((s) => s.recommended)?.area;
    expect(recommended).toBeTruthy();

    const r = ok();
    expect(r.similarAreas).toEqual([recommended]);
    expect(r.previews[10].brief.similarAreas).toEqual([recommended]);
    expect(r.previews[20].brief.similarAreas).toEqual([recommended]);
  });

  it("keeps the visitor's own choice once they have made one, including none", () => {
    expect(ok({ similarAreas: [] }).similarAreas).toEqual([]);
    expect(ok({ similarAreas: ["LS"] }).previews[20].brief.similarAreas).toEqual(["LS"]);
  });

  it("is what the engine gives for each plan with the same input", () => {
    const r = ok({ similarAreas: ["HG"] });
    for (const plan of [10, 20] as const) {
      const direct = computeBriefPreview({ ...YORK_BRIEF, similarAreas: ["HG"] }, plan, YORK, { today: TODAY });
      if (!direct.ok) throw new Error("fixture");
      expect(r.previews[plan]).toEqual(direct.preview);
    }
  });

  it("returns the engine's issues for input it cannot place", () => {
    const r = computeFunnelPreviews(body({ basePostcode: "ZZ99 9ZZ" }), YORK, { today: TODAY });
    expect(r.ok).toBe(false);
  });
});

describe("funnelPreviewBody — what leaves", () => {
  const response = funnelPreviewBody(ok({ minBedrooms: 4 }));

  it("has exactly these top-level keys", () => {
    // Duplicated on purpose (§27.2): a list derived from the code would pass whatever changed.
    expect(Object.keys(response).sort()).toEqual(["plans", "similarAreas"]);
    expect([...FUNNEL_PREVIEW_BODY_KEYS].sort()).toEqual(["plans", "similarAreas"]);
  });

  it("is two previewForClient results and nothing more", () => {
    const r = ok({ minBedrooms: 4 });
    expect(response.plans.map((p) => p.plan)).toEqual([10, 20]);
    expect(response.plans[0]).toEqual(previewForClient(r.previews[10]));
    expect(response.plans[1]).toEqual(previewForClient(r.previews[20]));
  });

  it("carries no key, at any depth, that names a volume, a count or the supply", () => {
    const banned =
      /count|volume|supply|deliverable|weeks|holder|contention|deficit|sample|lead|outcodes$|meets|target|lean|short|cannot/i;
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          expect(k, `${path}.${k}`).not.toMatch(banned);
          walk(x, `${path}.${k}`);
        }
      }
    };
    walk(response, "response");
    // The walk can see a leak: the server preview fails it.
    expect(() => walk(ok().previews[10], "server")).toThrow();
  });

  it("shows each plan's radius, for the plan screen (A5)", () => {
    for (const p of response.plans) {
      expect(p.coverage.map((c) => c.plan)).toEqual([10, 20]);
      expect(p.coverage.every((c) => c.radiusMiles > 0)).toBe(true);
    }
  });
});

describe("funnelAnswers", () => {
  const r = ok({ basePostcode: "yo10 5dd", minBedrooms: 4, priorityOutcodes: ["ls1"] });
  const answers = funnelAnswers(r.previews[10].brief);

  it("stores the normalised brief's fields and only those", () => {
    expect(Object.keys(answers).sort()).toEqual(
      ["basePostcode", "minBedrooms", "minGross", "priorityOutcodes", "similarAreas", "travelLimitMiles"].sort()
    );
    expect(answers.basePostcode).toBe("YO10 5DD");
    expect(answers.priorityOutcodes).toEqual(["LS1"]);
    expect(answers.minBedrooms).toBe(4);
  });

  it("reads back through the questionnaire's closed parser to the same brief", () => {
    const again = computeFunnelPreviews(parseBriefBody(answers), YORK, { today: TODAY });
    expect(again.ok && again.previews[20]).toEqual(r.previews[20]);
  });
});

describe("postcodeLockRefuses", () => {
  it("nothing is locked before the first preview", () => {
    expect(postcodeLockRefuses(null, "YO10 5DD")).toBe(false);
  });

  it("the same postcode is allowed, a different one refused", () => {
    expect(postcodeLockRefuses("YO10 5DD", "YO10 5DD")).toBe(false);
    expect(postcodeLockRefuses("YO10 5DD", "LS1 4AP")).toBe(true);
    expect(postcodeLockRefuses("YO10 5DD", "YO10")).toBe(true);
  });

  it("is compared after normalising, so spacing and case are never a refusal", () => {
    const typed = body({ basePostcode: " yo105dd " }).input.basePostcode;
    const canonical = computeBriefPreview({ ...YORK_BRIEF, basePostcode: typed }, 10, YORK, { today: TODAY });
    expect(canonical.ok && canonical.preview.brief.basePostcode).toBe("YO10 5DD");
  });
});
