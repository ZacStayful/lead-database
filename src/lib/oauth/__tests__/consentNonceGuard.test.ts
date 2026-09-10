/**
 * ⚠️ THE REGRESSION THAT TOOK THE CONSENT SCREEN DOWN IN PRODUCTION (§45).
 *
 * src/app/oauth/authorize/page.tsx called cookies().set() to mint the CSRF
 * nonce. cookies() is read-only in a Server Component on Next 14, so .set()
 * throws "Cookies can only be modified in a Server Action or Route Handler".
 *
 * What made it survive review and a green build is the shape worth pinning: the
 * page returns early on every invalid request, so an unknown client_id and a
 * bare request both rendered their error pages correctly and only a VALID
 * authorization request ever reached the throw. A customer with a working
 * client got a 500; anybody testing with a bad one saw the feature working.
 * `next build` cannot catch it either — it is a runtime throw on a page no test
 * renders.
 *
 * So this asserts the real file text, the §42.8 discipline, because that is the
 * only kind of test that would have caught it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONSENT_NONCE_COOKIE,
  CONSENT_NONCE_MAX_AGE_SECONDS,
  consentNonceCookieOptions,
} from "@/lib/oauth/consentNonce";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = join(here, "../../../app/oauth/authorize/page.tsx");
const NONCE_ROUTE = join(here, "../../../app/api/oauth/consent-nonce/route.ts");
const POST_ROUTE = join(here, "../../../app/api/oauth/authorize/route.ts");

describe("the consent page must never write a cookie", () => {
  it("does not call cookies().set()", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).not.toMatch(/cookies\(\)\s*\.\s*set\s*\(/);
  });

  it("does not import cookies at all, so it cannot drift back", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).not.toMatch(/import\s*\{[^}]*\bcookies\b[^}]*\}\s*from\s*"next\/headers"/);
  });
});

describe("the nonce comes from a route handler, which may set cookies", () => {
  it("sets the cookie", () => {
    const src = readFileSync(NONCE_ROUTE, "utf8");
    expect(src).toMatch(/cookies\.set\(\s*CONSENT_NONCE_COOKIE/);
  });

  it("is never cached — a stored nonce would be handed to the next visitor", () => {
    const src = readFileSync(NONCE_ROUTE, "utf8");
    // ⚠️ Anchored on the SUCCESS response, not on any no-store in the file. The
    // 401 and 503 branches carry one too, so a looser match passed even with
    // the header stripped off the only response that carries a nonce.
    expect(src).toMatch(
      /NextResponse\.json\(\s*\{\s*nonce\s*\}\s*,\s*\{\s*headers:\s*\{\s*"Cache-Control":\s*"no-store, private"/
    );
    expect(src).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("refuses an unauthenticated caller", () => {
    const src = readFileSync(NONCE_ROUTE, "utf8");
    expect(src).toMatch(/getUser\(\)/);
    expect(src).toMatch(/status:\s*401/);
  });
});

describe("the double-submit pair still agrees on one cookie name", () => {
  it("the POST reads the shared constant, not a copy and not the page", () => {
    const src = readFileSync(POST_ROUTE, "utf8");
    expect(src).toContain('from "@/lib/oauth/consentNonce"');
    // Importing a page into a route drags its whole module graph along with it.
    expect(src).not.toContain("@/app/oauth/authorize/page");
    expect(src).toMatch(/cookies\(\)\.get\(CONSENT_NONCE_COOKIE\)/);
  });

  it("keeps the cookie name and lifetime the flow was built around", () => {
    expect(CONSENT_NONCE_COOKIE).toBe("sf_oauth_consent");
    expect(CONSENT_NONCE_MAX_AGE_SECONDS).toBe(600);
  });

  it("scopes the cookie to the whole site — it is set and read on different paths", () => {
    const opts = consentNonceCookieOptions();
    expect(opts.path).toBe("/");
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.maxAge).toBe(CONSENT_NONCE_MAX_AGE_SECONDS);
  });
});
