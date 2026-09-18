import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UUID_RE, leadDeepLink, leadDeepPath, leadPagePath } from "@/lib/leadLink";

/**
 * The link inside the new-lead email and text (§63.4), and the redirector
 * behind it. The email and SMS senders reach Resend and Twilio, so what is
 * pinned is the text of the real files (§42.8):
 *
 *   - the email button goes to the `/l/` redirector, not /login;
 *   - the SMS uses the same link and still carries no landlord PII;
 *   - the redirector carries the return path and is never cached.
 */
const emails = readFileSync("src/lib/emails.ts", "utf8");
const sms = readFileSync("src/lib/sms.ts", "utf8");
const route = readFileSync("src/app/l/[leadId]/route.ts", "utf8");

const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("leadLink", () => {
  it("builds the three forms from one lead id", () => {
    const id = "aaaa0000-0000-0000-0000-000000000001";
    expect(leadPagePath(id)).toBe(`/dashboard/leads/${id}`);
    expect(leadDeepPath(id)).toBe(`/l/${id}`);
    expect(leadDeepLink(id)).toMatch(new RegExp(`^https?://[^/]+/l/${id}$`));
    // A bare path: no query string, so the email needs no esc() on it.
    expect(leadDeepLink(id)).not.toContain("?");
  });

  it("accepts a uuid and nothing else", () => {
    expect(UUID_RE.test("aaaa0000-0000-0000-0000-000000000001")).toBe(true);
    expect(UUID_RE.test("AAAA0000-0000-0000-0000-000000000001")).toBe(true);
    expect(UUID_RE.test("../dashboard")).toBe(false);
    expect(UUID_RE.test("aaaa0000-0000-0000-0000-00000000000")).toBe(false);
  });
});

describe("the new-lead email", () => {
  const fn = (() => {
    const c = code(emails);
    const start = c.indexOf("export async function sendNewLeadEmail");
    return c.slice(start, c.indexOf("export async function", start + 10));
  })();

  it("links to the redirector, not the login page", () => {
    expect(fn).toContain("button(leadDeepLink(lead.id)");
    expect(fn).not.toContain("button(LOGIN_URL");
  });

  it("adds the projection for management only, and only when there is one", () => {
    expect(fn).toContain('=== "management" ? buildIncomeProjection(lead) : null');
    expect(fn).toContain("if (projection)");
  });
});

describe("the new-lead text", () => {
  const fn = (() => {
    const c = code(sms);
    const start = c.indexOf("function composeMessage");
    return c.slice(start, c.indexOf("export async function sendNewLeadSms", start));
  })();

  it("uses the same redirector link", () => {
    expect(fn).toContain("leadDeepLink(lead.id)");
    expect(fn).not.toContain("/dashboard/leads/");
  });

  it("still carries no landlord PII beyond the town and bedrooms", () => {
    expect(fn).not.toContain("lead.lead_name");
    expect(fn).not.toContain("lead.phone");
    expect(fn).not.toContain("lead.email");
    // The address is read only to derive the town; it is never interpolated.
    expect(fn).toContain("extractCity(lead.address)");
    expect(fn).not.toContain("${lead.address");
  });
});

describe("the /l/[leadId] redirector", () => {
  const c = code(route);

  it("sends a signed-out visitor through login with the return path", () => {
    expect(c).toContain("redirectedFrom=");
    expect(c).toContain("encodeURIComponent(target)");
  });

  it("is never cached and never uses the service role", () => {
    expect(c).toContain("no-store");
    expect(c).not.toContain("createAdminClient");
  });

  it("refuses anything that is not a uuid before touching the session", () => {
    const test = c.indexOf("UUID_RE.test(leadId)");
    const session = c.indexOf("auth.getUser()");
    expect(test).toBeGreaterThan(-1);
    expect(session).toBeGreaterThan(test);
  });
});
