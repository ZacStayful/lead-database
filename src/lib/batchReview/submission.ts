/**
 * Checking a submitted batch review before anything is written (§73). Pure.
 *
 * ⚠️ THIS IS A PUBLIC WRITE. The one-tap link needs no session, so the payload
 * is checked against a closed vocabulary and a length cap. It names rows by
 * item id only, and every id must belong to the review the token opened. A
 * request can therefore never touch a lead outside that customer's batch
 * (§46.10's rule for unauthenticated writes).
 *
 * ⚠️ NO SKIPPING (§50.2). Every row the customer can edit must be answered. A
 * skipped row leaves a hole in the figures exactly where they matter, and with
 * prefill plus "Not called yet" an honest answer is always one tap.
 */
import {
  COMMENT_MAX,
  asksForReason,
  isAnswerFor,
  isDeadReason,
  type BatchAnswer,
  type DeadReason,
  type LeadTypeKey,
} from "./answers";

export interface EditableItem {
  id: string;
  editable: boolean;
}

export interface CleanAnswer {
  itemId: string;
  answer: BatchAnswer;
  deadReason: DeadReason | null;
}

export interface CleanSubmission {
  answers: CleanAnswer[];
  qualityRating: number | null;
  comment: string | null;
}

export type SubmissionVerdict =
  | { ok: true; value: CleanSubmission }
  | { ok: false; error: string };

export function validateSubmission(
  leadType: LeadTypeKey,
  items: EditableItem[],
  raw: unknown
): SubmissionVerdict {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Nothing was sent." };
  const body = raw as { answers?: unknown; quality_rating?: unknown; comment?: unknown };
  if (!Array.isArray(body.answers)) return { ok: false, error: "Nothing was sent." };

  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Map<string, CleanAnswer>();
  for (const entry of body.answers) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "That answer could not be read." };
    const e = entry as { item_id?: unknown; answer?: unknown; dead_reason?: unknown };
    if (typeof e.item_id !== "string" || !byId.has(e.item_id)) {
      return { ok: false, error: "One of those leads is not in this batch." };
    }
    const item = byId.get(e.item_id)!;
    // A settled lead is read-only. An answer sent for one is ignored rather
    // than refused, so a stale tab cannot block the rest of the batch.
    if (!item.editable) continue;
    if (!isAnswerFor(leadType, e.answer)) {
      return { ok: false, error: "One of those answers is not one we recognise." };
    }
    let deadReason: DeadReason | null = null;
    if (e.dead_reason != null && e.dead_reason !== "") {
      if (!isDeadReason(e.dead_reason)) {
        return { ok: false, error: "One of those reasons is not one we recognise." };
      }
      // A reason only means something for a lead that went nowhere.
      deadReason = asksForReason(e.answer) ? e.dead_reason : null;
    }
    seen.set(e.item_id, { itemId: e.item_id, answer: e.answer, deadReason });
  }

  const missing = items.filter((i) => i.editable && !seen.has(i.id)).length;
  if (missing > 0) {
    return {
      ok: false,
      error: `Please answer every lead first. ${missing} still ${missing === 1 ? "needs" : "need"} an answer.`,
    };
  }

  let qualityRating: number | null = null;
  if (body.quality_rating != null && body.quality_rating !== "") {
    const n = Number(body.quality_rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return { ok: false, error: "The rating must be between 1 and 5." };
    }
    qualityRating = n;
  }

  let comment: string | null = null;
  if (body.comment != null) {
    if (typeof body.comment !== "string") return { ok: false, error: "The comment could not be read." };
    const trimmed = body.comment.trim();
    if (trimmed.length > COMMENT_MAX) {
      return { ok: false, error: `Please keep the comment under ${COMMENT_MAX} characters.` };
    }
    comment = trimmed.length > 0 ? trimmed : null;
  }

  return { ok: true, value: { answers: Array.from(seen.values()), qualityRating, comment } };
}
