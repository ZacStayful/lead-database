import { describe, it, expect } from "vitest";
import {
  classifyGenerateLinkError,
  hashResetSubject,
  resetBudgetRefusal,
  RESET_EMAIL_PER_SHORT_WINDOW,
  RESET_EMAIL_PER_LONG_WINDOW,
  RESET_IP_PER_LONG_WINDOW,
} from "../authReset";

describe("classifyGenerateLinkError", () => {
  // The three shapes supabase-js has used for a missing user across versions.
  it("recognises the user_not_found code", () => {
    expect(classifyGenerateLinkError({ code: "user_not_found" })).toBe("no_user");
  });

  it("recognises a 404", () => {
    expect(classifyGenerateLinkError({ status: 404, message: "not found" })).toBe(
      "no_user"
    );
  });

  it("recognises a 400 whose message names the condition", () => {
    expect(
      classifyGenerateLinkError({ status: 400, message: "User not found" })
    ).toBe("no_user");
    expect(
      classifyGenerateLinkError({ status: 400, message: "no user with that email" })
    ).toBe("no_user");
  });

  // Everything below is the safety property: an unrecognised failure must never
  // be reported to a customer as "we don't recognise that email".
  it("treats a 400 with an unrelated message as transport", () => {
    expect(
      classifyGenerateLinkError({
        status: 400,
        message: "Unable to validate email address: invalid format",
      })
    ).toBe("transport");
  });

  it("treats a 500 as transport", () => {
    expect(
      classifyGenerateLinkError({ status: 500, message: "Internal Server Error" })
    ).toBe("transport");
  });

  it("treats a 429 as transport", () => {
    expect(
      classifyGenerateLinkError({ status: 429, message: "rate limit exceeded" })
    ).toBe("transport");
  });

  it("treats a 401 from a bad service-role key as transport", () => {
    expect(
      classifyGenerateLinkError({ status: 401, message: "Invalid API key" })
    ).toBe("transport");
  });

  it("treats unrecognised and empty shapes as transport", () => {
    expect(classifyGenerateLinkError(null)).toBe("transport");
    expect(classifyGenerateLinkError(undefined)).toBe("transport");
    expect(classifyGenerateLinkError("user_not_found")).toBe("transport");
    expect(classifyGenerateLinkError(42)).toBe("transport");
    expect(classifyGenerateLinkError({})).toBe("transport");
    expect(classifyGenerateLinkError(new Error("User not found"))).toBe(
      "transport"
    );
    expect(classifyGenerateLinkError({ code: 404 })).toBe("transport");
  });
});

describe("hashResetSubject", () => {
  it("produces a stable 64-character hex digest matching the column CHECK", () => {
    const hash = hashResetSubject("emanuelasharra@yahoo.co.uk");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashResetSubject("emanuelasharra@yahoo.co.uk")).toBe(hash);
  });

  it("does not leak the address", () => {
    expect(hashResetSubject("a@b.com")).not.toContain("a@b.com");
  });

  it("separates different subjects", () => {
    expect(hashResetSubject("a@b.com")).not.toBe(hashResetSubject("c@d.com"));
  });
});

describe("resetBudgetRefusal", () => {
  it("allows an attempt at each ceiling", () => {
    expect(
      resetBudgetRefusal({
        email_short: RESET_EMAIL_PER_SHORT_WINDOW,
        email_long: RESET_EMAIL_PER_LONG_WINDOW,
        ip_long: RESET_IP_PER_LONG_WINDOW,
      })
    ).toBeNull();
  });

  it("refuses a second attempt inside the short window", () => {
    const refusal = resetBudgetRefusal({ email_short: 2, email_long: 2 });
    expect(refusal).toContain("try again in a minute");
  });

  it("refuses once the hourly email ceiling is passed", () => {
    const refusal = resetBudgetRefusal({
      email_short: 1,
      email_long: RESET_EMAIL_PER_LONG_WINDOW + 1,
    });
    expect(refusal).toContain("in the last hour");
  });

  it("refuses once the hourly IP ceiling is passed", () => {
    const refusal = resetBudgetRefusal({
      email_short: 1,
      email_long: 1,
      ip_long: RESET_IP_PER_LONG_WINDOW + 1,
    });
    expect(refusal).toContain("this connection");
  });

  it("treats a missing ip count as unlimited rather than refusing", () => {
    // The platform does not always report a client IP; an unknown IP must not
    // refuse a genuine customer.
    expect(
      resetBudgetRefusal({ email_short: 1, email_long: 1, ip_long: null })
    ).toBeNull();
    expect(resetBudgetRefusal({ email_short: 1, email_long: 1 })).toBeNull();
  });

  it("returns null on an empty result rather than refusing", () => {
    expect(resetBudgetRefusal({})).toBeNull();
  });
});
