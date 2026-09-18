/**
 * The pure halves of admin view-as (§62): the middleware's decision and the
 * identity resolver. Everything with a request or a database around it is
 * pinned by viewAsGuards.test.ts on the real files instead.
 */
import { describe, expect, it, afterEach } from "vitest";
import type { User } from "@supabase/supabase-js";
import {
  READ_ONLY_CODE,
  VIEW_AS_MAX_AGE_SECONDS,
  isViewAsId,
  viewAsCookieOptions,
  viewAsRefusal,
} from "../viewAs";
import { resolveViewAs, withoutAdminClaim } from "../auth";

const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function user(role?: string): User {
  return {
    id: "u1",
    app_metadata: role ? { role, provider: "email" } : { provider: "email" },
    user_metadata: {},
    aud: "authenticated",
    created_at: "",
  } as unknown as User;
}

describe("viewAsRefusal — the middleware's whole decision", () => {
  it("never refuses without the cookie, whatever the method", () => {
    for (const m of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
      expect(viewAsRefusal(m, "/api/customer/notes", false)).toBeNull();
    }
  });

  it("never refuses a safe method", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(viewAsRefusal(m, "/api/customer/notes", true)).toBeNull();
    }
  });

  it("refuses every mutating method with the cookie present", () => {
    for (const m of ["POST", "PATCH", "PUT", "DELETE", "post"]) {
      const r = viewAsRefusal(m, "/api/customer/notes", true);
      expect(r?.status).toBe(403);
      expect(r?.body.code).toBe(READ_ONLY_CODE);
      expect(r?.body.error).toMatch(/read-only/);
    }
  });

  it("covers billing, leads, feedback and the public forms alike", () => {
    for (const p of [
      "/api/billing/portal",
      "/api/customer/subscribe",
      "/api/leads/abc/reject",
      "/api/customer/events",
      "/api/feedback",
      "/api/enquiry",
      "/api/oauth/authorize",
    ]) {
      expect(viewAsRefusal("POST", p, true)?.status, p).toBe(403);
    }
  });

  it("leaves /api/admin/* writable, so Exit and the admin screens keep working", () => {
    expect(viewAsRefusal("DELETE", "/api/admin/view-as", true)).toBeNull();
    expect(viewAsRefusal("POST", "/api/admin/customers/x/invite", true)).toBeNull();
    // A prefix is not the admin namespace.
    expect(viewAsRefusal("POST", "/api/administer", true)?.status).toBe(403);
  });
});

describe("the cookie", () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = env;
  });

  it("is HttpOnly, site-wide, lax, and expires within a working day", () => {
    const o = viewAsCookieOptions();
    expect(o.httpOnly).toBe(true);
    expect(o.path).toBe("/");
    expect(o.sameSite).toBe("lax");
    expect(o.maxAge).toBe(VIEW_AS_MAX_AGE_SECONDS);
    expect(VIEW_AS_MAX_AGE_SECONDS).toBe(8 * 60 * 60);
  });

  it("is Secure in production only", () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    expect(viewAsCookieOptions().secure).toBe(true);
    (process.env as { NODE_ENV?: string }).NODE_ENV = "test";
    expect(viewAsCookieOptions().secure).toBe(false);
  });

  it("accepts only a uuid — the value reaches a service-role .eq('id', …)", () => {
    expect(isViewAsId(ID)).toBe(true);
    expect(isViewAsId(ID.toUpperCase())).toBe(true);
    for (const bad of ["", "abc", `${ID} `, "null", "*", undefined, null, "1 or 1=1"]) {
      expect(isViewAsId(bad), String(bad)).toBe(false);
    }
  });
});

describe("resolveViewAs — honoured for an admin only", () => {
  it("returns the id for an admin carrying a uuid", () => {
    expect(resolveViewAs(user("admin"), ID)).toBe(ID);
  });

  it("returns null for a non-admin, a signed-out user, or a bad value", () => {
    expect(resolveViewAs(user(), ID)).toBeNull();
    expect(resolveViewAs(null, ID)).toBeNull();
    expect(resolveViewAs(user("admin"), "not-a-uuid")).toBeNull();
    expect(resolveViewAs(user("admin"), undefined)).toBeNull();
  });

  it("ignores a role claimed in user_metadata, which the browser can edit", () => {
    const u = { ...user(), user_metadata: { role: "admin" } } as User;
    expect(resolveViewAs(u, ID)).toBeNull();
  });
});

describe("withoutAdminClaim — what the customer's view is built on", () => {
  it("drops the admin role and keeps everything else", () => {
    const real = user("admin");
    const seen = withoutAdminClaim(real);
    expect(seen.app_metadata.role).toBeUndefined();
    expect(seen.app_metadata.provider).toBe("email");
    expect(seen.id).toBe("u1");
  });

  it("never mutates the real user", () => {
    const real = user("admin");
    withoutAdminClaim(real);
    expect(real.app_metadata.role).toBe("admin");
  });
});
