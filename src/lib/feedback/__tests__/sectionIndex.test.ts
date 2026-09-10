import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { CLAUDE_SECTIONS, DEFERRED, INVARIANTS, KNOWN_ISSUES } from "../sectionIndex";

/**
 * ⚠️ THIS IS THE ANTI-STALENESS GUARD, AND IT IS THE WHOLE REASON THE CONTEXT
 * PACK CAN BE TRUSTED.
 *
 * `sectionIndex.ts` is generated from CLAUDE.md and committed, because CLAUDE.md
 * is not traced into the Vercel bundle and cannot be read at request time. A
 * committed derivative rots silently — so this re-runs the derivation and fails
 * if the two have parted. `npm run build` runs vitest first, so a new CLAUDE.md
 * section cannot ship with a stale index.
 *
 * §42.8's lesson applies: this shells out to the REAL generator rather than
 * restating its parsing, because a test that reimplements the thing it checks
 * asserts a version that was never the one running.
 */
describe("the CLAUDE.md index", () => {
  it("matches CLAUDE.md", () => {
    expect(() =>
      execFileSync("node", ["scripts/generate-section-index.mjs", "--check"], {
        cwd: process.cwd(),
        stdio: "pipe",
      })
    ).not.toThrow();
  });

  it("found the whole file, not a prefix of it", () => {
    // A parser that silently matched nothing would produce an empty pack and a
    // model with no product knowledge, which fails as a WORSE PROMPT rather
    // than as an error. Pin the shape so that failure is loud.
    expect(CLAUDE_SECTIONS.length).toBeGreaterThan(40);
    expect(CLAUDE_SECTIONS.at(-1)?.n).toBeGreaterThanOrEqual(46);
    expect(CLAUDE_SECTIONS.some((s) => s.migrations === "0133")).toBe(true);
  });

  it("carries §9 verbatim, including the invariant most likely to be 'fixed'", () => {
    // Invariant 4. A customer reporting "I was charged for a lead I rejected"
    // is describing correct behaviour, and this sentence is what stops it being
    // helpfully undone.
    expect(INVARIANTS).toContain("Reject does not refund");
    expect(INVARIANTS).toContain("lead_balance");
    expect(INVARIANTS.length).toBeGreaterThan(1000);
  });

  it("carries §11 and §12 as usable lines", () => {
    expect(KNOWN_ISSUES.length).toBeGreaterThan(3);
    expect(DEFERRED.length).toBeGreaterThan(3);
    for (const line of [...KNOWN_ISSUES, ...DEFERRED]) {
      expect(line).not.toContain("\n");
      expect(line.length).toBeGreaterThan(10);
    }
  });
});
