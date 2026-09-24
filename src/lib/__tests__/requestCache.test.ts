import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requestCache, REQUEST_CACHE_IS_REAL } from "@/lib/requestCache";

/**
 * The fix for a signed-in customer being bounced to /login at random.
 *
 * dashboard/layout.tsx and dashboard/page.tsx both call getCurrentCustomer(),
 * and Next renders a layout and its page concurrently — so without per-request
 * memoisation both redeem the same refresh token and the loser comes back
 * `refresh_token_already_used`. Production carried that on /dashboard as late
 * as 2026-09-22.
 *
 * The behavioural half cannot be tested here (vitest has no RSC request
 * scope), so the guards below assert the WIRING on the real source file. That
 * is the regression that can actually happen: someone unwraps the call.
 */

const src = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8");

/** Comments stripped, whitespace collapsed — §51.11: Prettier wraps, and a raw
 *  substring check passes on a wrapped phrase or fails on an explanation. */
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/\s+/g, " ");
}

describe("requestCache", () => {
  it("is callable and preserves the wrapped function's result", async () => {
    const wrapped = requestCache(async () => 42 as const);
    await expect(wrapped()).resolves.toBe(42);
  });

  it("passes arguments through untouched", async () => {
    const wrapped = requestCache(async (a: never, b: never) => [a, b]);
    await expect(
      (wrapped as unknown as (a: number, b: string) => Promise<unknown[]>)(1, "x")
    ).resolves.toEqual([1, "x"]);
  });

  it("reports that it is a PASS-THROUGH under vitest, not the real thing", () => {
    // React exports `cache` only under the "react-server" condition. Under
    // vitest `react` resolves to the stock client build, which does not have
    // it. Asserted rather than assumed so a pass-through can never be
    // mistaken for the memoisation working.
    expect(REQUEST_CACHE_IS_REAL).toBe(false);
  });

  it("never throws at import time", async () => {
    await expect(import("@/lib/requestCache")).resolves.toBeTruthy();
  });
});

describe("auth.ts wiring (the guard that matters)", () => {
  it("memoises getUser", () => {
    expect(code("lib/auth.ts")).toContain(
      "export const getUser = requestCache(async function getUser"
    );
  });

  it("memoises getCurrentCustomer", () => {
    expect(code("lib/auth.ts")).toContain(
      "export const getCurrentCustomer = requestCache(async function getCurrentCustomer"
    );
  });

  it("does not import `cache` straight from react", () => {
    // Stock React 18.3.1's shared-subset entry throws "not yet supported
    // outside of experimental channels", so a direct import breaks every test
    // file that imports auth.ts.
    expect(code("lib/auth.ts")).not.toContain('from "react"');
  });

  it("still returns null for an auth error rather than throwing", () => {
    // The catch is not replaced by the memoisation — it is what turns a genuinely
    // stale cookie into "signed out" instead of a 500.
    expect(code("lib/auth.ts")).toContain("__isAuthError");
  });
});
