import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural assertions on 0125, following the readFileSync precedent in
 * cancelOptions.test.ts.
 *
 * These are the three properties of the migration that are load-bearing and
 * that nothing else can check: get any of them wrong and the failure is silent
 * — a duplicate email, or a decline table readable from a browser.
 */
const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0125_card_decline_events.sql"),
  "utf8"
);

describe("0125_card_decline_events.sql", () => {
  /**
   * The claim key. Without it, one webhook retry after a throw equals a second
   * decline email — and the outer catch deletes the stripe_events claim on any
   * throw, so retries are routine rather than theoretical.
   */
  it("declares the unique index on (stripe_invoice_id, attempt_count)", () => {
    expect(SQL).toMatch(
      /create unique index[\s\S]*?card_decline_events\s*\(\s*stripe_invoice_id\s*,\s*attempt_count\s*\)/i
    );
  });

  /**
   * A unique index treats NULLs as distinct, so a nullable half silently
   * disables the guard above.
   */
  it("makes both halves of the claim key NOT NULL", () => {
    expect(SQL).toMatch(/stripe_invoice_id\s+text\s+not null/i);
    expect(SQL).toMatch(/attempt_count\s+integer\s+not null/i);
  });

  /** Invariant 7, made mechanical: RLS on, deny-all to the browser. */
  it("enables RLS and defines no policy", () => {
    expect(SQL).toMatch(
      /alter table public\.card_decline_events enable row level security/i
    );
    expect(SQL).not.toMatch(/create policy/i);
  });

  /**
   * A CHECK here would be read as "already sent" by the claim-then-send path:
   * at the call site a 23514 is indistinguishable from the 23505 that means
   * another delivery handled it, so one forgotten key in a SQL list would mean
   * no email ever sent for that decline code.
   */
  it("leaves reason_key unconstrained on purpose", () => {
    expect(SQL).not.toMatch(/check\s*\(\s*reason_key/i);
  });

  it("cascades from customers", () => {
    expect(SQL).toMatch(
      /customer_id\s+uuid not null references public\.customers\(id\) on delete cascade/i
    );
  });

  it("constrains lead_type to the two products", () => {
    expect(SQL).toMatch(/lead_type in \('management', 'guaranteed_rent'\)/i);
  });
});
