import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two short-circuits in syncCustomerMondayStatus must consult the lead
 * interest, not just the label.
 *
 * ⚠️ THIS IS A SOURCE ASSERTION ON PURPOSE. §42.8 records what the alternative
 * cost: a "safety boundary" that the pull request asserted in words, that a
 * scratch test checked by hand-writing an equivalent query, and that did not
 * exist — 91 follow-up runs were destroyed within six minutes of deploy. A test
 * that writes its own copy of the code is not testing the code.
 *
 * What it protects: a customer holding management who then also buys GR keeps
 * the label `Management Customer` (label rule 4 — management wins). So
 * labelUnchanged is true, and a fast path that reads only the label returns
 * before Monday is touched at all. The cell would never flip to "Both", the
 * board would look right, and nothing would ever say otherwise.
 *
 * Deleting `interestUnchanged &&` from either guard is a one-token change that
 * no behavioural test in this repo would catch, because it needs a real Monday
 * item to observe.
 */
const SOURCE = readFileSync(join(__dirname, "../mondayStatus.ts"), "utf8");

describe("syncCustomerMondayStatus's short-circuits", () => {
  it("derives the interest before the first fast path can return", () => {
    const derived = SOURCE.indexOf("const interestUnchanged =");
    const firstGuard = SOURCE.indexOf("opts?.endDate === undefined");
    expect(derived).toBeGreaterThan(-1);
    expect(firstGuard).toBeGreaterThan(-1);
    expect(derived).toBeLessThan(firstGuard);
  });

  it("consults it in the no-date fast path", () => {
    expect(SOURCE).toContain(
      "if (labelUnchanged && interestUnchanged && opts?.endDate === undefined)"
    );
  });

  it("consults it in the date-instruction fast path too", () => {
    // The second guard runs after the item has been read, and skipping it there
    // would lose the same transition on every subscription event that carries a
    // date instruction.
    expect(SOURCE).toMatch(
      /labelUnchanged &&\s*interestUnchanged &&\s*!endDateNeedsWrite\(/
    );
  });

  it("passes the interest to the write", () => {
    expect(SOURCE).toContain("leadInterest: interest ?? undefined");
  });

  it("never clears the cache on a null verdict", () => {
    // `??`, not a bare assignment: a null verdict wrote nothing to the cell, so
    // it must not erase our record of what is in it either.
    expect(SOURCE).toContain(
      "monday_lead_interest: interest ?? row.monday_lead_interest"
    );
  });
});
