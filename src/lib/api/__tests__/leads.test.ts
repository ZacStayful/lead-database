/**
 * listAssignments query construction.
 *
 * These assert what the query BUILDER does rather than what the database
 * returns, because the bug they guard against — a `?product=` filter that does
 * not filter — is invisible at the TypeScript level and only shows up in the
 * shape of the PostgREST request.
 */
import { describe, expect, it, vi } from "vitest";
import { listAssignments } from "@/lib/api/service/leads";
import type { Caller } from "@/lib/api/caller";

const caller: Caller = {
  customerId: "customer-1",
  customer: {} as never,
  via: "api_key",
  scopes: ["profile:read", "leads:read"],
  keyId: "key-1",
  minuteCount: 1,
};

/** Records every filter the service applies, then returns an empty page. */
function recordingAdmin() {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "gte", "or"]) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }
  // Awaiting the builder resolves to the result.
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve({ data: [], error: null });
  return {
    calls,
    admin: { from: () => chain } as never,
  };
}

describe("product filter", () => {
  it("is applied to the query, scoped to the customer", async () => {
    const { calls, admin } = recordingAdmin();
    const result = await listAssignments(caller, { product: "management" }, admin);

    expect(result.ok).toBe(true);
    const eqs = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["lead.lead_type", "management"]);
    // Every query is scoped by the caller's own id, resolved server-side.
    expect(eqs).toContainEqual(["customer_id", "customer-1"]);
  });

  it("selects through an inner join so the filter removes parent rows", async () => {
    const { calls, admin } = recordingAdmin();
    await listAssignments(caller, { product: "guaranteed_rent" }, admin);
    const select = String(calls.find((c) => c.method === "select")?.args[0] ?? "");
    expect(select).toContain("lead:leads!inner(");
  });

  it("refuses an unknown product rather than ignoring it", async () => {
    const { admin } = recordingAdmin();
    const result = await listAssignments(caller, { product: "commercial" }, admin);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_request");
  });
});

describe("validation refuses rather than ignores", () => {
  it("rejects a bad status, stage, limit, date and cursor", async () => {
    const { admin } = recordingAdmin();
    for (const params of [
      { status: "nonsense" },
      { pipeline_stage: "nonsense" },
      { limit: "0" },
      { limit: "1000" },
      { limit: "abc" },
      { updated_since: "yesterday" },
      { cursor: "not-a-cursor" },
      { sort: "price_paid" },
    ]) {
      const result = await listAssignments(caller, params, admin);
      expect(result.ok, JSON.stringify(params)).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_request");
    }
  });
});
