/**
 * Merge fields for a hand-written follow-up step (§40.14).
 *
 * PURE, on sendWindow.ts's stated reasoning: a decision that needs no client is
 * testable in the good style without extending a hand-rolled fake.
 *
 * ⚠️ THE CATALOGUE IS CLOSED, AND EVERY FIELD IS RESOLVED BY A NAMED FUNCTION.
 * Nothing here takes a column name from the browser and reads it. That is the
 * §27.1 standing rule the API surface has held to — "never add a tool or
 * endpoint that takes a query, a table name, a column list, a file path or an
 * arbitrary filter" — and it is what stops `{{lead_quality_override_note}}` or
 * `{{owner_customer_id}}` being pasted into a message to a landlord by somebody
 * guessing at column names. An unknown field is a SAVE-TIME error, never an
 * empty string at send time.
 *
 * ⚠️ AND THE INTERESTING PART IS NOT SUBSTITUTION, IT IS ABSENCE. Measured over
 * the live book when this was written, per PRODUCT — which is the only way the
 * numbers mean anything:
 *
 *                              management        guaranteed rent
 *     first name                 189 / 196          (same rule)
 *     address                     194 / 196
 *     bedrooms                    191 / 196
 *     income / rate / occupancy   326 / 363 (90%)     0 / 252  (NONE)
 *
 * ⚠️ THE ZERO IS THE FINDING, and it was nearly missed. Read across the whole
 * `leads` table those figures fill on 39%, which looks like a field to use with
 * care. Read per product they fill on 90% of management leads and on NOT ONE of
 * 252 guaranteed rent leads — because §25's analysis is management-only, by
 * design, and IncomeProjection used to refuse a GR lead outright.
 *
 * So {{income}} in a GR sequence reaches nobody at all. It is refused at save
 * time rather than left to produce a run that silently skips every lead: see
 * `productOnly` below.
 *
 * A lead with no value is SKIPPED rather than sent a message with a hole in it,
 * and `fieldCoverage` exists so the operator is told the reach while they are
 * still writing — the §28 forecast discipline and §40.13's "state how long the
 * backlog will take", applied to the same kind of decision.
 *
 * `{{town}}` is deliberately absent. extractCity() resolves on 173 of 446
 * addresses and is WRONG on the common shape: "212 Gill Avenue, Bristol BS16
 * 2PH" has its postcode-bearing last segment filtered out and returns the
 * street. A field that is confidently wrong is worse than one that is missing.
 */
import { firstNameOf } from "./draftContext";
import { isJunkName } from "@/lib/leadQuality";

/** What a field can be resolved from. Nothing else is reachable. */
export interface MergeLead {
  lead_name?: string | null;
  address?: string | null;
  bedrooms?: string | null;
  gross_annual_income?: unknown;
  avg_nightly_rate?: unknown;
  occupancy_rate?: unknown;
}

export interface MergeCustomer {
  business_name?: string | null;
  contact_name?: string | null;
  messaging_booking_link?: string | null;
}

export interface MergeContext {
  lead: MergeLead;
  customer: MergeCustomer;
}

/**
 * `always` fields fill on >97% of the live book; `sometimes` fields on 39%.
 * The distinction is shown in the field picker, because the two carry very
 * different consequences for reach and the operator cannot know which is which.
 */
export type MergeFieldTier = "always" | "sometimes" | "profile";

export interface MergeField {
  key: string;
  label: string;
  tier: MergeFieldTier;
  /**
   * ⚠️ Set to "management" for the three analysis figures, and it is a hard
   * refusal rather than a warning. Not one of 252 guaranteed rent leads has an
   * income figure — §25's analysis is management-only — so a GR sequence using
   * one would skip every single lead and send nothing, which reads as the
   * feature being broken rather than as a rule.
   */
  productOnly?: "management";
  /** What it renders as, or null when this lead has nothing for it. */
  resolve: (ctx: MergeContext) => string | null;
  /** Shown in the picker so the operator can see the shape before using it. */
  example: string;
  note?: string;
}

/**
 * A UK postcode at the END of an address, with or without the space.
 *
 * Stripped because an operator writes "about {{address}}" and means the place,
 * not the postcode — "17 Sefton drive L8 3SD" reads badly in a sentence. Only
 * anchored at the end, so "Flat 2 The Old Post Office, 786 Fishponds Road" is
 * untouched and a mid-address postcode (they exist in this data:
 * "9 midland road, carlton, ng2 4ha NG13 9FE") keeps the one that is not final.
 */
const TRAILING_POSTCODE = /[,\s]*\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\s*$/i;

export function cleanAddress(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const withoutPostcode = trimmed.replace(TRAILING_POSTCODE, "").trim().replace(/[,\s]+$/, "");
  // A value that was ONLY a postcode leaves nothing usable. Better to skip the
  // lead than to render an empty gap mid-sentence.
  return withoutPostcode.length >= 3 ? withoutPostcode : null;
}

/**
 * ⚠️ The column is free text and inconsistent: "4+ bed", "1 Bed", "2 bedrooms",
 * "3 Bed", "studio". A template reading "your {{bedrooms}} property" would
 * produce "your 2 bedrooms property" untouched, which is exactly the kind of
 * thing that makes an operator look automated in front of a landlord.
 */
export function cleanBedrooms(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith("studio")) return "studio";
  const plus = value.match(/^(\d+)\s*\+/);
  if (plus) return `${plus[1]}+ bed`;
  const n = value.match(/^(\d+)/);
  if (n) return `${n[1]}-bed`;
  return null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(value: number): string {
  return `£${Math.round(value).toLocaleString("en-GB")}`;
}

/**
 * THE CATALOGUE.
 *
 * Deliberately absent, each for its own reason:
 *
 *  - `lead_profile` — on a resold imported lead that is the UPLOADING
 *    operator's private working notes: "margins, source attribution, 'will take
 *    12%, spoke to Dave'" (§32.8). draftContext fences it as background the
 *    model may never quote; a merge field would paste it to the landlord
 *    verbatim.
 *  - any fee or percentage of income — the report's 15% is STAYFUL's, and the
 *    operator's own has a different basis, so quoting either is quoting the
 *    wrong number (§26.1).
 *  - `net_income` — net of Stayful's fee, and rendered nowhere by design.
 *  - `town` — see the file header.
 */
export const MERGE_FIELDS: MergeField[] = [
  {
    key: "first_name",
    label: "Landlord's first name",
    tier: "always",
    example: "Priya",
    /**
     * ⚠️ `firstNameOf` ALONE IS NOT ENOUGH HERE, and the live book proves it.
     * That rule only asks for 2–40 characters containing a letter, which
     * `natalyanaq@gmail.com` and `Dbncc` both satisfy — so a template would
     * open "Hi natalyanaq@gmail.com," to a real landlord.
     *
     * It is a fair rule where it lives: `draftContext` hands the name to a
     * MODEL, which is not going to paste an email address into a greeting.
     * Substitution has no such judgement, so §36.3's junk detector is asked
     * first. Reusing it rather than writing a second name rule is the point —
     * two definitions of "does this read as a person" would drift, and §36.3
     * records the measurement (87 of 437 leads are a lone first name) that
     * makes it neither too strict nor too loose.
     */
    resolve: (c) => {
      const raw = (c.lead.lead_name ?? "").trim();
      if (!raw || isJunkName(raw)) return null;
      const first = firstNameOf(raw);
      return first && !isJunkName(first) ? first : null;
    },
  },
  {
    key: "address",
    label: "Property address",
    tier: "always",
    example: "212 Gill Avenue, Bristol",
    note: "The postcode is left off, so it reads naturally in a sentence.",
    resolve: (c) => cleanAddress(c.lead.address),
  },
  {
    key: "bedrooms",
    label: "Bedrooms",
    tier: "always",
    example: "2-bed",
    note: "Tidied to '2-bed' or '4+ bed' — the raw values are inconsistent.",
    resolve: (c) => cleanBedrooms(c.lead.bedrooms),
  },
  {
    key: "my_name",
    label: "Your name",
    tier: "profile",
    example: "Zoe",
    resolve: (c) => c.customer.contact_name?.trim() || null,
  },
  {
    key: "my_company",
    label: "Your company",
    tier: "profile",
    example: "Northside Lets",
    resolve: (c) => c.customer.business_name?.trim() || null,
  },
  {
    key: "booking_link",
    label: "Your booking link",
    tier: "profile",
    note: "Set it on the Messaging settings page. This is the only way a link can go into a written message.",
    example: "https://cal.com/you",
    resolve: (c) => c.customer.messaging_booking_link?.trim() || null,
  },
  {
    key: "income",
    label: "Projected annual income",
    tier: "sometimes",
    productOnly: "management",
    example: "£36,112",
    note: "Management leads only, and about 1 in 10 has not been analysed — those are skipped.",
    resolve: (c) => {
      const n = num(c.lead.gross_annual_income);
      return n === null ? null : money(n);
    },
  },
  {
    key: "nightly_rate",
    label: "Average nightly rate",
    tier: "sometimes",
    productOnly: "management",
    example: "£157",
    note: "Management leads only, same coverage as the income figure.",
    resolve: (c) => {
      const n = num(c.lead.avg_nightly_rate);
      return n === null ? null : money(n);
    },
  },
  {
    key: "occupancy",
    label: "Projected occupancy",
    tier: "sometimes",
    productOnly: "management",
    example: "63%",
    note: "Management leads only, same coverage as the income figure.",
    resolve: (c) => {
      const n = num(c.lead.occupancy_rate);
      return n === null ? null : `${Math.round(n)}%`;
    },
  },
];

const FIELD_BY_KEY = new Map(MERGE_FIELDS.map((f) => [f.key, f]));

/** What the picker may offer for this product. */
export function fieldsForProduct(leadType: string): MergeField[] {
  return MERGE_FIELDS.filter(
    (f) => !f.productOnly || f.productOnly === leadType
  );
}

/** `{{field}}`, tolerant of inner spaces so `{{ first_name }}` works. */
const TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Every field key a template refers to, in order, deduplicated. */
export function fieldsUsed(template: string): string[] {
  const seen: string[] = [];
  for (const m of Array.from(template.matchAll(TOKEN))) {
    const key = m[1].toLowerCase();
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

export const MAX_TEMPLATE_CHARS = 480;

/** A raw URL, matched the way validateDraft matches one. */
const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|co\.uk|net|org|io|app)\b)/i;

export type TemplateVerdict =
  | { ok: true; fields: string[] }
  | { ok: false; error: string };

/**
 * Judged when the operator SAVES, not when a landlord is about to be messaged.
 *
 * ⚠️ IT DOES NOT APPLY validateDraft's RULES. Those exist because a MODEL might
 * invent a figure or stray into pricing; an operator quoting their own fee in
 * their own words is their business, and refusing it would be us overruling
 * them about their own message. What survives are the two rules that are about
 * the operator's own number at scale rather than about the model: no raw links,
 * and a length cap.
 */
export function validateTemplate(
  template: string,
  opts: { hasBookingLink: boolean; leadType?: string }
): TemplateVerdict {
  const text = (template ?? "").trim();
  if (!text) return { ok: false, error: "Write the message first." };
  if (text.length > MAX_TEMPLATE_CHARS) {
    return {
      ok: false,
      error: `Keep it under ${MAX_TEMPLATE_CHARS} characters. A long first message from an unknown number reads as marketing, and it is what gets a WhatsApp account restricted.`,
    };
  }

  const fields = fieldsUsed(text);
  const unknown = fields.filter((f) => !FIELD_BY_KEY.has(f));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `There is no field called {{${unknown[0]}}}. Use the buttons above to insert one.`,
    };
  }

  // ⚠️ Strip the fields BEFORE looking for a link, or {{booking_link}} — which
  // contains no URL itself — would be fine but a rendered example would not,
  // and more importantly a legitimate template mentioning "cal.com" inside a
  // field name would trip. Checking the literal text the operator typed is the
  // honest test.
  const withoutFields = text.replace(TOKEN, "");
  if (LINK_RE.test(withoutFields)) {
    return {
      ok: false,
      error:
        "Links cannot be typed into a follow-up. A link in a cold WhatsApp is the strongest spam signal there is, and the number at risk is yours. Save your booking link on the Messaging settings page and insert {{booking_link}} instead.",
    };
  }

  // ⚠️ A management-only field in a GR sequence is REFUSED, not warned about.
  // Zero of 252 guaranteed rent leads carry an income figure, so the sequence
  // would skip every lead and send nothing at all — and a feature that silently
  // does nothing reads as broken rather than as a rule being applied.
  const leadType = opts.leadType ?? "management";
  const wrongProduct = fields
    .map((f) => FIELD_BY_KEY.get(f))
    .find((f) => f?.productOnly && f.productOnly !== leadType);
  if (wrongProduct) {
    return {
      ok: false,
      error: `{{${wrongProduct.key}}} only exists on management leads — guaranteed rent leads are never analysed, so this message would reach none of them.`,
    };
  }

  if (fields.includes("booking_link") && !opts.hasBookingLink) {
    return {
      ok: false,
      error:
        "You have not saved a booking link yet. Add one on the Messaging settings page, or take {{booking_link}} out.",
    };
  }

  return { ok: true, fields };
}

export type RenderResult =
  | { ok: true; text: string }
  | { ok: false; missing: string[] };

/**
 * Fill a template in for one lead, or say which fields it could not.
 *
 * ⚠️ IT NEVER RENDERS A GAP. An empty substitution produces "Hi , about your
 * place at " — sent, from a real person's number, to a member of the public.
 * A lead missing a field the template needs is reported here and SKIPPED by the
 * caller, and `fieldCoverage` is what makes that acceptable: the operator was
 * told the reach before they saved.
 */
export function renderTemplate(template: string, ctx: MergeContext): RenderResult {
  const missing: string[] = [];
  const text = template.replace(TOKEN, (_whole, raw: string) => {
    const key = raw.toLowerCase();
    const field = FIELD_BY_KEY.get(key);
    if (!field) {
      // Unreachable through the routes — validateTemplate refuses it at save
      // time — but a template stored before a field was retired would land
      // here, and skipping is the safe direction.
      if (!missing.includes(key)) missing.push(key);
      return "";
    }
    const value = field.resolve(ctx);
    if (value === null || value === "") {
      if (!missing.includes(key)) missing.push(key);
      return "";
    }
    return value;
  });

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, text: text.trim() };
}

export interface Coverage {
  total: number;
  reach: number;
  /** How many leads each field is the reason for, worst first. */
  missingByField: { key: string; label: string; count: number }[];
}

/**
 * How many of these leads this template can actually reach.
 *
 * ⚠️ THIS IS THE MOST VALUABLE THING IN THE FEATURE. Without it an operator
 * types {{income}} into a chase, saves, and silently loses three sends in five
 * — finding out weeks later, if at all. Shown while the wording can still be
 * changed, it is the number that changes the decision, which is the same
 * argument §28 makes for the filter forecast.
 */
export function fieldCoverage(
  template: string,
  leads: { lead: MergeLead }[],
  customer: MergeCustomer
): Coverage {
  const counts = new Map<string, number>();
  let reach = 0;

  for (const row of leads) {
    const result = renderTemplate(template, { lead: row.lead, customer });
    if (result.ok) {
      reach += 1;
      continue;
    }
    for (const key of result.missing) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return {
    total: leads.length,
    reach,
    missingByField: Array.from(counts.entries())
      .map(([key, count]) => ({
        key,
        label: FIELD_BY_KEY.get(key)?.label ?? key,
        count,
      }))
      .sort((a, b) => b.count - a.count),
  };
}
