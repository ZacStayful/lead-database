import {
  CASE_CHANNELS,
  CASE_CONFIDENCES,
  CASE_DIRECTIONS,
  CASE_GATES,
  CASE_LOSS_REASONS,
  CASE_OUTCOMES,
  isValidCaseSlug,
} from "@/lib/caseStudies";
import type {
  CaseStudyChannel,
  CaseStudyConfidence,
  CaseStudyDirection,
  CaseStudyGate,
  CaseStudyLossReason,
  CaseStudyOutcome,
} from "@/lib/types";

export type CaseStudyWrite = {
  slug: string;
  reference: string;
  outcome: CaseStudyOutcome;
  loss_reason: CaseStudyLossReason | null;
  gate_reached: CaseStudyGate;
  days_to_outcome: number;
  property_summary: string;
  headline: string;
  summary: string;
  lesson_markdown: string | null;
  emails_out: number | null;
  calls_made: number | null;
  calls_answered: number | null;
  inbound_replies: number | null;
  meetings_sat: number | null;
  had_no_show: boolean;
  offer_applied: boolean;
  data_confidence: CaseStudyConfidence;
  sort_order: number;
  is_published: boolean;
};

export type CaseEventWrite = {
  day_offset: number;
  channel: CaseStudyChannel;
  direction: CaseStudyDirection;
  description: string;
  is_setback: boolean;
  is_outcome: boolean;
  sort_order: number;
};

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Validate an admin-submitted case study.
 *
 * There is no name, date, address or postcode field to validate, because there
 * is no such column to write to (migration 0057). Anonymisation is a property
 * of the schema here, not a rule this function enforces.
 */
export function validateCaseStudy(
  body: Record<string, unknown>
): { ok: true; value: CaseStudyWrite } | { ok: false; error: string } {
  const slug = trimmed(body.slug).toLowerCase();
  if (!slug) return { ok: false, error: "Slug is required." };
  if (!isValidCaseSlug(slug)) {
    return {
      ok: false,
      error: "Slug may contain only lowercase letters, numbers and hyphens.",
    };
  }

  const reference = trimmed(body.reference);
  const propertySummary = trimmed(body.property_summary);
  const headline = trimmed(body.headline);
  const summary = trimmed(body.summary);

  if (!reference) return { ok: false, error: "Reference is required." };
  if (!propertySummary) return { ok: false, error: "Property summary is required." };
  if (!headline) return { ok: false, error: "Headline is required." };
  if (!summary) return { ok: false, error: "Summary is required." };

  const outcome = trimmed(body.outcome) as CaseStudyOutcome;
  if (!CASE_OUTCOMES.includes(outcome)) {
    return { ok: false, error: "Outcome must be signed or lost." };
  }

  // Mirrors the table CHECK in both directions, so the admin gets a sentence
  // rather than a constraint name.
  let lossReason: CaseStudyLossReason | null = null;
  if (outcome === "lost") {
    const reason = trimmed(body.loss_reason) as CaseStudyLossReason;
    if (!CASE_LOSS_REASONS.includes(reason)) {
      return { ok: false, error: "A case that did not sign needs a loss reason." };
    }
    lossReason = reason;
  }

  const gate = trimmed(body.gate_reached) as CaseStudyGate;
  if (!CASE_GATES.includes(gate)) {
    return { ok: false, error: "Gate reached is not valid." };
  }

  const confidence = trimmed(body.data_confidence) as CaseStudyConfidence;
  if (!CASE_CONFIDENCES.includes(confidence)) {
    return { ok: false, error: "Data confidence is not valid." };
  }

  const days = nullableInt(body.days_to_outcome);
  if (days === null || days < 0) {
    return { ok: false, error: "Days to outcome must be zero or more." };
  }

  return {
    ok: true,
    value: {
      slug,
      reference,
      outcome,
      loss_reason: lossReason,
      gate_reached: gate,
      days_to_outcome: days,
      property_summary: propertySummary,
      headline,
      summary,
      lesson_markdown: trimmed(body.lesson_markdown) || null,
      emails_out: nullableInt(body.emails_out),
      calls_made: nullableInt(body.calls_made),
      calls_answered: nullableInt(body.calls_answered),
      inbound_replies: nullableInt(body.inbound_replies),
      meetings_sat: nullableInt(body.meetings_sat),
      had_no_show: body.had_no_show === true,
      offer_applied: body.offer_applied === true,
      data_confidence: confidence,
      sort_order: nullableInt(body.sort_order) ?? 0,
      is_published: body.is_published === true,
    },
  };
}

/**
 * Validate the events array that replaces a case study's timeline wholesale.
 *
 * At most one outcome event: two would make "how did this end" ambiguous, and
 * the detail page and comparison table both assume a single ending.
 */
export function validateCaseEvents(
  raw: unknown
): { ok: true; value: CaseEventWrite[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "Events must be a list." };
  }

  const events: CaseEventWrite[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i] as Record<string, unknown>;
    const position = i + 1;

    const dayOffset = nullableInt(row.day_offset);
    if (dayOffset === null || dayOffset < 0) {
      return { ok: false, error: `Event ${position}: day must be zero or more.` };
    }

    const channel = trimmed(row.channel) as CaseStudyChannel;
    if (!CASE_CHANNELS.includes(channel)) {
      return { ok: false, error: `Event ${position}: channel is not valid.` };
    }

    const direction = trimmed(row.direction) as CaseStudyDirection;
    if (!CASE_DIRECTIONS.includes(direction)) {
      return { ok: false, error: `Event ${position}: direction is not valid.` };
    }

    const description = trimmed(row.description);
    if (!description) {
      return { ok: false, error: `Event ${position}: description is required.` };
    }

    events.push({
      day_offset: dayOffset,
      channel,
      direction,
      description,
      is_setback: row.is_setback === true,
      is_outcome: row.is_outcome === true,
      // Position in the submitted array is the order the admin arranged, so it
      // is the ordering that gets stored — within a day, arrival order is the
      // only thing that distinguishes two events.
      sort_order: (i + 1) * 10,
    });
  }

  const outcomes = events.filter((e) => e.is_outcome).length;
  if (outcomes > 1) {
    return {
      ok: false,
      error: "Only one event can be marked as the outcome.",
    };
  }

  return { ok: true, value: events };
}
