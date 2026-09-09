/**
 * The inbound lead receiver (§48): the body mapping, the credential, and the
 * idempotency claim.
 *
 * ⚠️ WHAT THESE COVER, AND WHY THAT SET. The valuable cases here are the ones
 * where a mistake is SILENT. A body mapper that quietly accepted a column name
 * it should not, a claim that survives a failed create, a release that is not
 * called — none of those throws, and each produces a plausible-looking result
 * that is wrong. The arithmetic in this feature is trivial; the seams are not,
 * which is the lesson §23.10, §25, §27.8, §40.8 and §42.8 each record.
 *
 * The last block reads the ROUTE FILE'S OWN TEXT rather than a restatement of
 * it. §42.8 is why: a scratch test that hand-wrote its own equivalent of a
 * query asserted a query that was never running, and 91 sequence runs were
 * destroyed by the one it missed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LEAD_WEBHOOK_FIELDS,
  LEAD_WEBHOOK_PREFIX,
  generateLeadWebhookToken,
  hashLeadWebhookToken,
  leadWebhookUrl,
  toOwnedLeadInput,
} from "../leadWebhooks";
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  UNIQUE_VIOLATION,
  claimIdempotencyKey,
  releaseClaim,
  settleClaim,
} from "../idempotency";
import { hasAnyContactDetail } from "@/lib/customerLeads";
import { analysability } from "@/lib/leadAnalysis";

// ---------------------------------------------------------------------------
// 1 — The body mapping is a CLOSED set of named fields.
// ---------------------------------------------------------------------------
describe("toOwnedLeadInput", () => {
  it("takes the fields it names", () => {
    const out = toOwnedLeadInput({
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "07700 900123",
      address: "12 Gill Avenue, Bristol",
      postcode: "BS16 2PH",
      bedrooms: "3",
      profile: "Approved 8 Sep",
    });
    expect(out).toEqual({
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "07700 900123",
      address: "12 Gill Avenue, Bristol",
      postcode: "BS16 2PH",
      bedrooms: "3",
      profile: "Approved 8 Sep",
    });
  });

  it("⚠️ ignores every column name an automation might send that we do not accept", () => {
    // §27.1's standing rule from the other direction: a write endpoint that
    // forwarded its body into an insert would let a caller name our columns.
    // Each of these is a real column on `leads` or `lead_assignments`.
    const out = toOwnedLeadInput({
      phone: "07700 900123",
      owner_customer_id: "00000000-0000-0000-0000-000000000001",
      owner_source: "manual",
      max_assignments: 99,
      assignment_count: 0,
      price_paid: 0,
      gross_annual_income: 250000,
      lead_quality_override_note: "let it through",
      owner_resale_qualified_at: "2026-09-09T00:00:00Z",
      monday_item_id: "12345",
      lead_type: "guaranteed_rent",
      status: "won",
      id: "not-a-field",
    });
    expect(out).toEqual({ phone: "07700 900123" });
  });

  it("accepts the aliases a real automation sends, case- and spacing-insensitively", () => {
    const out = toOwnedLeadInput({
      "Full Name": "Jane Smith",
      "Mobile": "07700900123",
      "Property Address": "12 Gill Avenue",
      "Post Code": "BS16 2PH",
      "Beds": 3,
    });
    expect(out).toEqual({
      name: "Jane Smith",
      phone: "07700900123",
      address: "12 Gill Avenue",
      postcode: "BS16 2PH",
      bedrooms: "3",
    });
  });

  it("stores a number as its text, and refuses everything that is not a scalar", () => {
    // `String({})` is "[object Object]", which would be stored as an address.
    const out = toOwnedLeadInput({
      bedrooms: 3,
      address: { line1: "12 Gill Avenue" },
      name: ["Jane"],
      email: true,
      phone: null,
    });
    expect(out).toEqual({ bedrooms: "3" });
  });

  it("lets the exact field win over an alias, whatever the key order", () => {
    expect(toOwnedLeadInput({ full_name: "Alias", name: "Exact" }).name).toBe("Exact");
    expect(toOwnedLeadInput({ name: "Exact", full_name: "Alias" }).name).toBe("Exact");
  });

  it("survives a body that is not an object at all", () => {
    for (const body of [null, undefined, "a string", 42, [1, 2, 3]]) {
      expect(toOwnedLeadInput(body)).toEqual({});
    }
  });

  it("never advertises a field we derive rather than accept", () => {
    // `toRpcRow` also emits postcode_area. Offering it as an input would invite
    // somebody to send it, and it would be silently ignored.
    expect(LEAD_WEBHOOK_FIELDS).not.toContain("postcode_area");
  });
});

// ---------------------------------------------------------------------------
// 2 — Creation and analysis have DIFFERENT bars, which is the response's job.
// ---------------------------------------------------------------------------
describe("what a caller can create versus what we can analyse", () => {
  it("creates on a name alone and says the property cannot be analysed", () => {
    const input = toOwnedLeadInput({ name: "Jane Smith" });
    expect(hasAnyContactDetail(input)).toBe(true);
    expect(analysability({ address: null, postcode: null, bedrooms: null }).ok).toBe(false);
  });

  it("refuses a row that identifies and reaches nobody", () => {
    // A postcode and a bedroom count is a property, not a lead.
    const input = toOwnedLeadInput({ postcode: "BS16 2PH", bedrooms: "3" });
    expect(hasAnyContactDetail(input)).toBe(false);
  });

  it("reports no_postcode for an address-only lead rather than refusing it", () => {
    const input = toOwnedLeadInput({ name: "Jane", address: "12 Gill Avenue" });
    expect(hasAnyContactDetail(input)).toBe(true);
    const verdict = analysability({
      address: input.address,
      postcode: null,
      bedrooms: "3",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("no_postcode");
  });

  it("says ok when the analyser has everything it needs", () => {
    const verdict = analysability({
      address: "12 Gill Avenue, Bristol BS16 2PH",
      postcode: "BS16 2PH",
      bedrooms: "3",
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.code).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 3 — The credential.
// ---------------------------------------------------------------------------
describe("the webhook token", () => {
  it("is prefixed so it cannot be mistaken for an API key", () => {
    const { raw } = generateLeadWebhookToken();
    expect(raw.startsWith(LEAD_WEBHOOK_PREFIX)).toBe(true);
    expect(raw.startsWith("sfl_live_")).toBe(false);
  });

  it("mints a different token every time", () => {
    const seen = new Set(
      Array.from({ length: 50 }, () => generateLeadWebhookToken().raw)
    );
    expect(seen.size).toBe(50);
  });

  it("stores a hash, never the token", () => {
    const { raw, hash } = generateLeadWebhookToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(raw);
    expect(hashLeadWebhookToken(raw)).toBe(hash);
    expect(hashLeadWebhookToken(raw + "x")).not.toBe(hash);
  });

  it("builds one URL however the app URL is punctuated", () => {
    const raw = "sflw_abc";
    const expected = "https://leads.stayful.co.uk/api/webhook/customer-leads/sflw_abc";
    expect(leadWebhookUrl("https://leads.stayful.co.uk", raw)).toBe(expected);
    expect(leadWebhookUrl("https://leads.stayful.co.uk/", raw)).toBe(expected);
    expect(leadWebhookUrl("https://leads.stayful.co.uk///", raw)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 4 — Claim by INSERT, then act.
// ---------------------------------------------------------------------------
type Row = { id: string; lead_id: string | null; outcome: string | null };

/**
 * A fake that behaves like the unique index: the SECOND insert of a
 * (customer_id, idempotency_key) pair collides, and a read matches on BOTH
 * columns. A fake that ignored `customer_id` would pass the containment case
 * while the real thing let one customer replay another's claim.
 */
function fakeDb(seed: Array<Record<string, unknown>> = []) {
  const rows: Array<Record<string, unknown>> = [...seed];
  let nextId = 1;
  const calls: string[] = [];

  const client = {
    from(table: string) {
      calls.push(`from:${table}`);
      return {
        insert(values: Record<string, unknown>) {
          const clash = rows.find(
            (r) =>
              r.customer_id === values.customer_id &&
              r.idempotency_key === values.idempotency_key
          );
          return {
            select() {
              return {
                async maybeSingle() {
                  if (clash) {
                    return { data: null, error: { code: UNIQUE_VIOLATION, message: "dup" } };
                  }
                  const row = { id: `claim-${nextId++}`, lead_id: null, outcome: null, ...values };
                  rows.push(row);
                  return { data: { id: row.id }, error: null };
                },
              };
            },
          };
        },
        select() {
          const where: Record<string, unknown> = {};
          const q = {
            eq(column: string, value: unknown) {
              where[column] = value;
              return q;
            },
            async maybeSingle() {
              const found = rows.find((r) =>
                Object.entries(where).every(([k, v]) => r[k] === v)
              );
              return { data: found ?? null, error: null };
            },
          };
          return q;
        },
        update(values: Record<string, unknown>) {
          return {
            async eq(column: string, value: unknown) {
              const row = rows.find((r) => r[column] === value);
              if (row) Object.assign(row, values);
              return { error: null };
            },
          };
        },
        delete() {
          return {
            async eq(column: string, value: unknown) {
              const i = rows.findIndex((r) => r[column] === value);
              if (i >= 0) rows.splice(i, 1);
              return { error: null };
            },
          };
        },
      };
    },
  };

  return { client: client as never, rows, calls };
}

const CUSTOMER = "cust-1";
const OTHER = "cust-2";

describe("claimIdempotencyKey", () => {
  it("claims a key nobody holds", async () => {
    const db = fakeDb();
    const out = await claimIdempotencyKey<Row>(db.client, {
      surface: "customer_leads",
      customerId: CUSTOMER,
      key: "make-42",
      replayColumns: "id, lead_id, outcome",
    });
    expect(out.status).toBe("claimed");
    expect(db.rows).toHaveLength(1);
  });

  it("⚠️ writes to the claims table and nothing else", () => {
    // The surface is a closed union resolved inside the helper. A table name
    // arriving from a request would be §27.1 undone one layer down.
    const db = fakeDb();
    return claimIdempotencyKey(db.client, {
      surface: "customer_leads",
      customerId: CUSTOMER,
      key: "k",
      replayColumns: "id",
    }).then(() => {
      expect(new Set(db.calls)).toEqual(new Set(["from:customer_lead_webhook_claims"]));
    });
  });

  it("replays the winner's row on a second attempt with the same key", async () => {
    const db = fakeDb();
    const first = await claimIdempotencyKey<Row>(db.client, {
      surface: "customer_leads",
      customerId: CUSTOMER,
      key: "make-42",
      replayColumns: "id, lead_id, outcome",
    });
    if (first.status !== "claimed") throw new Error("expected a claim");
    await settleClaim(db.client, "customer_leads", first.claimId, {
      lead_id: "lead-1",
      outcome: "created",
    });

    const second = await claimIdempotencyKey<Row>(db.client, {
      surface: "customer_leads",
      customerId: CUSTOMER,
      key: "make-42",
      replayColumns: "id, lead_id, outcome",
    });
    expect(second.status).toBe("replay");
    if (second.status !== "replay") throw new Error("expected a replay");
    expect(second.row.lead_id).toBe("lead-1");
    expect(second.row.outcome).toBe("created");
    // One lead, not two.
    expect(db.rows).toHaveLength(1);
  });

  it("⚠️ keeps one customer's keys unreachable from another's", async () => {
    // The unique index LEADS ON customer_id (0116's containment guarantee), so
    // the same key from a different customer is a different claim.
    const db = fakeDb();
    await claimIdempotencyKey(db.client, {
      surface: "customer_leads",
      customerId: CUSTOMER,
      key: "record-1",
      replayColumns: "id",
    });
    const theirs = await claimIdempotencyKey(db.client, {
      surface: "customer_leads",
      customerId: OTHER,
      key: "record-1",
      replayColumns: "id",
    });
    expect(theirs.status).toBe("claimed");
    expect(db.rows).toHaveLength(2);
  });

  it("⚠️ releasing a claim lets the retry actually create", async () => {
    // A claim left behind by a failed create poisons that key for ever: every
    // retry finds it, replays a success, and reports a lead that never existed.
    const db = fakeDb();
    const first = await claimIdempotencyKey(db.client, {
      surface: "customer_leads",
      customerId: CUSTOMER,
      key: "make-42",
      replayColumns: "id",
    });
    if (first.status !== "claimed") throw new Error("expected a claim");

    await releaseClaim(db.client, "customer_leads", first.claimId);
    expect(db.rows).toHaveLength(0);

    const retry = await claimIdempotencyKey(db.client, {
      surface: "customer_leads",
      customerId: CUSTOMER,
      key: "make-42",
      replayColumns: "id",
    });
    expect(retry.status).toBe("claimed");
  });

  it("reports an error rather than acting when the database cannot be reached", async () => {
    const broken = {
      from: () => ({
        insert: () => ({
          select: () => ({
            async maybeSingle() {
              return { data: null, error: { code: "08006", message: "connection failed" } };
            },
          }),
        }),
      }),
    } as never;
    const out = await claimIdempotencyKey(broken, {
      surface: "customer_leads",
      customerId: CUSTOMER,
      key: "k",
      replayColumns: "id",
    });
    expect(out.status).toBe("error");
  });

  it("bounds the key at the length the CHECK allows", () => {
    expect(MAX_IDEMPOTENCY_KEY_LENGTH).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5 — Guards anchored on the ROUTE FILE'S OWN TEXT (§42.8).
// ---------------------------------------------------------------------------
describe("the receiver's route file", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/app/api/webhook/customer-leads/[token]/route.ts"),
    "utf8"
  );
  // The prose explains what the route must not do, and naming the forbidden
  // things is how it explains them. Matching against the comments would pass
  // whatever the code did — and would teach the next person to delete the
  // explanation to get their change through.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("⚠️ never reaches the analysis charge path", () => {
    // The £3 purchase is what makes an unattended URL-borne token dangerous.
    expect(code).not.toContain("lead-analysis");
    expect(code).not.toContain("run_analysis");
    expect(code).not.toContain("startAnalysis");
    // And it must not forward a credential to make one work.
    expect(code).not.toMatch(/headers\.get\(\s*["']cookie["']\s*\)/);
  });

  it("requires an Idempotency-Key", () => {
    expect(code).toMatch(/headers\.get\(\s*["']idempotency-key["']\s*\)/);
    expect(code).toContain("idempotency_key_required");
  });

  it("releases the claim when creation fails", () => {
    expect(code).toMatch(/releaseClaim\(\s*admin,\s*"customer_leads",\s*claim\.claimId\s*\)/);
  });

  it("matches the token by hash and never by the raw value", () => {
    expect(code).toMatch(/\.eq\(\s*"token_hash",\s*hashLeadWebhookToken\(params\.token\)\s*\)/);
    expect(code).not.toMatch(/\.eq\(\s*"token",/);
  });

  it("creates through the shared path, with the webhook source", () => {
    expect(code).toContain("createOwnedLeads");
    expect(code).toContain('source: "webhook"');
    // No second creation implementation: nothing here touches leads directly.
    expect(code).not.toMatch(/from\(\s*"leads"\s*\)\s*\.insert/);
  });
});
