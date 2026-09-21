import { afterEach, describe, expect, it } from "vitest";
import { adsEnabledFor } from "../gate";
import type { Customer } from "@/lib/types";

/**
 * Who may reach the ad builder (§65).
 *
 * ⚠️ THE WHOLE FILE EXISTS FOR ONE LINE: which email the gate reads. A
 * mutation run proved nothing distinguished `user.email` from `customer.email`
 * — the guards asserted only that no route re-implements the check — and those
 * two are the SAME value everywhere except the one situation the choice was
 * made for.
 */

const owner = { email: "zac@stayful.co.uk" };
const other = { email: "someone@example.com" };
const row = (over: Record<string, unknown> = {}) =>
  ({ id: "c1", email: "someone@example.com", is_active: false, ...over }) as unknown as Customer;

afterEach(() => {
  delete process.env.OWNER_EMAILS;
});

describe("which identity decides", () => {
  /**
   * ⚠️ THE VIEW-AS CASE, AND IT IS THE ONLY ONE THAT SEPARATES THEM.
   * `VIEW_AS_MAX_AGE` is eight hours, and while that cookie is set
   * `getCurrentCustomer()` returns the VIEWED customer (§62) — so a
   * customer-keyed gate locks the owner out of their own ad builder, unable
   * even to read their own drafts, for eight hours after looking at somebody
   * else's account.
   */
  it("admits the owner while they are viewing another customer", () => {
    expect(adsEnabledFor(owner, row({ email: "a-customer@example.com" }))).toBe(true);
  });

  /**
   * And the mirror: a customer whose ROW happens to carry the owner address —
   * an archived duplicate, a hand-edited row — is not the owner. The
   * authenticated identity is the one that was proved.
   */
  it("refuses a customer row carrying the owner's address", () => {
    expect(adsEnabledFor(other, row({ email: "zac@stayful.co.uk" }))).toBe(false);
  });
});

describe("the ordinary cases", () => {
  it("admits the owner on their own row", () => {
    expect(adsEnabledFor(owner, row({ email: "zac@stayful.co.uk" }))).toBe(true);
  });

  it("refuses everybody else", () => {
    expect(adsEnabledFor(other, row())).toBe(false);
  });

  it("refuses a signed-out caller, and one with no customer row", () => {
    expect(adsEnabledFor(null, row())).toBe(false);
    expect(adsEnabledFor({ email: null }, row())).toBe(false);
    expect(adsEnabledFor(owner, null)).toBe(false);
  });

  it("follows OWNER_EMAILS, so letting a second customer in is one env var", () => {
    process.env.OWNER_EMAILS = "zac@stayful.co.uk,second@example.com";
    expect(adsEnabledFor({ email: "second@example.com" }, row())).toBe(true);
    expect(adsEnabledFor({ email: "third@example.com" }, row())).toBe(false);
  });

  it("is not fooled by case or whitespace", () => {
    expect(adsEnabledFor({ email: "  ZAC@Stayful.co.uk " }, row())).toBe(true);
  });
});

/**
 * ⚠️ DO NOT ADD AN `is_active` GUARD. §27.3 sets the precedent and the OAuth
 * routes enforce it — but the zac@stayful.co.uk row is `is_active = false`
 * (§18D, an archived duplicate), so following it here silently kills the demo
 * this whole build exists to be.
 */
describe("is_active", () => {
  it("is deliberately not consulted", () => {
    expect(adsEnabledFor(owner, row({ is_active: false }))).toBe(true);
    expect(adsEnabledFor(owner, row({ is_active: true }))).toBe(true);
  });
});
