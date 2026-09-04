/**
 * The landlord-facing overrides (§41, 0131).
 *
 * ⚠️ THE REGRESSION THAT MATTERS IS THE FIRST BLOCK. Every live row starts with
 * all four columns null, so a resolver that did anything other than return the
 * account values would change what 44 customers' landlords are told, on the day
 * it deployed, for no reason anybody asked for.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_REFERRAL_NAME_CHARS,
  REFERRAL_OPERATOR_COLUMNS,
  resolveOperatorNames,
  resolveReferralOperator,
  validateReferralDetails,
} from "@/lib/referralIdentity";
import {
  buildReferralCopy,
  operatorLabel,
  renderReferralBody,
} from "@/lib/landlordReferral";
import { normaliseUkMobile } from "@/lib/leadQuality";

const ACCOUNT = {
  business_name: "Bristol Stays",
  contact_name: "Jo Whitfield",
  email: "jo@bristolstays.co.uk",
  phone: "07700900123",
  operator_intro: "We look after short lets across Bristol.",
};

describe("null means use the account details", () => {
  it("returns the account values untouched when nothing is overridden", () => {
    expect(resolveReferralOperator(ACCOUNT)).toEqual({
      business_name: "Bristol Stays",
      contact_name: "Jo Whitfield",
      phone: "07700900123",
      email: "jo@bristolstays.co.uk",
      operator_intro: "We look after short lets across Bristol.",
    });
  });

  it("treats an explicit null and a missing key the same", () => {
    expect(
      resolveReferralOperator({
        ...ACCOUNT,
        referral_business_name: null,
        referral_contact_name: null,
        referral_phone: null,
        referral_email: null,
      })
    ).toEqual(resolveReferralOperator(ACCOUNT));
  });

  it("⚠️ treats whitespace as not-set, so a stray space cannot blank a row", () => {
    // buildReferralCopy pushes a row for any truthy value; "   " would render
    // "Phone:" with nothing beside it, in an email to a member of the public.
    const out = resolveReferralOperator({
      ...ACCOUNT,
      referral_phone: "   ",
      referral_business_name: "",
    });
    expect(out.phone).toBe("07700900123");
    expect(out.business_name).toBe("Bristol Stays");
  });

  it("falls through to null when neither side has a value", () => {
    const out = resolveReferralOperator({ business_name: "Solo Lets" });
    expect(out.phone).toBeNull();
    expect(out.email).toBeNull();
    expect(out.contact_name).toBeNull();
  });
});

describe("an override wins, one field at a time", () => {
  it("replaces only the field it names", () => {
    const out = resolveReferralOperator({
      ...ACCOUNT,
      referral_email: "enquiries@bristolstays.co.uk",
    });
    expect(out.email).toBe("enquiries@bristolstays.co.uk");
    expect(out.phone).toBe("07700900123");
    expect(out.contact_name).toBe("Jo Whitfield");
    expect(out.business_name).toBe("Bristol Stays");
  });

  it("⚠️ operatorLabel honours the override — it decides the subject line", () => {
    // Left reading business_name directly, a customer could set a public
    // company name and still see the old one in the subject of the email that
    // introduces them.
    const resolved = resolveReferralOperator({
      ...ACCOUNT,
      referral_business_name: "Bristol Short Lets Ltd",
    });
    expect(operatorLabel(resolved)).toBe("Bristol Short Lets Ltd");
  });

  it("still falls back to the contact name, then the generic label", () => {
    expect(
      operatorLabel(resolveReferralOperator({ contact_name: "Jo Whitfield" }))
    ).toBe("Jo Whitfield");
    expect(operatorLabel(resolveReferralOperator({}))).toBe("a local operator");
  });

  it("resolveOperatorNames gives the drafter the same names as the email", () => {
    const row = { ...ACCOUNT, referral_business_name: "Bristol Short Lets Ltd" };
    expect(resolveOperatorNames(row)).toEqual({
      business_name: "Bristol Short Lets Ltd",
      contact_name: "Jo Whitfield",
    });
  });
});

describe("the shared select string", () => {
  it("names every column the resolver reads", () => {
    for (const col of [
      "business_name",
      "contact_name",
      "email",
      "phone",
      "operator_intro",
      "referral_business_name",
      "referral_contact_name",
      "referral_email",
      "referral_phone",
    ]) {
      expect(REFERRAL_OPERATOR_COLUMNS).toContain(col);
    }
  });

  it("⚠️ names NO account column the overrides are not allowed to touch", () => {
    // It is a read list. If a writer ever reuses it, it must not carry
    // stripe ids, balances or the auth linkage.
    for (const col of ["stripe_customer_id", "user_id", "lead_balance", "account_status"]) {
      expect(REFERRAL_OPERATOR_COLUMNS).not.toContain(col);
    }
  });
});

describe("validation", () => {
  it("clearing a field is a legitimate save — it is how you undo an override", () => {
    const v = validateReferralDetails({
      referral_contact_name: "",
      referral_business_name: "   ",
      referral_phone: "",
      referral_email: "",
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.patch).toEqual({
        referral_contact_name: null,
        referral_business_name: null,
        referral_phone: null,
        referral_email: null,
      });
    }
  });

  it("normalises an email and collapses whitespace in a name", () => {
    const v = validateReferralDetails({
      referral_contact_name: "  Jo   Whitfield ",
      referral_email: "  Enquiries@BristolStays.co.uk ",
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.patch.referral_contact_name).toBe("Jo Whitfield");
      expect(v.patch.referral_email).toBe("enquiries@bristolstays.co.uk");
    }
  });

  it("⚠️ ACCEPTS A LANDLINE, which normaliseUkMobile refuses", () => {
    // The mobile rule exists for WhatsApp deliverability (§36). A landlord
    // ringing an office number is the ordinary case here, and refusing it would
    // be us overruling an operator about how to be contacted.
    const landline = "0117 456 7890";
    expect(normaliseUkMobile(landline).ok).toBe(false);

    const v = validateReferralDetails({ referral_phone: landline });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.patch.referral_phone).toBe(landline);
  });

  it("accepts an international number", () => {
    const v = validateReferralDetails({ referral_phone: "+353 1 234 5678" });
    expect(v.ok).toBe(true);
  });

  it("refuses something that is not a phone number, and names the field", () => {
    const v = validateReferralDetails({ referral_phone: "call me" });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.field).toBe("referral_phone");
      expect(v.message).toContain("landline is fine");
    }
  });

  it("refuses a malformed email, and names the field", () => {
    for (const bad of ["not-an-email", "a@b", "a b@c.com", "@x.com"]) {
      const v = validateReferralDetails({ referral_email: bad });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.field).toBe("referral_email");
    }
  });

  it("refuses an over-long name", () => {
    const v = validateReferralDetails({
      referral_business_name: "a".repeat(MAX_REFERRAL_NAME_CHARS + 1),
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.field).toBe("referral_business_name");
  });

  it("refuses a non-string rather than coercing it", () => {
    const v = validateReferralDetails({ referral_contact_name: 42 });
    expect(v.ok).toBe(false);
  });

  it("⚠️ does NOT reject a duplicate address — this is not a login", () => {
    // Two operators in one office may legitimately publish the same
    // enquiries@ inbox. customers.email, which IS unique, is untouched.
    const a = validateReferralDetails({ referral_email: "enquiries@office.co.uk" });
    const b = validateReferralDetails({ referral_email: "enquiries@office.co.uk" });
    expect(a.ok && b.ok).toBe(true);
  });

  it("an empty input object is a valid save that clears everything", () => {
    const v = validateReferralDetails({});
    expect(v.ok).toBe(true);
    if (v.ok) expect(Object.values(v.patch).every((x) => x === null)).toBe(true);
  });
});

describe("⚠️ the deploy-day regression: nobody with no overrides sees any change", () => {
  const LEAD = {
    lead_name: "Sarah Whitfield",
    address: "14 Gill Avenue, Bristol",
    lead_type: "management",
    gross_annual_income: 41250,
  } as Parameters<typeof buildReferralCopy>[0]["lead"];

  it("renders byte-identically to passing the raw account row", () => {
    // Every one of the 44 live rows starts with all four columns null. This is
    // the assertion that the resolver is a no-op for them.
    const before = buildReferralCopy({ lead: LEAD, operator: ACCOUNT, askQuestions: true });
    const after = buildReferralCopy({
      lead: LEAD,
      operator: resolveReferralOperator(ACCOUNT),
      askQuestions: true,
    });
    expect(renderReferralBody(after)).toBe(renderReferralBody(before));
    expect(after.subject).toBe(before.subject);
    expect(after.rows).toEqual(before.rows);
  });

  it("and the GR wording is equally untouched", () => {
    const grLead = { ...LEAD, lead_type: "guaranteed_rent" } as typeof LEAD;
    const before = buildReferralCopy({ lead: grLead, operator: ACCOUNT, askQuestions: false });
    const after = buildReferralCopy({
      lead: grLead,
      operator: resolveReferralOperator(ACCOUNT),
      askQuestions: false,
    });
    expect(renderReferralBody(after)).toBe(renderReferralBody(before));
  });

  it("changes exactly one row when exactly one override is set", () => {
    const before = buildReferralCopy({ lead: LEAD, operator: ACCOUNT, askQuestions: true });
    const after = buildReferralCopy({
      lead: LEAD,
      operator: resolveReferralOperator({
        ...ACCOUNT,
        referral_phone: "0117 456 7890",
      }),
      askQuestions: true,
    });

    const changed = after.rows.filter(
      (r, i) => before.rows[i]?.value !== r.value
    );
    expect(changed).toEqual([{ label: "Phone", value: "0117 456 7890" }]);
    // The subject is built from the company, so it must NOT move.
    expect(after.subject).toBe(before.subject);
  });
});
