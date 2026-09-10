import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_SECTIONS } from "../sectionIndex";
import { GLOSSARY, ROUTES, productContext } from "../productContext";

/**
 * ⚠️ EVERY CLAIM THE PACK MAKES ABOUT THIS REPOSITORY IS CHECKED HERE.
 *
 * The pack's failure mode is not an exception, it is a QUIETLY WORSE PROMPT: a
 * route that no longer exists, a file path that was renamed, a §-reference that
 * points at the wrong feature. Nothing at runtime would notice, and the damage
 * shows up weeks later as an implementation prompt confidently pointing at a
 * file that is not there.
 *
 * So the assertions below are deliberately about the real filesystem rather
 * than about the module's own contents (§42.8).
 */

/** Every `page.tsx` under a directory, as the path a customer would see. */
function pagesUnder(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...pagesUnder(`${dir}/${entry.name}`, `${base}/${entry.name}`));
    else if (entry.name === "page.tsx") out.push(base || "/");
  }
  return out;
}

describe("the route map", () => {
  it("has an entry for every customer-facing dashboard page", () => {
    const actual = pagesUnder("src/app/dashboard").map((p) => `/dashboard${p === "/" ? "" : p}`);
    const mapped = new Set(ROUTES.map((r) => r.path));
    const missing = actual.filter((p) => !mapped.has(p));
    expect(
      missing,
      `New screens with no entry in productContext.ts. A page the pack does not ` +
        `know about is a page Claude will never ask a useful question about. Add ` +
        `them to ROUTES.`
    ).toEqual([]);
  });

  it("describes no page that does not exist", () => {
    const actual = new Set(pagesUnder("src/app/dashboard").map((p) => `/dashboard${p === "/" ? "" : p}`));
    const stale = ROUTES.map((r) => r.path).filter((p) => !actual.has(p));
    expect(stale, "ROUTES entries for pages that have been deleted or renamed").toEqual([]);
  });

  it("points only at files that are really there", () => {
    // The single most damaging kind of rot: a generated prompt that sends a
    // Claude Code session to a path that was renamed three migrations ago.
    const bad: string[] = [];
    for (const r of ROUTES) {
      for (const f of [...r.files, ...(r.tests ?? [])]) {
        if (!existsSync(join(process.cwd(), f))) bad.push(`${r.path} → ${f}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("cites only CLAUDE.md sections that exist", () => {
    const known = new Set(CLAUDE_SECTIONS.map((s) => s.n));
    const bad = ROUTES.filter((r) => r.section !== undefined && !known.has(r.section));
    expect(bad.map((r) => `${r.path} → §${r.section}`)).toEqual([]);
  });

  it("gives every route a purpose written for a customer, not a schema", () => {
    for (const r of ROUTES) {
      expect(r.purpose.length, `${r.path} needs a real purpose`).toBeGreaterThan(20);
      expect(r.files.length, `${r.path} needs at least one file`).toBeGreaterThan(0);
    }
  });
});

describe("the rendered pack", () => {
  it("carries the parts that make the questions specific", () => {
    const pack = productContext();
    expect(pack).toContain("/dashboard/leads/priority");
    expect(pack).toContain("Reject does not refund");
    expect(pack).toContain("Guaranteed Rent");
    expect(pack).toContain("§46");
    for (const term of Object.keys(GLOSSARY)) expect(pack).toContain(term);
  });

  it("is a stable cache prefix", () => {
    // It is rendered ahead of the cache breakpoint, so a date, a customer or a
    // random id leaking in would silently cost a cache read on every single
    // request. Two renders a moment apart must be byte-identical.
    expect(productContext()).toBe(productContext());
    expect(productContext()).not.toMatch(/\b20\d\d-\d\d-\d\dT/);
  });

  it("reads the live plan prices rather than a copy of them", () => {
    // plans.ts moved once already (GR went from one tier to two). A hardcoded
    // price here would have gone quietly wrong that day.
    const pack = productContext();
    expect(pack).toContain("£150/month for 10 leads");
    expect(pack).toContain("£300/month for 20 leads");
  });
});
