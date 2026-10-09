import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

// The baseline hashes were taken with the default portal URL. Pin it before
// any module reads it, so a developer's own NEXT_PUBLIC_APP_URL cannot move them.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

import { sendNewLeadEmail } from "@/lib/emails";
import type { Lead } from "@/lib/types";

/**
 * The new-lead email (Lead Brief Phase 5). Resend is mocked, so nothing leaves
 * the process.
 *
 * ⚠️ AN EXISTING CUSTOMER'S EMAIL MUST NOT CHANGE BY ONE BYTE. The two hashes
 * below were taken from the email as it was BEFORE Phase 5 touched
 * sendNewLeadEmail, over sha256(subject + "\n" + html), for this fixture lead.
 * Only a brief customer's email gains the label block.
 */
const LEAD = {
  id: "11111111-2222-3333-4444-555555555555",
  lead_name: "Jane Smith",
  address: "12 High Street, York",
  postcode: "YO10 5DD",
  bedrooms: "3",
  lead_profile: "Owns two flats",
  lead_type: "management",
  gross_annual_income: 42000,
} as unknown as Lead;

const BASELINE = {
  plain: "4486953fa2cb560a6cce42c9b92fa2afb99d9aee26f4f726041d76e26b690429",
  todaysLead: "380bf3fd7d80f11b6037c3fa1f0dcb4c8fa4d0a990f1b9134b750028f3544078",
};

const render = async (over: Partial<Parameters<typeof sendNewLeadEmail>[0]> = {}) => {
  send.mockClear();
  send.mockResolvedValue({ data: { id: "resend_1" }, error: null });
  await sendNewLeadEmail({ to: "a@b.c", lead: LEAD, ...over });
  return send.mock.calls[0][0] as { subject: string; html: string };
};

const hash = (m: { subject: string; html: string }) =>
  createHash("sha256").update(`${m.subject}\n${m.html}`).digest("hex");

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
});

describe("sendNewLeadEmail — unchanged without a label", () => {
  it("is byte-for-byte the pre-Phase 5 email", async () => {
    expect(hash(await render())).toBe(BASELINE.plain);
    expect(hash(await render({ todaysLead: true }))).toBe(BASELINE.todaysLead);
  });

  it("an explicit undefined match is the same email", async () => {
    expect(hash(await render({ match: undefined }))).toBe(BASELINE.plain);
  });
});

describe("sendNewLeadEmail — a brief customer's label", () => {
  const match = {
    label: "Top match",
    reason: "Sent to you because it matches your brief exactly.",
  };

  it("adds the label and its reason between the intro and the table, and nothing else", async () => {
    const plain = await render();
    const labelled = await render({ match });
    expect(labelled.html).toContain("<strong");
    expect(labelled.html).toContain("Top match</strong><br />Sent to you because it matches your brief exactly.</p>");
    expect(labelled.html.indexOf("Top match")).toBeGreaterThan(labelled.html.indexOf("A new lead is ready"));
    expect(labelled.html.indexOf("Top match")).toBeLessThan(labelled.html.indexOf("<table style=\"width:100%"));
    expect(labelled.subject).toBe(plain.subject);
    // Remove the one inserted paragraph and the rest is the plain email.
    const start = labelled.html.indexOf('\n    <p style="margin:0 0 18px;font-size:14px"><strong');
    const end = labelled.html.indexOf("</p>", start) + "</p>".length;
    expect(start).toBeGreaterThan(-1);
    expect(labelled.html.slice(0, start) + labelled.html.slice(end)).toBe(plain.html);
  });

  it("escapes what it renders", async () => {
    const { html } = await render({ match: { label: "<b>Top</b>", reason: 'A "quote" & <i>tag</i>' } });
    expect(html).not.toContain("<b>Top</b>");
    expect(html).not.toContain("<i>tag</i>");
    expect(html).toContain("&lt;b&gt;Top&lt;/b&gt;");
  });
});
