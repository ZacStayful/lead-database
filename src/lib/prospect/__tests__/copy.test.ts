import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BOOKING_URL,
  emailForStep,
  emailStepThree,
  greeting,
  whatsappForStep,
} from "@/lib/prospect/copy";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("the booking link", () => {
  /**
   * ⚠️ ONE DEFINITION. The enquiry page redirects here after a successful
   * submit and every chase sends them back to the same place. Two copies drift
   * the first time the Calendly event type is renamed, and the failure is
   * silent: the form keeps working while every chase points at a dead link.
   */
  it("is the same URL the enquiry form redirects to", () => {
    const page = read("src/app/enquiry/page.tsx");
    expect(page).toContain(BOOKING_URL);
  });

  it("is the Stayful Lead Database event type, not one of the landlord ones", () => {
    // "Airbnb Profitability Action Plan" is the landlord call. Sending a
    // lead-buying operator there books the wrong meeting with the right person.
    expect(BOOKING_URL).toBe(
      "https://calendly.com/zac-stayful/stayful-lead-database"
    );
  });
});

describe("copy.ts stays import-free", () => {
  /**
   * ⚠️ The admin preview panel is a "use client" component, so these constants
   * cannot live next to anything reaching supabase-js, Resend or the Monday
   * client. The split featureRequest.ts makes from announcements.ts (§21.8).
   */
  it("has no import statements at all", () => {
    const src = read("src/lib/prospect/copy.ts");
    const imports = src
      .split("\n")
      .filter((l) => /^\s*import[\s{*]/.test(l));
    expect(imports).toEqual([]);
  });
});

describe("greeting", () => {
  it("uses the name when there is one", () => {
    expect(greeting("Ann")).toBe("Hi Ann, ");
  });

  /**
   * ⚠️ "Hi , " sent from a real person's WhatsApp to a member of the public is
   * worse than no name at all — it is the tell that a machine wrote it.
   */
  it("degrades to a bare greeting rather than an empty gap", () => {
    expect(greeting("")).toBe("Hi, ");
    expect(greeting("   ")).toBe("Hi, ");
    expect(greeting("")).not.toContain(" ,");
  });
});

describe("the messages themselves", () => {
  it("every one carries the booking link", () => {
    expect(whatsappForStep(1, { firstName: "Ann" })).toContain(BOOKING_URL);
    expect(whatsappForStep(2, { firstName: "Ann" })).toContain(BOOKING_URL);
    expect(emailForStep(1, { firstName: "Ann" })?.cta.url).toBe(BOOKING_URL);
    expect(emailForStep(3, { firstName: "Ann" })?.cta.url).toBe(BOOKING_URL);
  });

  it("has no message for a channel that step does not use", () => {
    // Step 3 is email-only and step 2 is WhatsApp-only. A stray message here
    // would be a fourth and fifth contact nobody decided to send.
    expect(whatsappForStep(3, { firstName: "Ann" })).toBeNull();
    expect(emailForStep(2, { firstName: "Ann" })).toBeNull();
  });

  it("keeps every WhatsApp short enough to read on a lock screen", () => {
    for (const step of [1, 2]) {
      const text = whatsappForStep(step, { firstName: "Ann" })!;
      expect(text.length).toBeLessThanOrEqual(480);
    }
  });

  /**
   * ⚠️ The last message says it is the last one, and that is the truth rather
   * than a closing technique: the ladder stops at step 3. A "just circling
   * back" followed by nothing is what makes the next one ignorable.
   */
  it("says the final email is the final one", () => {
    const mail = emailStepThree({ firstName: "Ann" });
    expect(mail.paragraphs.join(" ").toLowerCase()).toContain("last");
  });

  it("never promises a price or a volume we have not measured", () => {
    // §51.11 had to strip exactly this kind of claim out of three published
    // pages. Nothing in a cold chase may quote a number.
    const all = [
      whatsappForStep(1, { firstName: "Ann" }),
      whatsappForStep(2, { firstName: "Ann" }),
      ...emailForStep(1, { firstName: "Ann" })!.paragraphs,
      ...emailStepThree({ firstName: "Ann" }).paragraphs,
    ].join(" ");
    expect(all).not.toMatch(/£\s*\d/);
    expect(all).not.toMatch(/\d+\s*%/);
    expect(all).not.toMatch(/guarantee/i);
  });
});
