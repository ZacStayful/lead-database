import type { NextRequest } from "next/server";
import { AD_COPY } from "@/lib/ads/copy";
import { adProfileOf, resolveSlots, targetingFor, citySuggestions } from "@/lib/ads/resolveSlots";
import { ATTESTATION_KEYS, answersToProfile, isChatWritable } from "@/lib/ads/profile";
import { adJson, adSession, adWriteSession, mergeAdProfile } from "@/lib/ads/session";
import { AD_TEMPLATES, DEFAULT_TEMPLATE_ID, templateById } from "@/lib/ads/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The business details every advert is built from (§65).
 *
 * ⚠️ EVERY FIELD IS AN OVERRIDE, NEVER A COPY (§41.6). A NULL key means "use
 * what the account already has" — company_name falls back to
 * referral_business_name then business_name, the fee to presentation_settings,
 * the areas to the lead filter. One value per fact, and a difference exists
 * only where somebody chose one. Nothing here is ever written back onto an
 * account column.
 */
export async function GET() {
  const gate = await adSession();
  if (!gate.ok) return gate.response;
  const { customer } = gate.session;

  const template = templateById(DEFAULT_TEMPLATE_ID)!;
  const resolution = resolveSlots(customer, template);
  const targeting = targetingFor(customer);

  return adJson({
    profile: adProfileOf(customer),
    // What each field would fall back to, so the form can placehold the
    // inherited value rather than showing an empty box that means something.
    inherited: {
      company_name: resolution.slots.company_name ?? null,
      landing_url: resolution.slots.landing_url ?? null,
      areas: resolution.slots.areas ?? null,
      fee_pct: resolution.slots.fee_pct ?? null,
      fee_basis: resolution.slots.fee_basis ?? null,
    },
    targeting,
    city_suggestions: targeting.kind === "areas" ? citySuggestions(targeting.areas) : [],
    services: AD_TEMPLATES.filter((t) => t.services).map((t) => ({
      template_id: t.id,
      slot: t.services!.slot,
      options: t.services!.options.map((o) => ({ key: o.key, label: o.label })),
    })),
    updated_at: (customer as { ad_profile_updated_at?: string | null }).ad_profile_updated_at ?? null,
  });
}

/**
 * ⚠️ THE ATTESTATIONS ARE SETTABLE HERE AND NOWHERE ELSE.
 * `review_quote_confirmed` unlocks quoting a customer's review, and
 * `stats_confirmed_at` records that the published figures are real and
 * evidenceable — CAP Code 3.7 wants documentary evidence held BEFORE
 * publication. Both are a deliberate tick by a person attesting to something,
 * which is why `profile.ts` refuses to infer either from a chat answer.
 */
const PUT_ONLY_KEYS = [
  "review_quote",
  "review_quote_source",
  ...ATTESTATION_KEYS,
] as const;

export async function PUT(request: NextRequest) {
  const gate = await adWriteSession();
  if (!gate.ok) return gate.response;
  const { admin, customer } = gate.session;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return adJson({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return adJson({ error: "Invalid body" }, 400);
  }

  // ⚠️ THE SAME COERCION THE CHAT USES, so a fee typed into the form and a fee
  // said to the chat cannot end up in two different shapes. The form answers
  // are run through `answersToProfile` as a one-question-per-key ladder rather
  // than parsed a second time here.
  const template = templateById(DEFAULT_TEMPLATE_ID)!;
  const asAnswers = Object.entries(body)
    .filter(([key]) => isChatWritable(key))
    .map(([key, value], i) => ({
      id: `p${i}`,
      question: key,
      answer: Array.isArray(value) ? value.join(", ") : String(value ?? ""),
      depth: 0,
    }));
  const asQuestions = asAnswers.map((a) => ({
    id: a.id,
    question: a.question,
    options: [],
    allowOther: true,
    slot: a.question,
    depth: 0,
    calls: 0,
  }));

  // The multi-selects arrive as real arrays from the form, so they skip the
  // prose coercion entirely and are matched against the template that owns
  // them — a service key nobody offered is not a tick.
  const patch: Record<string, unknown> = { ...answersToProfile(asQuestions, asAnswers, template) };
  for (const t of AD_TEMPLATES) {
    if (!t.services) continue;
    const raw = body[t.services.slot];
    if (!Array.isArray(raw)) continue;
    const allowed = new Set(t.services.options.map((o) => o.key));
    patch[t.services.slot] = raw.map(String).filter((k) => allowed.has(k));
  }

  for (const key of PUT_ONLY_KEYS) {
    if (!(key in body)) continue;
    if (key === "review_quote" || key === "review_quote_source") {
      const text = String(body[key] ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
      patch[key] = text || null;
    } else if (key === "review_quote_confirmed") {
      patch[key] = body[key] === true;
    } else {
      // ⚠️ STAMPED HERE, NOT TAKEN FROM THE BODY. An attestation dated by its
      // subject is not an attestation.
      patch[key] = body[key] === true ? new Date().toISOString() : null;
    }
  }

  if (!Object.keys(patch).length) return adJson({ error: "Nothing to change." }, 400);

  const merged = await mergeAdProfile(admin, customer.id, patch);
  if (!merged) return adJson({ error: AD_COPY.errors.generic }, 500);
  return adJson({ saved: true, profile: patch });
}
