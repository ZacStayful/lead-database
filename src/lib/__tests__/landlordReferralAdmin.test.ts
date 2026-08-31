import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MESSAGING_SETTINGS } from "@/lib/messaging/adminSettings";

const TEST_ROUTE = "src/app/api/admin/landlord-referral/test/route.ts";
const SWITCH_ROUTE = "src/app/api/admin/settings/landlord-referral/route.ts";
const read = (p: string) => readFileSync(p, "utf8");

/**
 * Source with comments stripped.
 *
 * ⚠️ These assertions are about CODE, not prose. The test route's own header
 * says in terms that it never calls claim_landlord_referral — documenting the
 * guarantee is the point of it — and a naive substring check reads that
 * sentence as a violation of the thing it promises.
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the landlord referral kill switch", () => {
  // §41 is downstream of completeAssignment, not §40 messaging. Adding it to
  // MESSAGING_SETTINGS would give it an error string reading "That is not a
  // messaging setting" and four literal lists to keep in sync.
  it("is NOT in the messaging allow-list", () => {
    expect(MESSAGING_SETTINGS.map((s) => s.key)).not.toContain(
      "landlord_referral_enabled"
    );
  });

  it("has its own route, gated on isAdminUser with a 403", () => {
    const src = read(SWITCH_ROUTE);
    expect(src).toContain("isAdminUser");
    expect(src).toContain('status: 403');
  });

  // `Number(true)` is 1 and `Number(null)` is 0, so a loose check is how a
  // boolean setting quietly stores something that is not one.
  it("checks the type strictly rather than coercing", () => {
    expect(read(SWITCH_ROUTE)).toContain('typeof body.enabled !== "boolean"');
  });

  // system_settings also holds escalation_enabled, pool_enabled and
  // max_active_customers. A route that upserts a key from the body can stop
  // lead allocation for the whole platform (§16).
  it("writes a CONSTANT key, never one taken from the request body", () => {
    const src = code(SWITCH_ROUTE);
    expect(src).toContain('const KEY = "landlord_referral_enabled"');
    expect(src).toContain("key: KEY");
    expect(src).not.toMatch(/key:\s*body\./);
  });

  // An update against an unseeded key matches zero rows and still reports
  // success (§16).
  it("upserts rather than updates", () => {
    const src = code(SWITCH_ROUTE);
    expect(src).toContain(".upsert(");
    expect(src).not.toContain(".update(");
  });
});

describe("the test send", () => {
  // THE ASSERTION THAT MATTERS MOST. A referral is claimed by write BEFORE it
  // is sent, and the claim decides who carries the three questions — so a
  // rehearsal that claimed would burn a real lead's one-and-only introduction
  // slot on an email that went to us.
  it("writes NOTHING — no update, upsert, insert, delete or rpc", () => {
    const src = code(TEST_ROUTE);
    for (const write of [".update(", ".upsert(", ".insert(", ".delete(", ".rpc("]) {
      expect(src, `test route must not call ${write}`).not.toContain(write);
    }
    expect(src).not.toContain("claim_landlord_referral");
  });

  // The entire point of a rehearsal is to decide whether to turn the thing on.
  it("does NOT consult the kill switch", () => {
    expect(code(TEST_ROUTE)).not.toContain("landlordReferralEnabled");
  });

  it("prefixes the subject and defaults to the admin's own address", () => {
    const src = read(TEST_ROUTE);
    expect(src).toContain("[TEST]");
    expect(src).toContain("user?.email");
  });

  it("is admin-gated and reports a failed send as 502, like the announcement test", () => {
    const src = read(TEST_ROUTE);
    expect(src).toContain("isAdminUser");
    expect(src).toContain("status: 502");
  });

  // It refuses the same leads a real send would, rather than sending something
  // the live path never would.
  it("applies the same shouldReferLandlord refusal", () => {
    expect(read(TEST_ROUTE)).toContain("shouldReferLandlord");
  });
});

describe("the landlord page and its write-back agree", () => {
  // Relaxed together: the test send stamps nothing, so requiring the referral
  // flag would render the deck and then 404 on the first answer.
  it("neither requires landlord_referral_first_sent_at to be set", () => {
    for (const p of [
      "src/app/p/[token]/page.tsx",
      "src/app/api/public/lead-preferences/route.ts",
    ]) {
      expect(code(p), p).not.toMatch(/!\w+\.landlord_referral_first_sent_at/);
    }
  });
});
