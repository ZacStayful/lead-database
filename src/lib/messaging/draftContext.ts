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

export interface DraftContext {
  operator: { businessName: string | null; contactName: string | null };
  landlord: { firstName: string | null };
  property: {
    address: string | null;
    bedrooms: string | null;
    profile: string | null;
  };
  /** null means "this property has not been analysed" — not "zero". */
  figures: DraftFigures | null;
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

  const property = [ctx.property.address, ctx.property.bedrooms ? `${ctx.property.bedrooms} bed` : null]
    .filter(Boolean)
    .join(" · ");
  if (property) lines.push(`PROPERTY: ${property}`);

  if (ctx.property.profile) {
    lines.push(
      `BACKGROUND (context only — never quote it, and never repeat anything commercial from it): ${ctx.property.profile}`
    );
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
