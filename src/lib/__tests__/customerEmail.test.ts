import { describe, it, expect } from "vitest";
import {
  planEmailChange,
  emailChangeRefusal,
  type EmailChangeSubject,
} from "../customerEmail";

function subject(over: Partial<EmailChangeSubject> = {}): EmailChangeSubject {
  return {
    email: "emanuelasharra@yahoo.co.uk",
    user_id: "0b8fd26b-02d0-4ed9-b243-71dc15893d63",
    stripe_customer_id: null,
    gr_stripe_customer_id: "cus_VBjeucWp0lSyAc",
    ...over,
  };
}

describe("planEmailChange", () => {
  it("accepts a change and normalises the new address", () => {
    const plan = planEmailChange(subject(), "  Contact@VellaukProperties.co.uk ");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.email).toBe("contact@vellaukproperties.co.uk");
  });

  it("refuses an unusable address", () => {
    for (const bad of ["", "   ", "nope", "user@", "@x.com", null, 42, {}]) {
      const plan = planEmailChange(subject(), bad);
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.reason).toBe("invalid");
    }
  });

  it("treats the same address as unchanged, whatever its case or padding", () => {
    for (const same of [
      "emanuelasharra@yahoo.co.uk",
      "  Emanuelasharra@Yahoo.CO.UK  ",
    ]) {
      const plan = planEmailChange(subject(), same);
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.reason).toBe("unchanged");
    }
  });

  it("compares against a stored address that is itself unnormalised", () => {
    const plan = planEmailChange(
      subject({ email: "  Emanuelasharra@Yahoo.co.uk " }),
      "emanuelasharra@yahoo.co.uk"
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("unchanged");
  });

  it("refuses a customer with no auth user", () => {
    const plan = planEmailChange(subject({ user_id: null }), "new@example.com");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("no_login");
  });

  it("checks validity before anything else", () => {
    // An invalid address on a customer with no login must report the address,
    // which is the thing the admin can actually fix in the form.
    const plan = planEmailChange(subject({ user_id: null }), "nope");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("invalid");
  });
});

describe("planEmailChange — Stripe ids", () => {
  it("returns both when they differ", () => {
    const plan = planEmailChange(
      subject({ stripe_customer_id: "cus_mgmt", gr_stripe_customer_id: "cus_gr" }),
      "new@example.com"
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.stripeCustomerIds.sort()).toEqual(["cus_gr", "cus_mgmt"]);
  });

  it("dedupes when GR bills against the shared customer", () => {
    // The common case for a GR subscription provisioned before the Payment Link
    // split — both columns hold the same id, and updating it twice is a wasted
    // API call against the same object.
    const plan = planEmailChange(
      subject({ stripe_customer_id: "cus_same", gr_stripe_customer_id: "cus_same" }),
      "new@example.com"
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.stripeCustomerIds).toEqual(["cus_same"]);
  });

  it("handles only one column being set, in either direction", () => {
    const gr = planEmailChange(
      subject({ stripe_customer_id: null, gr_stripe_customer_id: "cus_gr" }),
      "new@example.com"
    );
    expect(gr.ok && gr.stripeCustomerIds).toEqual(["cus_gr"]);

    const mgmt = planEmailChange(
      subject({ stripe_customer_id: "cus_mgmt", gr_stripe_customer_id: null }),
      "new@example.com"
    );
    expect(mgmt.ok && mgmt.stripeCustomerIds).toEqual(["cus_mgmt"]);
  });

  it("returns none for a comped account that never reached Stripe", () => {
    const plan = planEmailChange(
      subject({ stripe_customer_id: null, gr_stripe_customer_id: null }),
      "new@example.com"
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.stripeCustomerIds).toEqual([]);
  });

  it("ignores empty strings, which are not usable ids", () => {
    const plan = planEmailChange(
      subject({ stripe_customer_id: "", gr_stripe_customer_id: "cus_gr" }),
      "new@example.com"
    );
    expect(plan.ok && plan.stripeCustomerIds).toEqual(["cus_gr"]);
  });
});

describe("planEmailChange — owner warning", () => {
  // OWNER_EMAILS defaults to zac@stayful.co.uk when the env var is unset.
  it("warns when an owner is moved off the allowlist", () => {
    const plan = planEmailChange(
      subject({ email: "zac@stayful.co.uk" }),
      "someone.else@example.com"
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ownerWarning).toBe(true);
  });

  it("does not warn for an ordinary customer", () => {
    const plan = planEmailChange(subject(), "new@example.com");
    expect(plan.ok && plan.ownerWarning).toBe(false);
  });

  it("does not warn when a non-owner becomes an owner", () => {
    const plan = planEmailChange(subject(), "zac@stayful.co.uk");
    expect(plan.ok && plan.ownerWarning).toBe(false);
  });
});

describe("emailChangeRefusal", () => {
  it("gives a distinct sentence for each reason", () => {
    const messages = (["invalid", "unchanged", "no_login"] as const).map(
      emailChangeRefusal
    );
    expect(new Set(messages).size).toBe(3);
    expect(emailChangeRefusal("no_login")).toContain("invite");
  });
});
