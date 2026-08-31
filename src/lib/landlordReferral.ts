/**
 * The landlord referral email (§41) — the pure half.
 *
 * Stayful writes to a landlord ABOUT the operator who has just been given their
 * enquiry. Every other landlord-facing send in this codebase is §40 messaging,
 * which goes out AS the operator from their own number or domain; this one is
 * ours, from our sending domain, and it is the thing the privacy policy names
 * as the lawful basis for the referral itself.
 *
 * ⚠️ FORWARD-ONLY. The only caller is completeAssignment(), which runs when a
 * lead is allocated. Nothing here walks existing leads and nothing may ever be
 * added that does — a landlord who enquired months ago must not be written to
 * because a feature shipped.
 *
 * WHY THE RENDERER LIVES HERE AND NOT IN emails.ts: vitest is `environment:
 * node` with pure units only, so a renderer that reaches Resend cannot be
 * tested. Splitting it means the escaping test — an operator's own words going
 * into HTML sent to a member of the public — is a real test. Same arrangement
 * as retentionCopy.ts, and `esc` is imported from @/lib/emails exactly as
 * messaging/outbound.ts does, because §22.5 makes escaping load-bearing and a
 * second copy of it is how the two drift.
 */
import { esc } from "@/lib/emails";
import { EMAIL_RE } from "@/lib/leadQuality";

/** The lead columns the decision and the copy read. Narrow on purpose. */
export interface ReferralLead {
  id: string;
  lead_name?: string | null;
  email?: string | null;
  address?: string | null;
  bedrooms?: string | null;
  lead_type?: string | null;
  owner_customer_id?: string | null;
  lead_quality_codes?: string[] | null;
  gross_annual_income?: number | null;
}

/** The operator, as a landlord meets them. */
export interface ReferralOperator {
  business_name?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  operator_intro?: string | null;
}

export type ReferralSkipReason =
  | "no_email"
  | "email_quality"
  | "owned_lead";

export type ReferralDecision =
  | { refer: true }
  | { refer: false; reason: ReferralSkipReason };

/**
 * Should this landlord be written to at all?
 *
 * ⚠️ KEYS ON THE EMAIL QUALITY CODES, NOT `lead_quality_status`. That column is
 * a single verdict across name, phone AND email (§36), so a landlord with a
 * perfectly good address but a foreign phone reads as `failed` — and gating on
 * it would silently drop them. Only the two email codes describe whether mail
 * can reach this person.
 *
 * ⚠️ AN OWNED LEAD IS NEVER REFERRED, and this is the most important exclusion
 * here. `owner_customer_id` marks a lead a customer uploaded themselves (§30),
 * including a §32 resold one. That landlord never enquired with Stayful; a
 * referral would be a cold approach from a company they have never heard of.
 */
export function shouldReferLandlord(lead: ReferralLead): ReferralDecision {
  if (lead.owner_customer_id) return { refer: false, reason: "owned_lead" };

  const email = (lead.email ?? "").trim();
  // Management ingest writes "" for an absent field rather than null, so an
  // empty string is the common case, not an edge one.
  if (!email || !EMAIL_RE.test(email)) return { refer: false, reason: "no_email" };

  const codes = lead.lead_quality_codes ?? [];
  if (codes.includes("email_missing") || codes.includes("email_malformed")) {
    return { refer: false, reason: "email_quality" };
  }

  return { refer: true };
}

/**
 * A landlord's first name, for the greeting.
 *
 * Deliberately the same rule §36.3 measured rather than a second one: 87 of 437
 * leads are a lone first name, so requiring a surname would discard a fifth of
 * the book. Junk is caught by the quality gate upstream.
 */
export function landlordFirstName(fullName: string | null | undefined): string | null {
  const first = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  if (first.length < 2 || first.length > 40) return null;
  if (!/[a-z]/i.test(first)) return null;
  return first;
}

/** How the operator signs off, worst case "the operator". */
export function operatorLabel(op: ReferralOperator): string {
  return (
    op.business_name?.trim() ||
    op.contact_name?.trim() ||
    "a local operator"
  );
}

export interface ReferralCopy {
  subject: string;
  greeting: string;
  /** Paragraphs before the operator's details. */
  intro: string[];
  /** Label/value rows describing the operator. */
  rows: { label: string; value: string }[];
  /** The operator's own words, already trimmed. Null when unset. */
  operatorIntro: string | null;
  /** Present only when this is the first introduction for the lead. */
  cta: { label: string; note: string } | null;
}

/**
 * The words. Pure, so the escaping and the product split are both testable.
 *
 * ⚠️ COPY BRANCHES ON lead_type (invariant 6). A management operator manages a
 * property for a fee; a guaranteed-rent operator pays a fixed rent and takes
 * the letting risk. Telling a landlord the wrong one is worse than telling them
 * nothing, and nothing here reads a management-only column.
 *
 * ⚠️ NO FIGURE, NO FEE, NO PERCENTAGE ANYWHERE. The report's fee is Stayful's
 * and the operator's is different and unknown at this moment; either is a price
 * claim we cannot stand behind. The same exclusion mergeFields.ts:143-158 makes.
 */
export function buildReferralCopy(params: {
  lead: ReferralLead;
  operator: ReferralOperator;
  askQuestions: boolean;
}): ReferralCopy {
  const { lead, operator, askQuestions } = params;
  const isGr = lead.lead_type === "guaranteed_rent";
  const who = operatorLabel(operator);
  const first = landlordFirstName(lead.lead_name);

  const rows: { label: string; value: string }[] = [];
  if (operator.contact_name?.trim()) rows.push({ label: "Who", value: operator.contact_name.trim() });
  if (operator.business_name?.trim()) rows.push({ label: "Company", value: operator.business_name.trim() });
  if (operator.phone?.trim()) rows.push({ label: "Phone", value: operator.phone.trim() });
  if (operator.email?.trim()) rows.push({ label: "Email", value: operator.email.trim() });

  const property = lead.address?.trim();

  const intro = [
    property
      ? `Thanks for your enquiry about ${property}.`
      : `Thanks for your enquiry.`,
    isGr
      ? `We've matched you with ${who}, an operator who takes properties on a guaranteed rent basis — they pay you a fixed monthly rent and handle the letting themselves. They'll be in touch shortly.`
      : `We've matched you with ${who}, a local short-let management company who we think is a good fit for your property. They'll be in touch shortly.`,
    `They already have the details you shared, so you won't need to repeat yourself.`,
  ];

  return {
    subject: `Your enquiry — ${who} will be in touch`,
    greeting: first ? `Hi ${first},` : `Hello,`,
    intro,
    rows,
    operatorIntro: operator.operator_intro?.trim() || null,
    cta: askQuestions
      ? {
          label: "Tell them how to reach you",
          note: "It takes about a minute, and it means they call at a time that suits you.",
        }
      : null,
  };
}

/**
 * The HTML body. Everything an operator typed goes through esc().
 *
 * ⚠️ NOT emails.ts's shell(). That footer says "You are receiving this because
 * you have an active subscription", which is false for a landlord and damaging
 * as a first contact. landlordShell() in emails.ts states the real reason and
 * carries the objection route.
 */
export function renderReferralBody(copy: ReferralCopy): string {
  const rows = copy.rows
    .map(
      (r) =>
        `<tr><td style="padding:6px 0;color:#6b706a;font-size:13px;width:120px;vertical-align:top">${esc(
          r.label
        )}</td><td style="padding:6px 0;font-size:14px">${esc(r.value)}</td></tr>`
    )
    .join("");

  const paras = copy.intro
    .map((p) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6">${esc(p)}</p>`)
    .join("");

  const introBlock = copy.operatorIntro
    ? `<div style="margin:18px 0;padding:14px;background:#f5f6f5;border-radius:8px">
         <p style="margin:0 0 6px;color:#6b706a;font-size:12px;text-transform:uppercase;letter-spacing:.04em">In their words</p>
         <p style="margin:0;font-size:14px;line-height:1.6">${esc(copy.operatorIntro)}</p>
       </div>`
    : "";

  return `
    <h1 style="margin:0 0 12px;font-size:18px">${esc(copy.greeting)}</h1>
    ${paras}
    <table style="width:100%;border-collapse:collapse;margin:18px 0">${rows}</table>
    ${introBlock}
  `;
}
