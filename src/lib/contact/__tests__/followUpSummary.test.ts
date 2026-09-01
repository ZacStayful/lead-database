import { describe, expect, it } from "vitest";
import {
  describeChannels,
  summariseDay,
  summarySms,
  summarySubject,
  worthSending,
  type DueAttempt,
} from "@/lib/contact/followUpSummary";
import type { ContactChannel } from "@/lib/contact/contactStrategy";

const at = (channel: ContactChannel, overdueDays = 0, n = 1): DueAttempt[] =>
  Array.from({ length: n }, (_, i) => ({
    assignmentId: `a${channel}${i}`,
    leadId: `l${i}`,
    leadName: "A Landlord",
    channel,
    stepNumber: 1,
    overdueDays,
  }));

describe("summariseDay", () => {
  it("counts by channel in the order the sequence uses them", () => {
    const s = summariseDay([...at("email", 0, 1), ...at("whatsapp", 0, 2), ...at("call", 0, 4)]);
    expect(s.total).toBe(7);
    expect(s.byChannel.map((b) => b.channel)).toEqual(["call", "whatsapp", "email"]);
    expect(s.byChannel.map((b) => b.count)).toEqual([4, 2, 1]);
  });

  it("counts overdue separately from due today", () => {
    const s = summariseDay([...at("call", 0, 3), ...at("call", 4, 2)]);
    expect(s.total).toBe(5);
    expect(s.overdue).toBe(2);
  });

  it("never claims under a minute", () => {
    expect(summariseDay(at("whatsapp")).minutes).toBe(1);
  });

  it("weights a call heavier than a tap", () => {
    expect(summariseDay(at("call", 0, 4)).minutes).toBeGreaterThan(
      summariseDay(at("whatsapp", 0, 4)).minutes
    );
  });

  it("is empty for an empty day", () => {
    const s = summariseDay([]);
    expect(s.total).toBe(0);
    expect(s.byChannel).toEqual([]);
  });
});

describe("describeChannels", () => {
  it("reads as a sentence, with the Oxford-free 'and'", () => {
    const s = summariseDay([...at("call", 0, 4), ...at("whatsapp", 0, 2), ...at("email", 0, 1)]);
    expect(describeChannels(s)).toBe("4 calls, 2 whatsapps and 1 email");
  });

  it("gets the singular right", () => {
    expect(describeChannels(summariseDay(at("call")))).toBe("1 call");
  });

  it("says nothing when there is nothing", () => {
    expect(describeChannels(summariseDay([]))).toBe("");
  });
});

describe("the subject line", () => {
  it("⚠️ names the COUNT and the TIME, not just that work exists", () => {
    const subject = summarySubject(summariseDay(at("call", 0, 3)));
    expect(subject).toMatch(/^3 follow-ups today/);
    expect(subject).toMatch(/\d+ minutes?/);
    // The shape of every ignorable notification ever sent.
    expect(subject.toLowerCase()).not.toContain("waiting");
    expect(subject.toLowerCase()).not.toContain("reminder");
  });

  it("gets the singular right", () => {
    expect(summarySubject(summariseDay(at("whatsapp")))).toBe(
      "1 follow-up today — about 1 minute"
    );
  });
});

describe("the SMS", () => {
  const url = "https://leads.stayful.co.uk/dashboard/leads";

  it("fits one segment and carries the link", () => {
    const sms = summarySms(summariseDay([...at("call", 0, 4), ...at("whatsapp", 0, 2)]), url);
    expect(sms).toContain(url);
    expect(sms.length).toBeLessThanOrEqual(160);
  });

  it("mentions arrears only when there are some", () => {
    expect(summarySms(summariseDay(at("call", 0, 2)), url)).not.toContain("overdue");
    expect(summarySms(summariseDay(at("call", 3, 2)), url)).toContain("2 overdue");
  });

  it("stays inside one segment even on a heavy day", () => {
    const heavy = summariseDay([...at("call", 2, 40), ...at("whatsapp", 1, 30), ...at("email", 0, 20)]);
    expect(summarySms(heavy, url).length).toBeLessThanOrEqual(160);
  });
});

describe("⚠️ nothing is sent on an empty day", () => {
  it("refuses a zero day", () => {
    expect(worthSending(summariseDay([]))).toBe(false);
  });

  it("sends when there is even one", () => {
    expect(worthSending(summariseDay(at("call")))).toBe(true);
  });
});
