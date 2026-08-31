import { describe, expect, it } from "vitest";
import {
  AFTER_LAST_ATTEMPT,
  BOOKED_MEETING_RATE_PCT,
  COLD_CALL_ANSWER_PCT,
  CONTACT_ATTEMPTS,
  RESPONDER_SHARE_BY_FIFTH_PCT,
  SPEED_RULE,
  TOTAL_ATTEMPTS,
  WARMED_CALL_ANSWER_PCT_MAX,
  attemptByNumber,
  attemptsForLead,
  channelLabel,
  eventTypeForChannel,
  firstAttemptChannel,
} from "@/lib/contact/contactStrategy";
import { dueAtForStep } from "@/lib/messaging/cadence";

describe("the sequence", () => {
  it("is five attempts, numbered 1..5 in order", () => {
    expect(TOTAL_ATTEMPTS).toBe(5);
    expect(CONTACT_ATTEMPTS.map((a) => a.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it("opens with a COLD CALL — the finding the intuitive order gets wrong", () => {
    expect(CONTACT_ATTEMPTS[0].channel).toBe("call");
    expect(CONTACT_ATTEMPTS[0].delayDays).toBe(0);
  });

  it("puts the message second, on the same day", () => {
    expect(CONTACT_ATTEMPTS[1].channel).toBe("whatsapp");
    expect(CONTACT_ATTEMPTS[1].delayDays).toBe(0);
  });

  it("lands on cumulative days 0, 0, 2, 5, 9", () => {
    let total = 0;
    const cumulative = CONTACT_ATTEMPTS.map((a) => (total += a.delayDays));
    expect(cumulative).toEqual([0, 0, 2, 5, 9]);
  });

  it("never calls twice in a row", () => {
    for (let i = 1; i < CONTACT_ATTEMPTS.length; i += 1) {
      if (CONTACT_ATTEMPTS[i].channel === "call") {
        expect(CONTACT_ATTEMPTS[i - 1].channel).not.toBe("call");
      }
    }
  });

  it("gives every attempt an objective rather than a script", () => {
    for (const a of CONTACT_ATTEMPTS) {
      expect(a.objective.trim().length).toBeGreaterThan(20);
      // A script would be addressed to the landlord; an objective is an
      // instruction to the operator.
      expect(a.objective).not.toMatch(/^"|^Hi\b/);
    }
  });

  it("mixes all three channels", () => {
    const channels = new Set(CONTACT_ATTEMPTS.map((a) => a.channel));
    expect(channels).toEqual(new Set(["call", "whatsapp", "email"]));
  });

  it("resolves an attempt by number, and nothing past the end", () => {
    expect(attemptByNumber(1)?.channel).toBe("call");
    expect(attemptByNumber(5)?.number).toBe(5);
    expect(attemptByNumber(6)).toBeNull();
    expect(attemptByNumber(0)).toBeNull();
  });
});

describe("the schedule agrees with cadence.ts", () => {
  // The stored plan uses `delay_days` from the previous step, so the same
  // numbers must drive dueAtForStep or the timeline and the scheduler disagree.
  const steps = CONTACT_ATTEMPTS.map((a) => ({
    step_number: a.number,
    delay_days: a.delayDays,
  }));

  it("walks 0, 0, 2, 5, 9 days from enrolment", () => {
    let at = new Date("2026-09-02T09:00:00Z");
    const days: number[] = [];
    const start = at.getTime();
    for (const a of CONTACT_ATTEMPTS) {
      const due = dueAtForStep(at, steps, a.number);
      expect(due).not.toBeNull();
      at = due as Date;
      days.push(Math.round((at.getTime() - start) / 86_400_000));
    }
    expect(days).toEqual([0, 0, 2, 5, 9]);
  });

  it("holds the London wall clock across the October DST boundary", () => {
    // BST -> GMT falls on 25 Oct 2026. Adding milliseconds would shift the hour.
    const from = new Date("2026-10-23T08:00:00Z"); // 09:00 BST
    const due = dueAtForStep(from, steps, 4); // +3 calendar days, into GMT
    const london = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(due as Date);
    expect(london).toBe("09");
  });

  it("holds the London wall clock across the March DST boundary", () => {
    // GMT -> BST falls on 29 Mar 2026.
    const from = new Date("2026-03-27T09:00:00Z"); // 09:00 GMT
    const due = dueAtForStep(from, steps, 4); // +3 calendar days, into BST
    const london = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(due as Date);
    expect(london).toBe("09");
  });
});

describe("the landlord's stated preference overrides attempt 1 only", () => {
  it("leads with email when they asked for email", () => {
    const a = attemptsForLead("email");
    expect(a[0].channel).toBe("email");
    expect(a[0].objective).toContain("asked to be contacted by email");
  });

  it("leads with WhatsApp when they asked for WhatsApp", () => {
    expect(attemptsForLead("whatsapp")[0].channel).toBe("whatsapp");
  });

  it("keeps the cold call for 'phone', for null, and for an unknown value", () => {
    expect(firstAttemptChannel("phone")).toBe("call");
    expect(firstAttemptChannel(null)).toBe("call");
    expect(firstAttemptChannel(undefined)).toBe("call");
    expect(firstAttemptChannel("carrier pigeon")).toBe("call");
  });

  it("changes NOTHING after attempt 1 — a landlord who asked for email has not asked never to be rung", () => {
    const overridden = attemptsForLead("email");
    expect(overridden.slice(1)).toEqual(
      CONTACT_ATTEMPTS.slice(1).map((a) => ({ ...a }))
    );
  });

  it("leaves the default sequence object untouched", () => {
    attemptsForLead("email");
    expect(CONTACT_ATTEMPTS[0].channel).toBe("call");
  });
});

describe("channel helpers", () => {
  it("labels each channel", () => {
    expect(channelLabel("call")).toBe("Call");
    expect(channelLabel("whatsapp")).toBe("WhatsApp");
    expect(channelLabel("email")).toBe("Email");
  });

  it("maps each channel to the event a click on it produces", () => {
    expect(eventTypeForChannel("call")).toBe("tel_click");
    expect(eventTypeForChannel("whatsapp")).toBe("whatsapp_click");
    expect(eventTypeForChannel("email")).toBe("mailto_click");
  });
});

describe("the two claims that must never ship", () => {
  // Everything a customer could be shown, in one bag.
  const copy = [
    ...CONTACT_ATTEMPTS.map((a) => `${a.objective} ${a.why ?? ""}`),
    SPEED_RULE,
    AFTER_LAST_ATTEMPT,
  ]
    .join(" ")
    .toLowerCase();

  it("makes no attendance or show-up claim", () => {
    // The 83% figure is confounded by Calendly's own three reminders and
    // describes its dunning rather than this strategy.
    expect(copy).not.toMatch(/attend|show[- ]?up|turn(ed)? up|no[- ]show|83/);
  });

  it("attaches NO percentage to the speed rule", () => {
    expect(SPEED_RULE).not.toMatch(/\d/);
    expect(SPEED_RULE.toLowerCase()).toContain("day the lead arrives");
  });

  it("keeps the measured figures as plain numbers, so callers must caveat them", () => {
    expect(BOOKED_MEETING_RATE_PCT).toBe(77);
    expect(RESPONDER_SHARE_BY_FIFTH_PCT).toBe(89);
    expect(COLD_CALL_ANSWER_PCT).toBe(17);
    expect(WARMED_CALL_ANSWER_PCT_MAX).toBe(4);
    // The cold-call finding is only meaningful as a contrast.
    expect(COLD_CALL_ANSWER_PCT).toBeGreaterThan(WARMED_CALL_ANSWER_PCT_MAX);
  });

  it("de-prioritises rather than discarding", () => {
    expect(AFTER_LAST_ATTEMPT.toLowerCase()).toContain("de-prioritised");
    expect(AFTER_LAST_ATTEMPT.toLowerCase()).not.toMatch(/delete|discard|remove/);
  });
});
