/**
 * The admin reading of every monthly batch review (§73). Pure: the page fetches
 * the rows and this decides every figure, so the arithmetic is testable under
 * vitest's pure-units rule (the retention.ts split, §70).
 *
 * ⚠️ CONVERSION IS COUNTED OVER ANSWERED BATCHES ONLY. A batch nobody answered
 * says nothing about the leads in it, only about the customer, and folding it
 * in at zero would read as every lead in it having gone nowhere. Unanswered
 * batches show up in the response rate instead, which is where they belong.
 */
import { countAnswers, rate, type BatchCounts } from "./metrics";
import type { BatchAnswer, DeadReason, LeadTypeKey } from "./answers";
import { shortfallCause, isShortfall, type ShortfallCause, type ShortfallSnapshot } from "./shortfall";

export interface AdminReview extends ShortfallSnapshot {
  id: string;
  customer_id: string;
  lead_type: LeadTypeKey;
  survey_sent_at: string | null;
  submitted_at: string | null;
  quality_rating: number | null;
  comment: string | null;
}

export interface AdminItem {
  review_id: string;
  answer: BatchAnswer | null;
  dead_reason: DeadReason | null;
  postcode_area: string | null;
}

export interface ResponseRow {
  customerId: string;
  sent: number;
  submitted: number;
  rate: number | null;
  avgDaysToSubmit: number | null;
}

export function responseByCustomer(reviews: AdminReview[]): ResponseRow[] {
  const by = new Map<string, { sent: number; submitted: number; days: number[] }>();
  for (const r of reviews) {
    if (!r.survey_sent_at) continue;
    const row = by.get(r.customer_id) ?? { sent: 0, submitted: 0, days: [] };
    row.sent += 1;
    if (r.submitted_at) {
      row.submitted += 1;
      const d = (Date.parse(r.submitted_at) - Date.parse(r.survey_sent_at)) / 86_400_000;
      if (Number.isFinite(d) && d >= 0) row.days.push(d);
    }
    by.set(r.customer_id, row);
  }
  return Array.from(by.entries())
    .map(([customerId, v]) => ({
      customerId,
      sent: v.sent,
      submitted: v.submitted,
      rate: rate(v.submitted, v.sent),
      avgDaysToSubmit: v.days.length ? v.days.reduce((a, b) => a + b, 0) / v.days.length : null,
    }))
    .sort((a, b) => (a.rate ?? -1) - (b.rate ?? -1) || b.sent - a.sent);
}

export interface ConversionRow {
  key: string;
  leadType: LeadTypeKey;
  counts: BatchCounts;
}

function groupConversion(
  reviews: AdminReview[],
  items: AdminItem[],
  keyOf: (r: AdminReview, i: AdminItem) => string
): ConversionRow[] {
  const submitted = new Map(reviews.filter((r) => r.submitted_at).map((r) => [r.id, r]));
  const groups = new Map<string, { leadType: LeadTypeKey; answers: (BatchAnswer | null)[] }>();
  for (const i of items) {
    const r = submitted.get(i.review_id);
    if (!r) continue;
    const key = `${r.lead_type}|${keyOf(r, i)}`;
    const g = groups.get(key) ?? { leadType: r.lead_type, answers: [] };
    g.answers.push(i.answer);
    groups.set(key, g);
  }
  return Array.from(groups.entries())
    .map(([key, g]) => ({
      key: key.split("|")[1],
      leadType: g.leadType,
      // Every item in an answered batch is a lead delivered, answered or not.
      counts: countAnswers(g.answers.length, g.answers),
    }))
    .sort((a, b) => a.leadType.localeCompare(b.leadType) || b.counts.delivered - a.counts.delivered);
}

export function conversionByArea(reviews: AdminReview[], items: AdminItem[]): ConversionRow[] {
  return groupConversion(reviews, items, (_r, i) => i.postcode_area ?? "Unknown");
}

/** By the month the batch ENDED in (YYYY-MM), newest first. */
export function conversionByMonth(reviews: AdminReview[], items: AdminItem[]): ConversionRow[] {
  return groupConversion(reviews, items, (r) => r.cycle_end.slice(0, 7)).sort(
    (a, b) => a.leadType.localeCompare(b.leadType) || b.key.localeCompare(a.key)
  );
}

export interface ReasonRow {
  key: string;
  total: number;
  byReason: Partial<Record<DeadReason, number>>;
  /** Went nowhere, with no reason given. */
  unexplained: number;
}

function groupReasons(
  reviews: AdminReview[],
  items: AdminItem[],
  keyOf: (r: AdminReview, i: AdminItem) => string
): ReasonRow[] {
  const byId = new Map(reviews.map((r) => [r.id, r]));
  const groups = new Map<string, ReasonRow>();
  for (const i of items) {
    if (i.answer !== "no_answer" && i.answer !== "not_interested") continue;
    const r = byId.get(i.review_id);
    if (!r) continue;
    const key = keyOf(r, i);
    const g = groups.get(key) ?? { key, total: 0, byReason: {}, unexplained: 0 };
    g.total += 1;
    if (i.dead_reason) g.byReason[i.dead_reason] = (g.byReason[i.dead_reason] ?? 0) + 1;
    else g.unexplained += 1;
    groups.set(key, g);
  }
  return Array.from(groups.values()).sort((a, b) => b.total - a.total);
}

export function reasonsByArea(reviews: AdminReview[], items: AdminItem[]): ReasonRow[] {
  return groupReasons(reviews, items, (_r, i) => i.postcode_area ?? "Unknown");
}

export function reasonsByMonth(reviews: AdminReview[], items: AdminItem[]): ReasonRow[] {
  return groupReasons(reviews, items, (r) => r.cycle_end.slice(0, 7)).sort((a, b) => b.key.localeCompare(a.key));
}

export interface ShortfallRow {
  reviewId: string;
  customerId: string;
  leadType: LeadTypeKey;
  cycleEnd: string;
  allocation: number;
  delivered: number;
  owed: number;
  cause: ShortfallCause;
}

export function shortfallLog(reviews: AdminReview[]): ShortfallRow[] {
  return reviews
    .filter((r) => isShortfall(r))
    .map((r) => ({
      reviewId: r.id,
      customerId: r.customer_id,
      leadType: r.lead_type,
      cycleEnd: r.cycle_end,
      allocation: r.allocation,
      delivered: r.delivered,
      owed: r.balance_at_reset,
      cause: shortfallCause(r),
    }))
    .sort((a, b) => b.cycleEnd.localeCompare(a.cycleEnd));
}
