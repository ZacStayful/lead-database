/**
 * What the model is told about a lead, and — more importantly — what it is not.
 *
 * ⚠️ THE RULE OF THIS FILE IS THE INVERSE OF presentationSeed.ts. That builder
 * exists to fill a FORM, so its stated contract is that the seed must be
 * complete, and it substitutes TOOL_INCOME_DEFAULTS (gross £60,000, £185 a
 * night, 60% occupancy) for anything the analysis did not state. Handing that to
 * a model would have it tell a landlord their property grosses £60,000 on the
 * strength of a placeholder.
 *
 *   ABSENT IS NULL, AND NULL IS OMITTED. Never a default, ever.
 *
 * Half the live book has no analysis at all (15 of 30 when this was written), so
 * this is not an edge case — it is the common path, and a message with no
 * numbers in it is a perfectly good message.
 *
 * The exclusion list below is the design. Each column is left out for its own
 * reason, and those reasons are why this is a separate file rather than a call
 * to the seed builder.
 */
import { numOrNull } from "@/lib/presentationSeed";

/** Anything longer is somebody's spreadsheet, not a qualification note. */
const MAX_PROFILE_CHARS = 600;

export interface DraftFigures {
  grossAnnual: number | null;
  nightlyRate: number | null;
  occupancyPct: number | null;
}

/**
 * Where in a follow-up ladder this message sits (§40.13).
 *
 * ⚠️ ABSENT MEANS FIRST MESSAGE, and that is the only way to say it. The whole
 * prompt below was written for a cold opener — "open with the landlord's first
 * name", "name the property so it does not read as a scam" — and used unchanged
 * for step 3 it re-introduces the operator to somebody they have already
 * messaged twice. A null here selects the opener; anything else selects the
 * follow-up shape.
 */
export interface DraftStepContext {
  /** 2 for the first follow-up. Step 1 never carries this block. */
  number: number;
  /** What this step is FOR, in the operator's own words. May be null. */
  brief: string | null;
  /**
   * What has already been sent on this thread, oldest first — the model's only
   * defence against repeating itself. Trimmed hard: this is context, not a
   * transcript.
   */
  previous: { text: string; daysAgo: number }[];
}

/**
 * ⚠️ THERE IS DELIBERATELY NO "has the landlord replied" FIELD. A reply STOPS
 * the run (`stopRunsForThread`), so by construction nothing is ever drafted for
 * a conversation that has one — and the sending phase re-checks immediately
 * before it sends, for the reply that lands between the draft and the send. A
 * flag here would be a second, weaker answer to a question already settled, and
 * the first time the two disagreed we would follow up on somebody mid-reply.
 */

export interface DraftContext {
  operator: {
    businessName: string | null;
    contactName: string | null;
    /** The operator's own introduction (§41). Background, never quoted. */
    intro: string | null;
  };
  landlord: { firstName: string | null };
  property: {
    address: string | null;
    bedrooms: string | null;
    profile: string | null;
  };
  /** null means "this property has not been analysed" — not "zero". */
  figures: DraftFigures | null;
  /** null or absent = the first message. See DraftStepContext. */
  step?: DraftStepContext | null;
}

/** Lead columns this builder is allowed to look at. */
export interface DraftLead {
  lead_name?: string | null;
  address?: string | null;
  bedrooms?: string | null;
  lead_profile?: string | null;
  gross_annual_income?: unknown;
  avg_nightly_rate?: unknown;
  occupancy_rate?: unknown;
}

export interface DraftCustomer {
  business_name?: string | null;
  contact_name?: string | null;
  /** §41. Fenced in the prompt — see renderDraftPrompt. */
  operator_intro?: string | null;
}

/** "Mark Henderson" -> "Mark". Anything unusable becomes null, not a guess. */
export function firstNameOf(fullName: string | null | undefined): string | null {
  const first = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  if (first.length < 2 || first.length > 40) return null;
  if (!/[a-z]/i.test(first)) return null;
  return first;
}

/**
 * ⚠️ `lead` MUST already have been through viewerScopedLead().
 *
 * On a marketplace lead `lead_profile` is Stayful's qualification blurb and is
 * the best material here. On an IMPORTED one it is whatever the uploader's
 * spreadsheet had left over — margins, source attribution, "will take 12%,
 * spoke to Dave". On a RESOLD lead, passing it through unscoped would have the
 * model paraphrase another operator's private commercial notes into a WhatsApp
 * to the landlord. The route scopes it; this signature is the reminder.
 */
export function buildDraftContext(p: {
  lead: DraftLead;
  customer: DraftCustomer;
  step?: DraftStepContext | null;
}): DraftContext {
  const gross = numOrNull(p.lead.gross_annual_income);
  const nightly = numOrNull(p.lead.avg_nightly_rate);
  const occupancy = numOrNull(p.lead.occupancy_rate);

  // All-or-nothing on the block: one lonely figure with no context invites the
  // model to reach for the others, and there is nowhere for it to reach.
  const anyFigure = gross !== null || nightly !== null || occupancy !== null;

  return {
    operator: {
      businessName: p.customer.business_name?.trim() || null,
      contactName: p.customer.contact_name?.trim() || null,
      // Capped like the property profile: a long intro would crowd out the
      // property, which is what the message is actually about.
      intro: p.customer.operator_intro?.trim().slice(0, MAX_PROFILE_CHARS) || null,
    },
    landlord: { firstName: firstNameOf(p.lead.lead_name) },
    property: {
      address: p.lead.address?.trim() || null,
      bedrooms: p.lead.bedrooms?.trim() || null,
      profile: p.lead.lead_profile?.trim().slice(0, MAX_PROFILE_CHARS) || null,
    },
    figures: anyFigure
      ? { grossAnnual: gross, nightlyRate: nightly, occupancyPct: occupancy }
      : null,
    step: p.step ?? null,
  };
}

/**
 * The user half of the prompt.
 *
 * ⚠️ Assert against THIS STRING in tests, not against the context object. The
 * object being clean is not the same claim as the prompt being clean, and the
 * seam between the two is exactly where §25's report bug lived.
 */
export function renderDraftPrompt(ctx: DraftContext): string {
  const lines: string[] = [];

  const who = [ctx.operator.contactName, ctx.operator.businessName]
    .filter(Boolean)
    .join(", ");
  if (who) lines.push(`OPERATOR: ${who}`);
  if (ctx.landlord.firstName) lines.push(`LANDLORD: ${ctx.landlord.firstName}`);

  // ⚠️ FENCED, like the property profile below. This is the operator's own
  // marketing copy about themselves; the model may use it to sound like them,
  // never paste it. It is validated on save to contain no pricing (§41) —
  // PRICE_RE would reject any draft that quoted one, so an unfenced intro
  // carrying a fee would silently fail every message.
  if (ctx.operator.intro) {
    lines.push(
      `ABOUT THE OPERATOR (background only — write in their voice, never quote this and never mention money): ${ctx.operator.intro}`
    );
  }

  const property = [ctx.property.address, ctx.property.bedrooms ? `${ctx.property.bedrooms} bed` : null]
    .filter(Boolean)
    .join(" · ");
  if (property) lines.push(`PROPERTY: ${property}`);

  if (ctx.property.profile) {
    lines.push(
      `BACKGROUND (context only — never quote it, and never repeat anything commercial from it): ${ctx.property.profile}`
    );
  }

  if (ctx.step) {
    lines.push("");
    lines.push(
      `THIS IS FOLLOW-UP ${ctx.step.number - 1} OF THE SAME CONVERSATION. They have already been messaged and have not replied.`
    );
    if (ctx.step.previous.length > 0) {
      lines.push("ALREADY SENT (do not repeat any of this, and do not start over):");
      for (const prior of ctx.step.previous) {
        lines.push(`  ${prior.daysAgo} days ago: ${prior.text}`);
      }
    }
    if (ctx.step.brief) {
      lines.push(`WHAT THIS MESSAGE IS FOR: ${ctx.step.brief}`);
    }
    lines.push("");
  }

  if (!ctx.figures) {
    // Named explicitly rather than left to inference. A model shown no FIGURES
    // heading may decide the numbers were simply forgotten.
    lines.push(
      "FIGURES: none. This property has not been analysed. Write a message with no numbers in it at all."
    );
    return lines.join("\n");
  }

  const f: string[] = [];
  if (ctx.figures.grossAnnual !== null) {
    f.push(`  projected gross short-let income: £${Math.round(ctx.figures.grossAnnual).toLocaleString("en-GB")} a year`);
  }
  if (ctx.figures.nightlyRate !== null) {
    f.push(`  average nightly rate: £${Math.round(ctx.figures.nightlyRate)}`);
  }
  if (ctx.figures.occupancyPct !== null) {
    f.push(`  projected occupancy: ${Math.round(ctx.figures.occupancyPct)}%`);
  }
  lines.push("FIGURES from our analysis of this property. Use these and only these:");
  lines.push(...f);

  return lines.join("\n");
}
