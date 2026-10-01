/**
 * Loading and submitting a monthly batch review (§73). Server-side only.
 *
 * Two doors reach this module, and they meet here so they cannot drift:
 *   - `/review/[token]` with `POST /api/review/[token]`, a one-tap link from
 *     the email, with no session;
 *   - `/dashboard/review/[id]` with `POST /api/customer/batch-review/[id]`,
 *     reached from the dashboard banner, behind the customer's session.
 *
 * ⚠️ OWNERSHIP IS CHECKED ROW BY ROW. An item counts as the customer's only if
 * its assignment still exists AND belongs to the review's customer. Anything
 * else is shown as "no longer in your leads" and can never be written to. The
 * token proves which review this is; it proves nothing about any other row.
 */
import { createHash, createHmac } from "crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import { applyPipelineWrite } from "@/lib/assignmentStage";
import { answersFor, type BatchAnswer, type DeadReason, type LeadTypeKey } from "./answers";
import { pipelineChangeFor, prefillAnswer, readOnlyReason, type ReadOnlyReason } from "./pipeline";
import { validateSubmission } from "./submission";
import { countAnswers, benchmarkReading, type BatchCounts, type BenchmarkReading } from "./metrics";

type Admin = ReturnType<typeof createAdminClient>;

/** SHA-256 hex of the opaque link token. Only the hash is ever stored (the lead_topup_tokens rule). */
export function hashReviewToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * The link token, DERIVED rather than random: an HMAC of the review id and its
 * expiry under MESSAGING_TOKEN_SECRET, domain-separated as `batch-review:` (the
 * landlordReferralToken.ts rule for sharing that secret).
 *
 * ⚠️ Derived because the reminder needs the SAME link and only a hash is stored.
 * A random token would leave the reminder two bad options: rotate the token,
 * which kills the link in the first email the customer may still have open, or
 * send a sign-in link, which loses the one-tap property this exists for.
 *
 * The expiry goes in as epoch seconds. Postgres hands back `+00:00` where JS
 * wrote `.000Z`, and the token must not depend on which spelling it was given.
 *
 * Null when no secret is configured. The cron then sends no survey at all,
 * which fails closed.
 */
export function deriveReviewToken(reviewId: string, expiresAt: string, secret: string | null | undefined): string | null {
  if (!secret) return null;
  const expiry = Math.floor(Date.parse(expiresAt) / 1000);
  if (!Number.isFinite(expiry)) return null;
  return createHmac("sha256", secret).update(`batch-review:${reviewId}:${expiry}`).digest("base64url");
}

export function reviewTokenSecret(): string | null {
  return process.env.MESSAGING_TOKEN_SECRET || null;
}

/** An HMAC-SHA256 as base64url is 43 characters. Anything else is not ours. */
export function looksLikeReviewToken(raw: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(raw);
}

export const REVIEW_COLUMNS =
  "id, customer_id, lead_type, cycle_start, cycle_end, allocation, delivered, balance_at_reset, next_allocation, pool_debit, survey_sent_at, submitted_at, token_expires_at, quality_rating, comment";

export interface ReviewRow {
  id: string;
  customer_id: string;
  lead_type: LeadTypeKey;
  cycle_start: string;
  cycle_end: string;
  allocation: number;
  delivered: number;
  balance_at_reset: number;
  next_allocation: number;
  pool_debit: number;
  survey_sent_at: string | null;
  submitted_at: string | null;
  token_expires_at: string | null;
  quality_rating: number | null;
  comment: string | null;
}

export interface ReviewItemView {
  id: string;
  leadId: string | null;
  assignmentId: string | null;
  name: string;
  postcodeArea: string | null;
  bedrooms: string | null;
  assignedAt: string;
  readOnly: ReadOnlyReason | null;
  /** What the form shows selected: a saved answer first, else the pipeline's. */
  answer: BatchAnswer | null;
  deadReason: DeadReason | null;
}

interface ItemRow {
  id: string;
  assignment_id: string | null;
  lead_id: string | null;
  postcode_area: string | null;
  bedrooms: string | null;
  assigned_at: string;
  answer: BatchAnswer | null;
  dead_reason: DeadReason | null;
  assignment: {
    id: string;
    customer_id: string;
    status: string | null;
    pipeline_stage: string | null;
    closed_at: string | null;
    first_contacted_at: string | null;
  } | null;
  lead: { lead_name: string | null } | null;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

async function loadItemRows(admin: Admin, reviewId: string): Promise<ItemRow[] | null> {
  const { data, error } = await admin
    .from("lead_batch_review_items")
    .select(
      "id, assignment_id, lead_id, postcode_area, bedrooms, assigned_at, answer, dead_reason, assignment:lead_assignments(id, customer_id, status, pipeline_stage, closed_at, first_contacted_at), lead:leads(lead_name)"
    )
    .eq("review_id", reviewId)
    .order("assigned_at", { ascending: true });
  if (error) {
    console.error("[batch-review] items read failed", reviewId, error);
    return null;
  }
  return ((data ?? []) as unknown[]).map((r) => {
    const row = r as ItemRow & { assignment: unknown; lead: unknown };
    return { ...row, assignment: one(row.assignment as ItemRow["assignment"]), lead: one(row.lead as ItemRow["lead"]) };
  });
}

/** An assignment counts only while it exists AND is still this customer's. */
function ownedAssignment(row: ItemRow, customerId: string) {
  return row.assignment && row.assignment.customer_id === customerId ? row.assignment : null;
}

export function toItemView(row: ItemRow, leadType: LeadTypeKey, customerId: string): ReviewItemView {
  const a = ownedAssignment(row, customerId);
  const readOnly = readOnlyReason(a);
  return {
    id: row.id,
    leadId: a ? row.lead_id : null,
    assignmentId: a ? a.id : null,
    name: row.lead?.lead_name?.trim() || "A landlord",
    postcodeArea: row.postcode_area,
    bedrooms: row.bedrooms,
    assignedAt: row.assigned_at,
    readOnly,
    answer: row.answer ?? prefillAnswer(leadType, a),
    deadReason: row.dead_reason,
  };
}

export interface LoadedReview {
  review: ReviewRow;
  items: ReviewItemView[];
}

export async function loadReview(admin: Admin, review: ReviewRow): Promise<LoadedReview | null> {
  const rows = await loadItemRows(admin, review.id);
  if (!rows) return null;
  return { review, items: rows.map((r) => toItemView(r, review.lead_type, review.customer_id)) };
}

export type TokenLookup =
  | { status: "valid"; review: ReviewRow }
  | { status: "expired" }
  | { status: "invalid" };

export async function reviewByToken(admin: Admin, raw: string): Promise<TokenLookup> {
  if (!looksLikeReviewToken(raw)) return { status: "invalid" };
  const { data, error } = await admin
    .from("lead_batch_reviews")
    .select(REVIEW_COLUMNS)
    .eq("token_hash", hashReviewToken(raw))
    .maybeSingle();
  if (error || !data) return { status: "invalid" };
  const review = data as unknown as ReviewRow;
  if (!review.token_expires_at || new Date(review.token_expires_at).getTime() <= Date.now()) {
    return { status: "expired" };
  }
  return { status: "valid", review };
}

/** The session door: by id, and only the signed-in customer's own. */
export async function reviewForCustomer(
  admin: Admin,
  reviewId: string,
  customerId: string
): Promise<ReviewRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) return null;
  const { data } = await admin
    .from("lead_batch_reviews")
    .select(REVIEW_COLUMNS)
    .eq("id", reviewId)
    .eq("customer_id", customerId)
    .not("survey_sent_at", "is", null)
    .maybeSingle();
  return (data as unknown as ReviewRow | null) ?? null;
}

export type SubmitResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Write the answers, then move each lead's pipeline to match.
 *
 * Answers are written first and the pipeline second, so a pipeline failure
 * loses no answer. The pipeline write re-checks the settled-lead guard in the
 * database (assignmentStage.ts), so a lead rejected after the page loaded is
 * still not moved.
 */
export async function submitReview(
  admin: Admin,
  review: ReviewRow,
  payload: unknown
): Promise<SubmitResult> {
  const rows = await loadItemRows(admin, review.id);
  if (!rows) return { ok: false, status: 500, error: "We could not load this batch just now." };

  const verdict = validateSubmission(
    review.lead_type,
    rows.map((r) => ({
      id: r.id,
      editable: readOnlyReason(ownedAssignment(r, review.customer_id)) === null,
    })),
    payload
  );
  if (!verdict.ok) return { ok: false, status: 400, error: verdict.error };

  const now = new Date().toISOString();
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const a of verdict.value.answers) {
    const { error } = await admin
      .from("lead_batch_review_items")
      .update({ answer: a.answer, dead_reason: a.deadReason, answered_at: now })
      .eq("id", a.itemId)
      .eq("review_id", review.id);
    if (error) {
      console.error("[batch-review] answer write failed", a.itemId, error);
      return { ok: false, status: 500, error: "We could not save your answers just now." };
    }
  }

  const { error: reviewError } = await admin
    .from("lead_batch_reviews")
    .update({
      submitted_at: review.submitted_at ?? now,
      quality_rating: verdict.value.qualityRating,
      comment: verdict.value.comment,
      updated_at: now,
    })
    .eq("id", review.id);
  if (reviewError) {
    console.error("[batch-review] review write failed", review.id, reviewError);
    return { ok: false, status: 500, error: "We could not save your answers just now." };
  }

  for (const a of verdict.value.answers) {
    const row = byId.get(a.itemId);
    const owned = row ? ownedAssignment(row, review.customer_id) : null;
    if (!owned) continue;
    const change = pipelineChangeFor(review.lead_type, a.answer, owned);
    if (!change) continue;
    await applyPipelineWrite(admin, owned, change);
  }

  return { ok: true };
}

export interface ReviewResults {
  counts: BatchCounts;
  benchmark: BenchmarkReading;
  lifetimeSigned: number;
  lifetimeReceived: number;
  /** Earlier submitted batches for this product, oldest first. */
  trend: { cycleStart: string; cycleEnd: string; delivered: number; interested: number; meetings: number; signed: number }[];
}

/**
 * What the results panel shows after a submission. Lifetime is measured from
 * the assignments themselves, excluding the customer's own uploads (§30). An
 * uploaded book of existing clients marked won would otherwise "beat" the
 * benchmark on leads we never sold.
 */
export async function reviewResults(
  admin: Admin,
  review: ReviewRow,
  items: ReviewItemView[]
): Promise<ReviewResults> {
  const counts = countAnswers(review.delivered, items.map((i) => i.answer));

  const [received, signed, previous] = await Promise.all([
    admin
      .from("lead_assignments")
      .select("id, lead:leads!inner(lead_type, owner_customer_id)", { count: "exact", head: true })
      .eq("customer_id", review.customer_id)
      .eq("lead.lead_type", review.lead_type)
      .or(`owner_customer_id.is.null,owner_customer_id.neq.${review.customer_id}`, { referencedTable: "lead" }),
    admin
      .from("lead_assignments")
      .select("id, lead:leads!inner(lead_type, owner_customer_id)", { count: "exact", head: true })
      .eq("customer_id", review.customer_id)
      .eq("status", "won")
      .eq("lead.lead_type", review.lead_type)
      .or(`owner_customer_id.is.null,owner_customer_id.neq.${review.customer_id}`, { referencedTable: "lead" }),
    admin
      .from("lead_batch_reviews")
      .select("id, cycle_start, cycle_end, delivered, items:lead_batch_review_items(answer)")
      .eq("customer_id", review.customer_id)
      .eq("lead_type", review.lead_type)
      .not("submitted_at", "is", null)
      .order("cycle_end", { ascending: false })
      .limit(6),
  ]);

  const lifetimeReceived = received.count ?? 0;
  const lifetimeSigned = signed.count ?? 0;
  const trend = ((previous.data ?? []) as unknown as {
    cycle_start: string;
    cycle_end: string;
    delivered: number;
    items: { answer: BatchAnswer | null }[] | null;
  }[])
    .map((r) => {
      const c = countAnswers(r.delivered, (r.items ?? []).map((i) => i.answer));
      return {
        cycleStart: r.cycle_start,
        cycleEnd: r.cycle_end,
        delivered: r.delivered,
        interested: c.interested,
        meetings: c.meetings,
        signed: c.signed,
      };
    })
    .reverse();

  return {
    counts,
    benchmark: benchmarkReading(review.lead_type, lifetimeSigned, lifetimeReceived),
    lifetimeSigned,
    lifetimeReceived,
    trend,
  };
}

/** The labels the form renders, resolved server-side so the client gets plain data. */
export function answerOptionsFor(leadType: LeadTypeKey) {
  return answersFor(leadType);
}
