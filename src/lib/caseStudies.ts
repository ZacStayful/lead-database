import type {
  CaseStudyChannel,
  CaseStudyConfidence,
  CaseStudyDirection,
  CaseStudyGate,
  CaseStudyLossReason,
  CaseStudyOutcome,
} from "@/lib/types";

export const CASE_OUTCOMES: CaseStudyOutcome[] = ["signed", "lost"];

export const CASE_LOSS_REASONS: CaseStudyLossReason[] = [
  "ghosted_pre_meeting",
  "competitor",
  "numbers_did_not_stack",
  "timing",
];

export const CASE_GATES: CaseStudyGate[] = ["pre_meeting", "meeting_or_after"];

export const CASE_CHANNELS: CaseStudyChannel[] = [
  "form",
  "email",
  "call",
  "sms",
  "web_meeting",
  "offer",
  "telemetry",
  "onboarding",
];

export const CASE_DIRECTIONS: CaseStudyDirection[] = [
  "outbound",
  "inbound",
  "none",
];

export const CASE_CONFIDENCES: CaseStudyConfidence[] = [
  "crm_verified",
  "partly_reconstructed",
];

export const OUTCOME_LABEL: Record<CaseStudyOutcome, string> = {
  signed: "Signed",
  // Not "Lost" and never styled red. Six of the nine ended this way and most
  // were worked correctly — an error colour would teach that a well-run loss is
  // a mistake, which is the opposite of the point.
  lost: "Not signed",
};

export const LOSS_REASON_LABEL: Record<CaseStudyLossReason, string> = {
  ghosted_pre_meeting: "Went quiet before a meeting",
  competitor: "Chose a competitor",
  numbers_did_not_stack: "Numbers did not stack up",
  timing: "Not ready in time",
};

export const GATE_LABEL: Record<CaseStudyGate, string> = {
  pre_meeting: "Before a meeting",
  meeting_or_after: "Meeting or later",
};

export const CHANNEL_LABEL: Record<CaseStudyChannel, string> = {
  form: "Form",
  email: "Email",
  call: "Call",
  sms: "SMS",
  web_meeting: "Web meeting",
  offer: "Offer",
  telemetry: "Telemetry",
  onboarding: "Onboarding",
};

/**
 * A single character per channel, used as the timeline marker.
 *
 * Letters rather than icons: the house style is flat and borderless, and a set
 * of eight icons would be the most decorated thing on the page.
 */
export const CHANNEL_GLYPH: Record<CaseStudyChannel, string> = {
  form: "F",
  email: "E",
  call: "C",
  sms: "S",
  web_meeting: "M",
  offer: "O",
  telemetry: "T",
  onboarding: "N",
};

export const CONFIDENCE_NOTE =
  "Some touchpoints on this record are reconstructed from recollection rather than logged in the CRM.";

/** "Day 0", "Day 11". */
export function dayLabel(dayOffset: number): string {
  return `Day ${dayOffset}`;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidCaseSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function caseSlugFromReference(reference: string): string {
  return reference
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
