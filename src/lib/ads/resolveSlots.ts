import type { Customer } from "@/lib/types";
import { POSTCODE_AREA_CITY } from "@/lib/postcode";
import type { AdSlotKey, AdTemplate } from "./templates";
import { slotsForTemplate } from "./templates";

/**
 * Turning a customer row into the values a template's patterns need (§65).
 *
 * ⚠️ EVERY FIELD IS AN OVERRIDE, NEVER A COPY (§41.6). `ad_profile` holds only
 * what somebody deliberately set for their ads; a NULL key means "use what the
 * account already has". One value per fact, and a difference exists only where
 * it was chosen.
 */

export type FeeBasis = "net" | "gross";
export type FeeVat = "inclusive" | "exclusive" | "not_stated";

export type AdProfile = {
  company_name?: string | null;
  city?: string | null;
  areas?: string | null;
  landing_url?: string | null;
  fee_pct?: number | null;
  fee_basis?: FeeBasis | null;
  fee_vat?: FeeVat | null;
  fee_public?: boolean | null;
  included?: string[] | null;
  handled?: string[] | null;
  councils?: string[] | null;
  property_types?: string[] | null;
  turnaround?: string | null;
  years_trading?: number | null;
  properties_managed?: number | null;
  review_score?: number | null;
  review_count?: number | null;
  review_quote?: string | null;
  review_quote_source?: string | null;
  /** ⚠️ Without this, T8's quote angle is dropped from the prompt entirely. */
  review_quote_confirmed?: boolean | null;
  /** One attestation that the published figures are real and evidenceable. */
  stats_confirmed_at?: string | null;
};

export function adProfileOf(customer: Pick<Customer, "ad_profile">): AdProfile {
  const raw = (customer as { ad_profile?: unknown }).ad_profile;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as AdProfile) : {};
}

const text = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

/**
 * ⚠️ THREE STATES, NOT TWO. `leadFilter.ts` is explicit that an ACTIVE filter
 * with an EMPTY area list means "anywhere" — which is the ask case, not the
 * have-areas case. Reading it as two states silently targets an operator's ad
 * at nowhere, or at everywhere they never asked for.
 */
export type TargetingState =
  | { kind: "areas"; areas: string[] }
  | { kind: "anywhere" }
  | { kind: "unset" };

const isFilterOn = (s: unknown) => s === "active" || s === "pending_lift";

export function targetingFor(customer: Customer): TargetingState {
  // Both filters, because a customer may hold either product and the ad is
  // about their business rather than one of our two books.
  const areas = [
    ...(isFilterOn(customer.filter_status) ? customer.filter_areas ?? [] : []),
    ...(isFilterOn(customer.gr_filter_status) ? customer.gr_filter_areas ?? [] : []),
  ]
    .map((a) => String(a).trim().toUpperCase())
    .filter(Boolean);

  const unique = Array.from(new Set(areas));
  if (unique.length) return { kind: "areas", areas: unique };
  if (isFilterOn(customer.filter_status) || isFilterOn(customer.gr_filter_status)) {
    return { kind: "anywhere" };
  }
  return { kind: "unset" };
}

/**
 * Cities we could honestly put in a headline, derived from the areas they
 * already told us they want work in.
 *
 * ⚠️ `cityForArea()` IS NOT PUBLISHABLE COPY. Its map answers "what shall we
 * call this area in admin" and returns "London (East)" for E and
 * "Chester/Wirral" for CH. An ad reading "Landlords in Chester/Wirral" is a
 * mail-merge in public.
 *
 * So, derived from the same map rather than a second hand-maintained one:
 *   - a plain name is offered as it stands;
 *   - "London (East)" is offered as "London", which is true of every E
 *     postcode and is what a reader would say themselves;
 *   - ⚠️ "Chester/Wirral" is offered as NOTHING. Picking either half tells
 *     half the audience the ad is not for them, so the chat asks instead.
 */
export function citySuggestions(areas: string[]): string[] {
  const out: string[] = [];
  for (const area of areas) {
    const name = POSTCODE_AREA_CITY[area.toUpperCase()];
    if (!name || name.includes("/")) continue;
    const plain = name.replace(/\s*\(.*\)\s*$/, "").trim();
    if (plain && !out.includes(plain)) out.push(plain);
  }
  return out;
}

/** "LS, WF and BD" — how a list of areas reads in a sub. */
export function areasPhrase(areas: string[]): string | null {
  const list = areas.filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

// ---------------------------------------------------------------------------
// The fee
// ---------------------------------------------------------------------------

export type FeeVerdict = { ok: true; warn: string | null } | { ok: false; reason: string };

/**
 * ⚠️ WARNS ON AN INHERITED VALUE AND REFUSES ONLY A FRESH ONE.
 *
 * The spec says "under 8% or over 30% is almost certainly a typo, and a wrong
 * fee in a live ad is worse than no ad" — which is right about something typed
 * today. It is wrong as a hard failure on a `presentation_settings.fee` the
 * customer set months ago for their deck: that number is one they chose and
 * have been presenting from, and blocking their ad on it helps nobody.
 */
export function feeVerdict(pct: number | null | undefined, opts: { fresh: boolean }): FeeVerdict {
  if (pct === null || pct === undefined) return { ok: true, warn: null };
  if (!Number.isFinite(pct)) return { ok: false, reason: "fee_not_a_number" };
  if (pct <= 0 || pct >= 100) return { ok: false, reason: "fee_out_of_range" };
  const odd = pct < 8 || pct > 30;
  if (!odd) return { ok: true, warn: null };
  if (opts.fresh) return { ok: false, reason: "fee_looks_like_a_typo" };
  return { ok: true, warn: "fee_outside_usual_range" };
}

/** "15% of gross, plus VAT" — never a bare number. */
export function feePhrase(p: AdProfile): string | null {
  if (p.fee_public !== true) return null;
  if (p.fee_pct === null || p.fee_pct === undefined || !Number.isFinite(p.fee_pct)) return null;
  const basis = p.fee_basis === "net" ? "of net" : "of gross";
  const vat =
    p.fee_vat === "inclusive" ? ", including VAT"
    : p.fee_vat === "exclusive" ? ", plus VAT"
    : "";
  return `${p.fee_pct}% ${basis}${vat}`;
}

// ---------------------------------------------------------------------------
// The services list
// ---------------------------------------------------------------------------

/**
 * The sub's service list, built from what they ticked.
 *
 * ⚠️ NEVER A FIXED STRING. The spec's own subs hardcode five services for T3
 * and four for T6 while both are multi-selects, and T6's claims note says
 * "Only items they tick may appear" — so a fixed sub publishes services the
 * customer does not provide, which is §51.11's failure aimed at the customer.
 */
export function serviceListPhrase(t: AdTemplate, selected: string[]): string | null {
  if (!t.services) return null;
  const labels = t.services.options.filter((o) => selected.includes(o.key)).map((o) => o.label);
  if (!labels.length) return null;
  const joined =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export type SlotValues = Partial<Record<AdSlotKey, string>>;

export type Resolution = {
  slots: SlotValues;
  /** Declared by the template and still unknown. The chat asks about these. */
  missing: AdSlotKey[];
  targeting: TargetingState;
  /** True when no city is known, so the unlocated headline is the honest one. */
  unlocated: boolean;
  warnings: string[];
};

export function resolveSlots(customer: Customer, template: AdTemplate): Resolution {
  const p = adProfileOf(customer);
  const targeting = targetingFor(customer);
  const warnings: string[] = [];

  const settings = (customer as { presentation_settings?: unknown }).presentation_settings;
  const deckFee =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? ((settings as { fee?: { pct?: unknown; basis?: unknown } }).fee ?? null)
      : null;

  // ⚠️ THE OVERRIDE CHAIN. Never write any of these back onto the account.
  const companyName =
    text(p.company_name) ??
    text((customer as { referral_business_name?: unknown }).referral_business_name) ??
    text(customer.business_name);

  const landingUrl =
    text(p.landing_url) ??
    text((customer as { messaging_booking_link?: unknown }).messaging_booking_link) ??
    text((customer as { website_url?: unknown }).website_url);

  const feePct =
    p.fee_pct ?? (typeof deckFee?.pct === "number" ? (deckFee.pct as number) : null);
  const feeInherited = p.fee_pct === null || p.fee_pct === undefined;
  const fee = feeVerdict(feePct, { fresh: !feeInherited });
  if (fee.ok && fee.warn) warnings.push(fee.warn);
  if (!fee.ok) warnings.push(fee.reason);

  const areas = text(p.areas) ?? (targeting.kind === "areas" ? areasPhrase(targeting.areas) : null);

  const slots: SlotValues = {};
  const put = (k: AdSlotKey, v: string | null) => {
    if (v !== null) slots[k] = v;
  };

  put("company_name", companyName);
  put("city", text(p.city));
  put("areas", areas);
  put("landing_url", landingUrl);
  put("fee_pct", fee.ok && feePct !== null ? String(feePct) : null);
  put("fee_basis", text(p.fee_basis ?? (deckFee?.basis as string | undefined)));
  put("fee_vat", text(p.fee_vat));
  put("fee_public", p.fee_public === true ? "true" : p.fee_public === false ? "false" : null);
  put("turnaround", text(p.turnaround));
  put("years_trading", text(p.years_trading));
  put("properties_managed", text(p.properties_managed));
  put("review_score", text(p.review_score));
  put("review_count", text(p.review_count));
  put("review_quote", p.review_quote_confirmed === true ? text(p.review_quote) : null);
  put("review_quote_source", p.review_quote_confirmed === true ? text(p.review_quote_source) : null);
  put("included", (p.included ?? []).join(",") || null);
  put("handled", (p.handled ?? []).join(",") || null);
  put("councils", areasPhrase((p.councils ?? []).map(String)));
  put("property_types", areasPhrase((p.property_types ?? []).map(String)));
  put("included_list", serviceListPhrase(template, p.included ?? []));
  put("handled_list", serviceListPhrase(template, p.handled ?? []));

  // ⚠️ A derived list slot is missing when its SOURCE is unticked, not when
  // the derived key is absent — otherwise the chat asks for "included_list",
  // which is not a question anybody can answer.
  const declared = slotsForTemplate(template);
  const missing = declared.filter((k) => {
    if (k === "city") return false; // targeting decides this, not a gap
    if (k === "fee_basis" || k === "fee_vat" || k === "fee_public") {
      return p.fee_public === true && slots[k] === undefined;
    }
    if (k === "review_quote" || k === "review_quote_source") return false; // optional by design
    return slots[k] === undefined;
  });

  return {
    slots,
    missing,
    targeting,
    unlocated: slots.city === undefined,
    warnings,
  };
}

/** Substitute `{slot}` values, leaving emphasis markers alone. */
export function fillPattern(pattern: string, slots: SlotValues): string | null {
  let complete = true;
  const filled = pattern.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = slots[key as AdSlotKey];
    if (value === undefined) {
      complete = false;
      return "";
    }
    return value;
  });
  // ⚠️ A template whose slots are not all resolved cannot render. Returning
  // the half-filled string would put "Landlords in : 8 years" on an ad.
  return complete ? filled : null;
}
