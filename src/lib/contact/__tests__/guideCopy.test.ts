/**
 * The two claims that must never reach a customer, pinned against the RENDERED
 * SOURCE rather than only the constants (§42).
 *
 * `contactStrategy.test.ts` already asserts them over the strategy module. That
 * is not enough on its own: the guide section is hand-written JSX around those
 * constants, so somebody could reintroduce an attendance figure — or attach a
 * percentage to the speed rule — in prose, and every existing test would still
 * pass. This reads the file.
 *
 * Why these two specifically:
 *
 *   1. NO ATTENDANCE OR SHOW-UP RATE. An "83% of booked meetings are attended"
 *      figure was measured and discarded: Calendly sends three reminders of its
 *      own before any meeting, so the number describes Calendly's dunning, not
 *      this strategy. Publishing it would promise an outcome we do not
 *      influence.
 *   2. NO PERCENTAGE ON SPEED. The speed rule stays because the business
 *      judgement is that speed matters, but the measurement is thin — the
 *      fastest-contacted leads included both wins and total failures. It is
 *      presented as how we expect leads to be worked, never as a finding, so it
 *      must not borrow the credibility of the figures that WERE measured.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ⚠️ Resolved from THIS FILE, not from process.cwd(). The suite runs inside the
// Vercel build (`vercel.json` gates `next build` on `vitest run`), and a test
// that reads a source file has no business assuming which directory the build
// invoked it from — a wrong cwd would throw ENOENT and fail the deploy for a
// reason that has nothing to do with the code under test.
const GUIDE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../app/dashboard/guide/page.tsx"
);

/** Just the contact-strategy section, so the rest of the guide is unaffected. */
function contactSection(): string {
  const src = readFileSync(GUIDE, "utf8");
  const start = src.indexOf('<Section id="contact"');
  expect(start, "the contact strategy section must exist in the guide").toBeGreaterThan(-1);
  const end = src.indexOf('<Section id=', start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("the guide's contact strategy section", () => {
  it("makes no attendance or show-up claim", () => {
    const copy = contactSection().toLowerCase();
    expect(copy).not.toMatch(/attend|show[- ]?up|turn(ed)? up|no[- ]?show/);
    expect(copy).not.toContain("83");
  });

  it("attaches NO percentage or deadline to speed", () => {
    const copy = contactSection();
    // The rule itself comes from the constant, which its own test pins as
    // digit-free. What this catches is prose around it — "contact within 2
    // hours", "40% more likely if you ring fast".
    expect(copy).not.toMatch(/within \d+\s*(hour|minute|day)/i);
    expect(copy).not.toMatch(/\d+\s*%[^.]{0,40}\b(fast|quick|speed|sooner|immediately)/i);
    expect(copy).not.toMatch(/\b(fast|quick|speed|sooner)[^.]{0,40}\d+\s*%/i);
  });

  it("caveats every measured figure it quotes", () => {
    const copy = contactSection().toLowerCase();
    // Each of the three findings is stated; none may stand as a promise.
    expect(copy).toContain("benchmark");
    expect(copy).toMatch(/not a (guarantee|promise)|rather than a promise/);
    expect(copy).toContain("one operator");
  });

  it("renders its figures FROM the strategy module, so they cannot drift", () => {
    const copy = contactSection();
    // Hard-coded numbers here would be a second source of truth.
    expect(copy).toContain("{RESPONDER_SHARE_BY_FIFTH_PCT}");
    expect(copy).toContain("{COLD_CALL_ANSWER_PCT}");
    expect(copy).toContain("{BOOKED_MEETING_RATE_PCT}");
    expect(copy).toContain("{SPEED_RULE}");
    expect(copy).toContain("CONTACT_ATTEMPTS.map");
  });

  it("says to stop at five and de-prioritise, never to discard", () => {
    const copy = contactSection().toLowerCase();
    expect(copy).toContain("de-prioritise");
    expect(copy).not.toMatch(/\bdiscard\b|\bdelete the lead\b/);
  });
});
