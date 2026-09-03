import { describe, it, expect } from "vitest";
import { normaliseEmail } from "../emailAddress";

describe("normaliseEmail", () => {
  it("trims and lowercases", () => {
    expect(normaliseEmail("  Emanuela.Sharra@Yahoo.CO.UK \n")).toBe(
      "emanuela.sharra@yahoo.co.uk"
    );
  });

  it("accepts ordinary addresses unchanged", () => {
    expect(normaliseEmail("contact@vellaukproperties.co.uk")).toBe(
      "contact@vellaukproperties.co.uk"
    );
    // Underscores and plus-addressing are legitimate and must survive — the
    // reset route relies on this being the canonical form it looks up by.
    expect(normaliseEmail("john_smith+leads@example.com")).toBe(
      "john_smith+leads@example.com"
    );
  });

  it("rejects anything that is not a usable address", () => {
    expect(normaliseEmail("")).toBeNull();
    expect(normaliseEmail("   ")).toBeNull();
    expect(normaliseEmail("nope")).toBeNull();
    expect(normaliseEmail("@example.com")).toBeNull();
    expect(normaliseEmail("user@")).toBeNull();
    expect(normaliseEmail("user@localhost")).toBeNull();
    expect(normaliseEmail("user@.com")).toBeNull();
    expect(normaliseEmail("user@example.")).toBeNull();
    expect(normaliseEmail("two@at@example.com")).toBeNull();
    expect(normaliseEmail("has space@example.com")).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normaliseEmail(null)).toBeNull();
    expect(normaliseEmail(undefined)).toBeNull();
    expect(normaliseEmail(123)).toBeNull();
    expect(normaliseEmail({ email: "a@b.com" })).toBeNull();
  });

  it("is idempotent", () => {
    const once = normaliseEmail("  Foo@Bar.COM ")!;
    expect(normaliseEmail(once)).toBe(once);
  });
});
