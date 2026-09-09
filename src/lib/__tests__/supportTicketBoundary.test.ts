import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠️ THE NOTES BOUNDARY, PINNED AGAINST THE REAL FILES.
 *
 * §46.3's claim is that a customer cannot reach `support_ticket_notes` because
 * the customer read names a fixed column list on one table and never mentions
 * the other. Both reads run on the SERVICE ROLE, so RLS is not enforcing this —
 * the file's own text is.
 *
 * §42.8 is why these assertions read the real source rather than restating the
 * query: a test that hand-writes its own copy of a query asserts a query that
 * was never the one running. There, a scratch seam test checked a hand-written
 * equivalent and 91 sequence runs were destroyed by the query that actually
 * shipped.
 */
/**
 * Comments are stripped before asserting. The page's own docblock explains the
 * boundary and therefore names `support_ticket_notes` and `select("*")` — a
 * naive substring check fails on the explanation rather than on the code, which
 * would train the next person to delete the explanation.
 */
function code(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const CUSTOMER_PAGE = code("src/app/dashboard/support/page.tsx");

describe("the customer's own ticket list", () => {
  it("NEVER mentions the notes table", () => {
    expect(CUSTOMER_PAGE).not.toContain("support_ticket_notes");
  });

  it("never selects everything", () => {
    // select("*") is what a jsonb notes column would have shipped, and it is
    // what getCurrentCustomer() does on `customers`, so the habit is right
    // there in the same file's imports.
    expect(CUSTOMER_PAGE).not.toContain('select("*")');
  });

  it("selects exactly the six columns a customer may see", () => {
    const match = CUSTOMER_PAGE.match(
      /const CUSTOMER_TICKET_COLUMNS =\s*([\s\S]*?);/
    );
    expect(match).not.toBeNull();
    const columns = Array.from(match![1].matchAll(/[a-z_]+/g))
      .map((m) => m[0])
      .filter((c) => c !== "reference" || true);
    expect(columns).toEqual([
      "reference",
      "kind",
      "status",
      "subject",
      "submitted_at",
      "resolved_at",
    ]);
  });

  it("filters to this customer AND to what we chose to share", () => {
    expect(CUSTOMER_PAGE).toContain('.eq("customer_id", customer.id)');
    expect(CUSTOMER_PAGE).toContain('.eq("visible_to_customer", true)');
  });

  it("exposes none of the admin working fields", () => {
    for (const field of [
      "plan_snapshot",
      "shipped_migration",
      "shipped_claude_section",
      "backfill_key",
      "submitter_email",
      "page",
    ]) {
      const match = CUSTOMER_PAGE.match(
        /const CUSTOMER_TICKET_COLUMNS =\s*([\s\S]*?);/
      );
      expect(match![1], `${field} must not be selected`).not.toContain(field);
    }
  });
});

describe("the notes route is append-only", () => {
  const NOTES_ROUTE = code(
    "src/app/api/admin/support-tickets/[id]/notes/route.ts"
  );

  it("exports no PATCH, PUT or DELETE handler", () => {
    // Append-only is enforced by the absence of a route (the lead_events
    // posture), so Next answers 405 for free. Adding one would be the change
    // that quietly makes the log book editable.
    expect(NOTES_ROUTE).not.toMatch(/export async function (PATCH|PUT|DELETE)/);
    expect(NOTES_ROUTE).toMatch(/export async function POST/);
  });

  it("takes the author from the session, never the body", () => {
    expect(NOTES_ROUTE).toContain("user?.email");
    expect(NOTES_ROUTE).not.toMatch(/body\.author_email|author_email:\s*b\./);
  });
});
