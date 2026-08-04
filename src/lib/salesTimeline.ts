import type { CaseStudy, CaseStudyEvent } from "@/lib/types";

export type TimelineStage = {
  key: string;
  label: string;
  /** What actually happens at this point. */
  detail: string;
  /** Earliest and latest day this stage occurred across the real cases. */
  dayFrom: number | null;
  dayTo: number | null;
  /** How many cases reached this stage, out of the total. */
  reached: number;
  total: number;
  /** Cases that ended here rather than going further. */
  lostHere: number;
};

export type SalesTimeline = {
  stages: TimelineStage[];
  total: number;
  signed: number;
  lost: number;
  /** Days to signature across the cases that signed. */
  signedFrom: number | null;
  signedTo: number | null;
  /** Days to the end for leads that died before a meeting. */
  preMeetingFrom: number | null;
  preMeetingTo: number | null;
};

function range(values: number[]): [number | null, number | null] {
  if (values.length === 0) return [null, null];
  return [Math.min(...values), Math.max(...values)];
}

/**
 * Derive the sales process, and how long each step takes, from the case
 * studies themselves.
 *
 * Computed rather than written down. The whole point of holding these journeys
 * as data is that the summary cannot drift from the records it summarises —
 * publish a tenth case and every figure on this page moves with it. A
 * hand-written "expect 4 to 12 weeks" is a claim; this is a measurement of the
 * cases actually on display, which is a much smaller thing to defend.
 *
 * Only ever fed PUBLISHED cases, so a customer can check any number here
 * against the journeys underneath it.
 */
export function buildSalesTimeline(
  cases: CaseStudy[],
  eventsByCase: Map<string, CaseStudyEvent[]>
): SalesTimeline {
  const total = cases.length;
  const signedCases = cases.filter((c) => c.outcome === "signed");

  // Day the first outbound estimate went out. Bounded to the first few days
  // because later outbound email is follow-up, not the estimate.
  const estimateDays: number[] = [];
  const meetingDays: number[] = [];
  const offerDays: number[] = [];

  let reachedMeeting = 0;
  let reachedOffer = 0;

  for (const c of cases) {
    const events = eventsByCase.get(c.id) ?? [];

    const estimate = events
      .filter((e) => e.channel === "email" && e.direction === "outbound" && e.day_offset <= 3)
      .map((e) => e.day_offset);
    if (estimate.length > 0) estimateDays.push(Math.min(...estimate));

    const meetings = events
      .filter((e) => e.channel === "web_meeting" && /attended/i.test(e.description))
      .map((e) => e.day_offset);
    if (meetings.length > 0) {
      meetingDays.push(Math.min(...meetings));
      reachedMeeting += 1;
    }

    const offers = events
      .filter((e) => e.channel === "offer" && /offered/i.test(e.description))
      .map((e) => e.day_offset);
    if (offers.length > 0) {
      offerDays.push(Math.min(...offers));
      reachedOffer += 1;
    }
  }

  const [estFrom, estTo] = range(estimateDays);
  const [meetFrom, meetTo] = range(meetingDays);
  const [offerFrom, offerTo] = range(offerDays);
  const [signedFrom, signedTo] = range(signedCases.map((c) => c.days_to_outcome));

  const preMeeting = cases.filter((c) => c.gate_reached === "pre_meeting");
  const [preFrom, preTo] = range(preMeeting.map((c) => c.days_to_outcome));

  const stages: TimelineStage[] = [
    {
      key: "enquiry",
      label: "The enquiry arrives",
      detail:
        "A landlord asks what their property could earn. This part happens without you.",
      dayFrom: 0,
      dayTo: 0,
      reached: total,
      total,
      lostHere: 0,
    },
    {
      key: "estimate",
      label: "The income estimate goes out",
      detail:
        "The figure and the introduction. Still automatic — every lead gets this.",
      dayFrom: estFrom,
      dayTo: estTo,
      reached: total,
      total,
      lostHere: 0,
    },
    {
      key: "meeting",
      label: "The web meeting",
      detail:
        "The first real conversation, and the step everything after it depends on. Getting a time in the diary is the whole job at this point.",
      dayFrom: meetFrom,
      dayTo: meetTo,
      reached: reachedMeeting,
      total,
      lostHere: preMeeting.length,
    },
    {
      key: "offer",
      label: "The offer",
      detail:
        "A reduced rate, usually with a deadline. It only creates urgency in a landlord who is otherwise ready.",
      dayFrom: offerFrom,
      dayTo: offerTo,
      reached: reachedOffer,
      total,
      lostHere: 0,
    },
    {
      key: "signed",
      label: "Signed",
      detail:
        "Weeks of follow-up sit between the offer and this. The signature is not the finish line — onboarding still has to be chased.",
      dayFrom: signedFrom,
      dayTo: signedTo,
      reached: signedCases.length,
      total,
      lostHere: 0,
    },
  ];

  return {
    stages,
    total,
    signed: signedCases.length,
    lost: total - signedCases.length,
    signedFrom,
    signedTo,
    preMeetingFrom: preFrom,
    preMeetingTo: preTo,
  };
}

/** "Day 0", "Day 5–11", or null when no case reached this stage. */
export function stageDays(stage: TimelineStage): string | null {
  if (stage.dayFrom === null || stage.dayTo === null) return null;
  if (stage.dayFrom === stage.dayTo) return `Day ${stage.dayFrom}`;
  return `Day ${stage.dayFrom}–${stage.dayTo}`;
}

/** Weeks, rounded, for the headline. */
export function weeks(days: number): number {
  return Math.max(1, Math.round(days / 7));
}
