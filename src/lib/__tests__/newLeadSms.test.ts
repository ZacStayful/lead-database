import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});

import { composeNewLeadSms } from "@/lib/sms";
import type { Lead } from "@/lib/types";

/**
 * The new-lead text (Lead Brief Phase 5): a brief customer's names the label
 * and nothing more. Without a label it is exactly what it was.
 */
const LEAD = {
  id: "11111111-2222-3333-4444-555555555555",
  lead_name: "Jane Smith",
  address: "12 High Street, York",
  bedrooms: "3",
} as unknown as Lead;

describe("composeNewLeadSms", () => {
  it("is unchanged without a label", () => {
    expect(composeNewLeadSms(LEAD)).toBe(
      "Stayful: a new lead just landed in York, 3 bed. Be first to call — open it here: https://leads.stayful.co.uk/l/11111111-2222-3333-4444-555555555555"
    );
    expect(composeNewLeadSms(LEAD, undefined)).toBe(composeNewLeadSms(LEAD));
  });

  it("names the label for a brief customer, and adds no landlord detail", () => {
    const text = composeNewLeadSms(LEAD, "Top match");
    expect(text).toBe(
      "Stayful: a new Top match just landed in York, 3 bed. Be first to call — open it here: https://leads.stayful.co.uk/l/11111111-2222-3333-4444-555555555555"
    );
    expect(text).not.toContain("Jane");
    expect(text).not.toContain("High Street");
  });
});
