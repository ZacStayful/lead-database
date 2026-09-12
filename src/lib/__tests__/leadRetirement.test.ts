import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LEAD_RETIREMENT_EXPLAINER,
  LEAD_RETIREMENT_REASONS,
  isLeadRetirementReason,
  leadRetirementLabel,
  type LeadRetirementReason,
} from "@/lib/leadRetirement";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const MIGRATION = "supabase/migrations/0144_lead_retirement_reason.sql";
const CONTROL = "src/components/admin/SwapLeadControl.tsx";

/**
 * The values `lead_retirement_reason()` can return, read out of its own body.
 *
 * Scoped to the function rather than the whole file, because the migration's
 * header quotes several of these keys in prose and a whole-file scan would
 * pass on the explanation instead of the code.
 */
function sqlReasonValues(): string[] {
  const sql = read(MIGRATION);
  const start = sql.indexOf("create or replace function public.lead_retirement_reason");
  expect(start).toBeGreaterThan(-1);
  const body = sql.slice(start, sql.indexOf("$$;", start));
  return Array.from(body.matchAll(/then '([a-z_]+)'/g), (m) => m[1]).sort();
}

describe("the reason vocabulary is one contract with the SQL", () => {
  // ⚠️ The whole point of this file. A basis added in SQL and not here renders
  // as its raw key; one renamed here and not there renders as nothing. Neither
  // fails anywhere else, and neither is visible until an admin is looking at a
  // greyed lead wondering why. Same arrangement §29 uses for cancelOptions.ts.
  it("has exactly the keys lead_retirement_reason() can return", () => {
    expect(Object.keys(LEAD_RETIREMENT_REASONS).sort()).toEqual(sqlReasonValues());
  });

  it("really did find the arms, rather than matching nothing", () => {
    expect(sqlReasonValues()).toHaveLength(5);
    expect(sqlReasonValues()).toContain("claimed_from_pool");
  });

  it("has a non-empty label for every one", () => {
    for (const key of Object.keys(LEAD_RETIREMENT_REASONS) as LeadRetirementReason[]) {
      expect(LEAD_RETIREMENT_REASONS[key].length).toBeGreaterThan(0);
      expect(leadRetirementLabel(key)).toBe(LEAD_RETIREMENT_REASONS[key]);
    }
  });

  it("renders an unrecognised value verbatim rather than blank", () => {
    // A key the database holds and this file does not know about is still
    // better shown than swallowed — cancelReasonLabel takes the same line.
    expect(leadRetirementLabel("some_future_basis")).toBe("some_future_basis");
    expect(isLeadRetirementReason("some_future_basis")).toBe(false);
    expect(isLeadRetirementReason(null)).toBe(false);
    expect(isLeadRetirementReason("claimed_from_pool")).toBe(true);
  });
});

describe("the picker counts selectable leads, not rows", () => {
  // ⚠️ The list now carries leads the swap refuses, so a count over
  // `candidates` tells the admin there are more replacements available than
  // there are — and a greyed row inside "Matches their filter" would make the
  // toggle that reveals off-filter stock fire on a lead nobody can pick.
  //
  // Asserted on the component's own text because it is a "use client" file and
  // vitest.config.mts is pure units only, no React (§50). A behavioural test
  // for this does not exist and cannot, so the shape is what is pinned —
  // §42.8's lesson, where a boundary asserted in a pull request and never
  // actually written cost 91 follow-up runs.
  const src = () => read(CONTROL);

  it("derives selectable and unavailable from retired_reason", () => {
    expect(src()).toMatch(
      /const selectable = candidates\.filter\(\(c\) => !c\.retired_reason\)/
    );
    expect(src()).toMatch(
      /const unavailable = candidates\.filter\(\(c\) => c\.retired_reason\)/
    );
  });

  it("groups by filter over the SELECTABLE rows, never over candidates", () => {
    expect(src()).toMatch(
      /const matching = selectable\.filter\(\(c\) => c\.matches_filter\)/
    );
    expect(src()).toMatch(
      /const outside = selectable\.filter\(\(c\) => !c\.matches_filter\)/
    );
  });

  it("never counts raw candidates in the placeholder or the flat list", () => {
    // `candidates.length` may appear nowhere as a count. Both readings of it
    // were wrong once 0144 landed: the "(N available)" placeholder and the
    // "no eligible leads" test.
    expect(src()).not.toContain("${candidates.length} available");
    expect(src()).not.toContain("candidates.length === 0");
  });

  it("renders every unavailable option disabled", () => {
    // The greying, and the only thing that makes "a selection cannot fail on
    // eligibility" still true now the rows are in the list.
    expect(src()).toMatch(
      /unavailable\.map\(\(c\) => \(\s*<option key=\{c\.id\} value=\{c\.id\} disabled>/
    );
  });

  it("refuses a retired lead in choose(), belt and braces", () => {
    expect(src()).toMatch(/setChosen\(picked && !picked\.retired_reason \? picked : null\)/);
  });
});

describe("the explainer names what an admin can actually do", () => {
  // The useful half of telling somebody why a lead is unavailable is telling
  // them whether they can do anything about it. Both escape hatches un-retire
  // the lead everywhere (0143's suite proves it), which is why the swap has no
  // per-swap override of its own.
  it("names both reversible bases and admits the irreversible one", () => {
    expect(LEAD_RETIREMENT_EXPLAINER).toContain("Expired leads");
    expect(LEAD_RETIREMENT_EXPLAINER).toContain("overridden");
    expect(LEAD_RETIREMENT_EXPLAINER).toContain("cannot be recovered");
  });

  it("does not offer an override the swap does not have", () => {
    expect(LEAD_RETIREMENT_EXPLAINER.toLowerCase()).not.toContain("tick");
    expect(LEAD_RETIREMENT_EXPLAINER.toLowerCase()).not.toContain("anyway");
  });
});
