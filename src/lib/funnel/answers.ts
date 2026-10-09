import { BRIEF_COPY, BRIEF_GROSS_OPTIONS } from "@/lib/leadBrief/briefCopy";
import { FUNNEL_COPY } from "@/lib/funnel/copy";
import { MAX_EXTRA_AREAS, MAX_SIMILAR_AREAS_IN } from "@/lib/leadBrief/briefRequest";
import { parseBasePostcode } from "@/lib/leadBrief/input";
import { MAX_MIN_BEDROOMS, TRAVEL_LIMIT_OPTIONS, isBriefPlan, type BriefPlan, type TravelLimit } from "@/lib/leadBrief/plans";
import { FUNNEL_STEPS, type FunnelStep } from "@/lib/funnel/session";

/**
 * The funnel's saved answers (batch 02 Phase 3): what the visitor has told us
 * so far, saved after every question so the link resumes where they stopped.
 *
 * funnel_sessions.answers (0165) holds two shapes over a journey: the raw,
 * partial answers this module writes while the visitor is still on the
 * questions, and the normalised brief the preview route writes
 * (`funnelAnswers`). Both are read here, field by field, and never trusted as
 * a whole: 0165's own comment names this file as the place the shape is
 * checked.
 *
 * ⚠️ A KEY THAT IS ABSENT MEANS "NOT ANSWERED YET"; A KEY THAT IS NULL IS AN
 * ANSWER. `travelLimitMiles: null` is "Anywhere" and `minBedrooms: null` is
 * "No, show me everything". Collapsing the two would resume a visitor who
 * chose "Anywhere" on the travel question, as though they had never seen it.
 *
 * Pure: no reads and no writes. The route does the I/O.
 */

export interface FunnelDraft {
  basePostcode?: string;
  priorityOutcodes?: string[];
  travelLimitMiles?: TravelLimit;
  minBedrooms?: number | null;
  minGross?: number | null;
  similarAreas?: string[];
}

/** Each limit mirrors what parseBriefBody would let through, so a saved draft always previews. */
const MAX_POSTCODE_CHARS = 16;
const MAX_AREA_CHARS = 12;

function areaList(v: unknown, max: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") return null;
    const t = x.trim().slice(0, MAX_AREA_CHARS);
    if (t !== "") out.push(t);
  }
  return out.length > max ? null : out;
}

function isTravel(v: unknown): v is TravelLimit {
  return v === null || (TRAVEL_LIMIT_OPTIONS as readonly unknown[]).includes(v);
}

function isBedrooms(v: unknown): v is number | null {
  return v === null || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_MIN_BEDROOMS);
}

function isGross(v: unknown): v is number | null {
  return v === null || (BRIEF_GROSS_OPTIONS as readonly unknown[]).includes(v);
}

/**
 * The stored answers, read one field at a time. A field of the wrong shape is
 * dropped (treated as unanswered) rather than failing the page: the visitor is
 * asked that question again, which is the honest outcome.
 */
export function readStoredAnswers(raw: unknown): FunnelDraft {
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: FunnelDraft = {};
  if (typeof a.basePostcode === "string" && a.basePostcode.trim() !== "") {
    out.basePostcode = a.basePostcode.trim().slice(0, MAX_POSTCODE_CHARS);
  }
  const extra = "priorityOutcodes" in a ? areaList(a.priorityOutcodes, MAX_EXTRA_AREAS) : null;
  if (extra) out.priorityOutcodes = extra;
  if ("travelLimitMiles" in a && isTravel(a.travelLimitMiles)) out.travelLimitMiles = a.travelLimitMiles;
  if ("minBedrooms" in a && isBedrooms(a.minBedrooms)) out.minBedrooms = a.minBedrooms;
  if ("minGross" in a && isGross(a.minGross)) out.minGross = a.minGross;
  const similar = "similarAreas" in a ? areaList(a.similarAreas, MAX_SIMILAR_AREAS_IN) : null;
  if (similar) out.similarAreas = similar;
  return out;
}

/* ------------------------------------------------------------------ *
 * POST /api/funnel/[token]/answers — what the browser may save
 * ------------------------------------------------------------------ */

export interface AnswersPatch {
  answers: FunnelDraft;
  plan: BriefPlan | null;
  /** The visitor pressed "See your preview" on the third question. */
  questionsDone: boolean;
}

export type ParsedAnswersPatch =
  | { ok: true; value: AnswersPatch }
  | { ok: false; field: string };

/**
 * A closed set of named fields (the §27.1 rule). A field that is present must
 * be of its right shape, or the whole save is refused with the field named:
 * unlike `readStoredAnswers`, this is the moment to say so rather than drop it.
 * A field that is absent is left as stored.
 *
 * The postcode is held raw here and judged by the preview route, which has
 * the one validator (normaliseBriefInput) and the issue codes the screens
 * already know how to show.
 */
export function parseAnswersPatch(body: unknown): ParsedAnswersPatch {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const answers: FunnelDraft = {};

  if ("basePostcode" in b) {
    if (typeof b.basePostcode !== "string") return { ok: false, field: "basePostcode" };
    const t = b.basePostcode.trim();
    if (t === "" || t.length > MAX_POSTCODE_CHARS) return { ok: false, field: "basePostcode" };
    answers.basePostcode = t;
  }
  if ("priorityOutcodes" in b) {
    const list = areaList(b.priorityOutcodes, MAX_EXTRA_AREAS);
    if (!list) return { ok: false, field: "priorityOutcodes" };
    answers.priorityOutcodes = list;
  }
  if ("travelLimitMiles" in b) {
    if (!isTravel(b.travelLimitMiles)) return { ok: false, field: "travelLimitMiles" };
    answers.travelLimitMiles = b.travelLimitMiles;
  }
  if ("minBedrooms" in b) {
    if (!isBedrooms(b.minBedrooms)) return { ok: false, field: "minBedrooms" };
    answers.minBedrooms = b.minBedrooms;
  }
  if ("minGross" in b) {
    if (!isGross(b.minGross)) return { ok: false, field: "minGross" };
    answers.minGross = b.minGross;
  }

  let plan: BriefPlan | null = null;
  if ("plan" in b) {
    if (!isBriefPlan(b.plan)) return { ok: false, field: "plan" };
    plan = b.plan;
  }
  if ("questionsDone" in b && typeof b.questionsDone !== "boolean") return { ok: false, field: "questionsDone" };

  return { ok: true, value: { answers, plan, questionsDone: b.questionsDone === true } };
}

/** The stored answers with the patch laid over them, field by field. */
export function mergeAnswers(stored: FunnelDraft, patch: FunnelDraft): FunnelDraft {
  return { ...stored, ...patch };
}

/**
 * 02 Phase 2's lock, applied to a save: once a postcode has been previewed, a
 * save naming a different one is refused. Compared in canonical form, so
 * "yo105dd" against a locked "YO10 5DD" is the same postcode; a postcode that
 * will not parse at all is not the locked one, so it is refused too.
 */
export function answersLockRefuses(locked: string | null | undefined, rawPostcode: string | undefined): boolean {
  if (!locked || rawPostcode === undefined) return false;
  const canonical = parseBasePostcode(rawPostcode)?.basePostcode ?? null;
  return canonical !== locked;
}

/* ------------------------------------------------------------------ *
 * Resume
 * ------------------------------------------------------------------ */

export type FunnelScreen = "q1" | "q2" | "q3" | "preview" | "why" | "plan";

function reached(step: FunnelStep, target: FunnelStep): boolean {
  return FUNNEL_STEPS.indexOf(step) >= FUNNEL_STEPS.indexOf(target);
}

/**
 * Where a returning visitor lands (02 Phase 3: "returning to the link resumes
 * where they stopped").
 *
 * The preview is only resumed when a snapshot exists to show. Somebody who
 * reached checkout lands back on the plan screen, with the plan they chose.
 * Otherwise the first question not yet answered, so nobody is asked a
 * question twice and nobody skips one.
 */
export function resumeScreen(args: {
  draft: FunnelDraft;
  step: FunnelStep;
  hasPreview: boolean;
}): FunnelScreen {
  const { draft, step, hasPreview } = args;
  if (hasPreview && reached(step, "checkout_started")) return "plan";
  if (hasPreview && reached(step, "previewed")) return "preview";
  if (!draft.basePostcode) return "q1";
  if (!("travelLimitMiles" in draft)) return "q2";
  return "q3";
}

/* ------------------------------------------------------------------ *
 * The discount shown on the plan screen
 * ------------------------------------------------------------------ */

export interface DiscountRow {
  promo_code_string: string;
  expires_at: string;
  redeemed_at: string | null;
}

/**
 * A code is shown only while it can still be used: not redeemed, and not past
 * its 24 hours. Showing a dead code would tell the visitor they have a
 * discount that Stripe will then refuse.
 */
export function validDiscount(
  offer: DiscountRow | null | undefined,
  now: Date
): { code: string; expiresAt: string } | null {
  if (!offer || offer.redeemed_at) return null;
  const expires = new Date(offer.expires_at);
  if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) return null;
  return { code: offer.promo_code_string, expiresAt: expires.toISOString() };
}

/* ------------------------------------------------------------------ *
 * The partner summary's "Their answers"
 * ------------------------------------------------------------------ */

/**
 * The answers as label and value, for the read-only summary (02 Phase 3).
 * Only what the visitor told us about how they work: never their name, email
 * or phone, which the summary page does not even read.
 */
export function answerSummary(
  draft: FunnelDraft,
  fallbackPostcode: string | null
): { label: string; value: string }[] {
  const L = FUNNEL_COPY.answerLabels;
  const travel =
    !("travelLimitMiles" in draft)
      ? FUNNEL_COPY.notAnswered
      : draft.travelLimitMiles === null
        ? FUNNEL_COPY.anywhere
        : FUNNEL_COPY.upToMiles(draft.travelLimitMiles as number);
  const beds =
    !("minBedrooms" in draft)
      ? FUNNEL_COPY.notAnswered
      : draft.minBedrooms === null
        ? FUNNEL_COPY.anyLabel
        : BRIEF_COPY.q3.bedroomsOption(draft.minBedrooms as number);
  const gross =
    !("minGross" in draft)
      ? FUNNEL_COPY.notAnswered
      : draft.minGross === null
        ? FUNNEL_COPY.anyLabel
        : BRIEF_COPY.q3.revenueOption(draft.minGross as number);
  const rows: { label: string; value: string }[] = [
    { label: L.postcode, value: draft.basePostcode ?? fallbackPostcode ?? FUNNEL_COPY.notAnswered },
  ];
  if (draft.priorityOutcodes && draft.priorityOutcodes.length > 0) {
    rows.push({ label: L.otherAreas, value: draft.priorityOutcodes.join(", ") });
  }
  rows.push({ label: L.travel, value: travel }, { label: L.bedrooms, value: beds }, { label: L.revenue, value: gross });
  return rows;
}
