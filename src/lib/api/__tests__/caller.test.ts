/**
 * The resolver, against a stubbed admin client.
 *
 * The cases that matter most are the ones where the WRONG answer still looks
 * like a working system: a revoked key that resolves, or a bad key that quietly
 * falls back to the caller's cookie session and returns their data anyway.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { generateApiKey } from "@/lib/api/keys";
import { RATE_LIMIT_PER_MINUTE } from "@/lib/api/limits";

const getCurrentCustomer = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ getCurrentCustomer }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => stub }));

import { resetKillSwitchCache, resolveCaller } from "@/lib/api/caller";

const CUSTOMER = {
  id: "customer-1",
  business_name: "Test Lettings",
  contact_name: "Sam",
  email: "sam@example.com",
  is_active: true,
};

interface StubState {
  apiEnabled: string;
  keyRow: Record<string, unknown> | null;
  keyError: unknown;
  rpcError: unknown;
  minuteCount: number;
  dayCount: number;
  updates: number;
}

let state: StubState;

/** Minimal stand-in for the pieces of the Supabase client the resolver uses. */
const stub = {
  from(table: string) {
    if (table === "system_settings") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { value: state.apiEnabled }, error: null }) }),
        }),
      };
    }
    if (table === "customer_api_keys") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.keyRow, error: state.keyError }) }),
        }),
        update: () => ({ eq: () => ({ or: async () => { state.updates += 1; return { error: null }; } }) }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  },
  async rpc() {
    if (state.rpcError) return { data: null, error: state.rpcError };
    return {
      data: [{ minute_count: state.minuteCount, day_count: state.dayCount }],
      error: null,
    };
  },
};

function req(headers: Record<string, string> = {}) {
  return new NextRequest("https://leads.stayful.co.uk/api/v1/me", { headers });
}

function keyRowFor(hash: string, over: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    customer_id: CUSTOMER.id,
    key_hash: hash,
    scopes: ["profile:read", "leads:read"],
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    customers: CUSTOMER,
    ...over,
  };
}

beforeEach(() => {
  resetKillSwitchCache();
  getCurrentCustomer.mockReset();
  state = {
    apiEnabled: "true",
    keyRow: null,
    keyError: null,
    rpcError: null,
    minuteCount: 1,
    dayCount: 1,
    updates: 0,
  };
});

describe("api key path", () => {
  it("resolves a valid key", async () => {
    const { raw, hash } = generateApiKey();
    state.keyRow = keyRowFor(hash);

    const result = await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.caller.customerId).toBe(CUSTOMER.id);
      expect(result.caller.via).toBe("api_key");
      expect(result.caller.keyId).toBe("key-1");
    }
  });

  it("refuses a revoked key with its own code", async () => {
    const { raw, hash } = generateApiKey();
    state.keyRow = keyRowFor(hash, { revoked_at: "2026-08-01T00:00:00Z" });

    const result = await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("revoked_api_key");
  });

  it("refuses an expired key distinctly from an invalid one", async () => {
    const { raw, hash } = generateApiKey();
    state.keyRow = keyRowFor(hash, { expires_at: "2026-01-01T00:00:00Z" });

    const result = await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("expired_api_key");
  });

  it("refuses the right prefix with the wrong secret", async () => {
    const real = generateApiKey();
    const other = generateApiKey();
    // Same row comes back (prefix lookup hit), but the hash belongs elsewhere.
    state.keyRow = keyRowFor(other.hash);

    const result = await resolveCaller(req({ authorization: `Bearer ${real.raw}` }), { admin: stub as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_api_key");
  });

  it("refuses an unknown prefix", async () => {
    const { raw } = generateApiKey();
    state.keyRow = null;
    const result = await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_api_key");
  });

  it("refuses a key on an archived customer", async () => {
    // is_active = false means the row was superseded by a duplicate signup and
    // should be out of circulation entirely. A CANCELLED customer is a
    // different thing and deliberately keeps working keys.
    const { raw, hash } = generateApiKey();
    state.keyRow = keyRowFor(hash, { customers: { ...CUSTOMER, is_active: false } });

    const result = await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_api_key");
  });

  it("keeps working for a cancelled customer", async () => {
    const { raw, hash } = generateApiKey();
    state.keyRow = keyRowFor(hash, {
      customers: { ...CUSTOMER, account_status: "cancelled", subscription_status: "canceled" },
    });

    const result = await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(result.ok).toBe(true);
  });
});

describe("the key path is terminal", () => {
  it("does not fall back to the session when the key is bad", async () => {
    // The failure this exists to prevent: a customer testing a key while logged
    // in would otherwise be served their SESSION'S data and conclude the key
    // works — including a key they had just revoked.
    getCurrentCustomer.mockResolvedValue({ user: {}, customer: CUSTOMER });
    state.keyRow = null;

    const result = await resolveCaller(
      req({ authorization: `Bearer ${generateApiKey().raw}` }),
      { admin: stub as never }
    );
    expect(result.ok).toBe(false);
    expect(getCurrentCustomer).not.toHaveBeenCalled();
  });

  it("treats a non-Bearer Authorization header as an explicit credential", async () => {
    getCurrentCustomer.mockResolvedValue({ user: {}, customer: CUSTOMER });
    const result = await resolveCaller(req({ authorization: "Basic abc123" }), { admin: stub as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_api_key");
    expect(getCurrentCustomer).not.toHaveBeenCalled();
  });

  it("wins over a session when both are present", async () => {
    getCurrentCustomer.mockResolvedValue({ user: {}, customer: { ...CUSTOMER, id: "other" } });
    const { raw, hash } = generateApiKey();
    state.keyRow = keyRowFor(hash);

    const result = await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.caller.via).toBe("api_key");
      expect(result.caller.customerId).toBe(CUSTOMER.id);
    }
  });
});

describe("session path", () => {
  it("resolves a signed-in customer with every scope and no key", async () => {
    getCurrentCustomer.mockResolvedValue({ user: {}, customer: CUSTOMER });
    const result = await resolveCaller(req(), { admin: stub as never });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.caller.via).toBe("session");
      expect(result.caller.keyId).toBeNull();
      expect(result.caller.scopes).toContain("leads:read");
    }
  });

  it("refuses when nobody is signed in", async () => {
    getCurrentCustomer.mockResolvedValue({ user: null, customer: null });
    const result = await resolveCaller(req(), { admin: stub as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthorized");
  });

  it("is refused outright on a key-only surface", async () => {
    // /api/mcp passes allow: ["api_key"]. A cookie-bearing browser can POST
    // JSON cross-origin, so a JSON-RPC endpoint must not honour ambient
    // credentials.
    getCurrentCustomer.mockResolvedValue({ user: {}, customer: CUSTOMER });
    const result = await resolveCaller(req(), { allow: ["api_key"], admin: stub as never });
    expect(result.ok).toBe(false);
    expect(getCurrentCustomer).not.toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("refuses once the minute window is exceeded", async () => {
    const { raw, hash } = generateApiKey();
    state.keyRow = keyRowFor(hash);
    state.minuteCount = RATE_LIMIT_PER_MINUTE + 1;

    const result = await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rate_limited");
  });

  it("FAILS CLOSED when the limiter itself errors", async () => {
    // Letting the request through here would turn the only defence against a
    // runaway integration into a no-op at exactly the moment it is under load.
    const { raw, hash } = generateApiKey();
    state.keyRow = keyRowFor(hash);
    state.rpcError = { message: "connection reset" };

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rate_limited");
    spy.mockRestore();
  });
});

describe("last_used_at coalescing", () => {
  it("writes when never used, and not again straight away", async () => {
    const { raw, hash } = generateApiKey();
    state.keyRow = keyRowFor(hash, { last_used_at: null });
    await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(state.updates).toBe(1);

    state.keyRow = keyRowFor(hash, { last_used_at: new Date().toISOString() });
    await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(state.updates).toBe(1);
  });
});

describe("kill switch", () => {
  it("turns the whole surface off for both credential kinds", async () => {
    state.apiEnabled = "false";
    const { raw, hash } = generateApiKey();
    state.keyRow = keyRowFor(hash);
    getCurrentCustomer.mockResolvedValue({ user: {}, customer: CUSTOMER });

    const viaKey = await resolveCaller(req({ authorization: `Bearer ${raw}` }), { admin: stub as never });
    expect(viaKey.ok).toBe(false);
    if (!viaKey.ok) expect(viaKey.code).toBe("service_unavailable");

    resetKillSwitchCache();
    const viaSession = await resolveCaller(req(), { admin: stub as never });
    expect(viaSession.ok).toBe(false);
    if (!viaSession.ok) expect(viaSession.code).toBe("service_unavailable");
  });
});
