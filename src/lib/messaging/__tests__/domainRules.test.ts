/**
 * The highest-value test file in the messaging feature.
 *
 * It is the only thing standing between us and putting an MX record on a
 * customer's apex domain, which would stop their real email arriving. Verified
 * while planning: stayful.co.uk resolves MX to smtp.google.com, so this is a
 * live Google Workspace an apex mistake would take down.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normaliseDomain,
  publicSuffixOf,
  registrableDomain,
  isDedicatedSubdomain,
  validateSendingDomain,
  buildSendingDomain,
  preflightDns,
} from "../domainRules";

describe("public suffix handling", () => {
  it("recognises multi-label UK suffixes", () => {
    expect(publicSuffixOf("leads.theiragency.co.uk")).toBe("co.uk");
    expect(publicSuffixOf("leads.example.org.uk")).toBe("org.uk");
    expect(publicSuffixOf("leads.example.com")).toBe("com");
  });

  it("finds the registrable domain under a multi-label suffix", () => {
    expect(registrableDomain("leads.theiragency.co.uk")).toBe("theiragency.co.uk");
    expect(registrableDomain("a.b.theiragency.co.uk")).toBe("theiragency.co.uk");
    expect(registrableDomain("theiragency.co.uk")).toBe("theiragency.co.uk");
    expect(registrableDomain("leads.example.com")).toBe("example.com");
  });

  it("distinguishes a subdomain from its apex", () => {
    expect(isDedicatedSubdomain("leads.theiragency.co.uk")).toBe(true);
    // The case a label count cannot catch: three labels, and still an apex.
    expect(isDedicatedSubdomain("theiragency.co.uk")).toBe(false);
    expect(isDedicatedSubdomain("example.com")).toBe(false);
  });
});

describe("validateSendingDomain — refuses every shape of apex", () => {
  it("accepts a genuine dedicated subdomain", () => {
    const v = validateSendingDomain("leads.theiragency.co.uk");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.domain).toBe("leads.theiragency.co.uk");
      expect(v.parent).toBe("theiragency.co.uk");
    }
  });

  it("REFUSES a UK apex that has three labels", () => {
    // The case that defeats label counting, and the reason the DB CHECK in 0115
    // is documented as a floor rather than a guard.
    const v = validateSendingDomain("theiragency.co.uk");
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("apex");
      // The message must name the fix, not just the fault.
      expect(v.message).toContain("leads.theiragency.co.uk");
      expect(v.message).toContain("stop your existing email arriving");
    }
  });

  it("REFUSES a two-label apex, with the same message", () => {
    const v = validateSendingDomain("example.com");
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("apex");
      expect(v.message).toContain("leads.example.com");
    }
  });

  it("REFUSES a multi-label public suffix as public_suffix", () => {
    const v = validateSendingDomain("co.uk");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("public_suffix");
  });

  it("never offers a bare suffix back as a usable subdomain", () => {
    // The property that matters: whatever the code, the advice must never be
    // "use leads.co.uk", which is not a domain the customer can own.
    for (const bare of ["co.uk", "uk", "com", "org.uk"]) {
      const v = validateSendingDomain(bare);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(["public_suffix", "malformed"]).toContain(v.code);
        expect(v.message).not.toContain(`leads.${bare}`);
      }
    }
  });

  it("accepts a deeper subdomain", () => {
    expect(validateSendingDomain("a.b.theiragency.co.uk").ok).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["not a domain", "malformed"],
    ["-leads.example.com", "malformed"],
    ["leads..example.com", "malformed"],
    ["localhost", "malformed"],
  ])("refuses %s", (input, code) => {
    const v = validateSendingDomain(input);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(code);
  });

  it("normalises case, trailing dots, scheme and path", () => {
    expect(normaliseDomain("  HTTPS://Leads.Example.CO.UK/x  ")).toBe(
      "leads.example.co.uk"
    );
    expect(validateSendingDomain("LEADS.Theiragency.co.uk.").ok).toBe(true);
  });
});

describe("buildSendingDomain — the customer never types a whole domain", () => {
  it("constructs the subdomain from a website domain", () => {
    const v = buildSendingDomain("theiragency.co.uk");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.domain).toBe("leads.theiragency.co.uk");
  });

  it("cannot be made to produce an apex, even when given one", () => {
    for (const input of ["theiragency.co.uk", "example.com", "www.example.com"]) {
      const v = buildSendingDomain(input);
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(isDedicatedSubdomain(v.domain)).toBe(true);
        expect(v.domain).not.toBe(registrableDomain(input));
      }
    }
  });

  it("does not stack a second label when given a subdomain", () => {
    const v = buildSendingDomain("www.theiragency.co.uk");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.domain).toBe("leads.theiragency.co.uk");
  });

  it("honours a custom prefix and rejects a malformed one", () => {
    const ok = buildSendingDomain("theiragency.co.uk", "stayful");
    expect(ok.ok && ok.domain).toBe("stayful.theiragency.co.uk");
    expect(buildSendingDomain("theiragency.co.uk", "not valid!").ok).toBe(false);
  });
});

describe("preflightDns — the layer that tests the real world", () => {
  afterEach(() => vi.restoreAllMocks());

  async function withMx(map: Record<string, unknown[] | Error>) {
    const dns = await import("node:dns");
    vi.spyOn(dns.promises, "resolveMx").mockImplementation(async (h: string) => {
      const v = map[h];
      if (v instanceof Error) throw v;
      return (v ?? []) as never;
    });
  }

  it("accepts when the target is empty and the parent has mail", async () => {
    await withMx({
      "leads.theiragency.co.uk": [],
      "theiragency.co.uk": [{ exchange: "smtp.google.com", priority: 10 }],
    });
    const v = await preflightDns("leads.theiragency.co.uk");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.warning).toBeUndefined();
  });

  it("REFUSES a target that already receives mail", async () => {
    // This is the apex catastrophe in its realistic form: the operator typed
    // their live mail domain and it is serving Google Workspace.
    await withMx({
      "leads.theiragency.co.uk": [{ exchange: "smtp.google.com", priority: 10 }],
      "theiragency.co.uk": [{ exchange: "smtp.google.com", priority: 10 }],
    });
    const v = await preflightDns("leads.theiragency.co.uk");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("target_has_mx");
  });

  it("WARNS but does not block when the parent has no mail", async () => {
    // A domain bought fresh for this is legitimate; blocking would be wrong.
    await withMx({ "leads.newdomain.co.uk": [], "newdomain.co.uk": [] });
    const v = await preflightDns("leads.newdomain.co.uk");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.warning).toBe("parent_has_no_mx");
  });

  it("treats an EMPTY ARRAY as 'no MX' rather than relying on a throw", async () => {
    // Verified live: leads.stayful.co.uk RESOLVES with an empty array.
    await withMx({ "leads.theiragency.co.uk": [], "theiragency.co.uk": [] });
    expect((await preflightDns("leads.theiragency.co.uk")).ok).toBe(true);
  });

  it("treats NXDOMAIN/ENODATA on the target as 'nothing there yet'", async () => {
    const nx = Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    await withMx({
      "leads.theiragency.co.uk": nx,
      "theiragency.co.uk": [{ exchange: "smtp.google.com", priority: 10 }],
    });
    expect((await preflightDns("leads.theiragency.co.uk")).ok).toBe(true);
  });

  it("NEVER accepts when the resolver fails for an unknown reason", async () => {
    const boom = Object.assign(new Error("servfail"), { code: "ESERVFAIL" });
    await withMx({ "leads.theiragency.co.uk": boom });
    const v = await preflightDns("leads.theiragency.co.uk");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("dns_error");
  });

  it("still refuses an apex before it ever reaches DNS", async () => {
    const spy = vi.fn();
    const dns = await import("node:dns");
    vi.spyOn(dns.promises, "resolveMx").mockImplementation(spy as never);
    const v = await preflightDns("theiragency.co.uk");
    expect(v.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
