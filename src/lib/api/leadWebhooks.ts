/**
 * The inbound lead receiver's credential and its request body (§48).
 *
 * Pure — no network, no database — so it sits in the build-gating vitest suite
 * beside the rest of `src/lib/api`.
 *
 * ⚠️ THE TOKEN TRAVELS IN THE URL PATH, which is a bearer credential in a place
 * that reaches server logs, proxy logs and referrers. That is the same trade
 * `/api/webhook/timelines/[token]` and `/api/webhook/resend/[token]` already
 * make, and it is proportionate here for one reason: this door SPENDS NO MONEY.
 * It creates rows scoped to one customer and nothing else. If it is ever
 * widened to charge — the £3 analysis is the obvious temptation — it must
 * become a signed request first, not merely a longer token.
 */
import { base62, hashApiKey } from "@/lib/api/keys";
import type { OwnedLeadInput } from "@/lib/customerLeads";

/**
 * `sflw_` for "Stayful lead webhook", so a token found in a log is
 * identifiable at a glance and cannot be mistaken for an API key (`sfl_live_`).
 */
export const LEAD_WEBHOOK_PREFIX = "sflw_";

/** 48 base62 characters ≈ 285 bits. The whole token is the secret. */
const TOKEN_CHARS = 48;

/** Mint a token: the raw string to show once, and the hash we store. */
export function generateLeadWebhookToken(): { raw: string; hash: string } {
  const raw = LEAD_WEBHOOK_PREFIX + base62(TOKEN_CHARS);
  return { raw, hash: hashLeadWebhookToken(raw) };
}

/**
 * sha256 hex, the only form ever stored.
 *
 * Reuses `hashApiKey` rather than calling `createHash` again — the argument in
 * `keys.ts` for sha256 over a slow KDF holds identically here (a CSPRNG secret
 * has no dictionary behind it, and the lookup runs on every request), and two
 * hashers is two places for the algorithm to drift.
 */
export function hashLeadWebhookToken(raw: string): string {
  return hashApiKey(raw);
}

/** The full URL a customer pastes into Make, n8n or Zapier. */
export function leadWebhookUrl(appUrl: string, rawToken: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhook/customer-leads/${rawToken}`;
}

/**
 * What the receiver accepts.
 *
 * ⚠️ A CLOSED, NAMED SET OF FIELDS, and every one maps onto `OwnedLeadInput`.
 * §27.1's standing rule is that nothing on this surface takes a query, a table
 * name, a column list or an arbitrary filter, and a write endpoint that merely
 * forwarded its body into an insert would be that rule undone from the other
 * direction. An unrecognised field is IGNORED rather than refused: an
 * automation platform sends whole records, and 400-ing a lead because Make
 * included an `id` column would make the door useless.
 */
export const LEAD_WEBHOOK_FIELDS = [
  "name",
  "email",
  "phone",
  "address",
  "postcode",
  "bedrooms",
  "profile",
] as const;

/**
 * Aliases for the shapes a real automation actually sends. Deliberately small
 * and deliberately NOT content sniffing — `leadImport.ts` guesses at column
 * meaning because a spreadsheet's headings are whatever somebody typed, and it
 * can afford to because a human confirms the mapping on the next screen
 * (§30.4). Nobody confirms anything here, so a wrong guess would be stored
 * silently. These are exact names only.
 */
const ALIASES: Record<string, (typeof LEAD_WEBHOOK_FIELDS)[number]> = {
  full_name: "name",
  fullname: "name",
  landlord_name: "name",
  contact_name: "name",
  email_address: "email",
  telephone: "phone",
  mobile: "phone",
  phone_number: "phone",
  post_code: "postcode",
  postal_code: "postcode",
  property_address: "address",
  bedroom_count: "bedrooms",
  beds: "bedrooms",
  notes: "profile",
};

/** A scalar the customer sent, as the text we store. Everything is text. */
function scalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  // Deliberately not booleans, objects or arrays: none of them is a landlord's
  // name, and `String({})` would store "[object Object]" as an address.
  return null;
}

/**
 * Map a posted body onto the input `createOwnedLeads` already takes.
 *
 * Case-insensitive on keys, because "Email" and "email" both arrive and
 * refusing one of them is a support ticket rather than a safety property.
 */
export function toOwnedLeadInput(body: unknown): OwnedLeadInput {
  const out: OwnedLeadInput = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return out;

  const known = new Set<string>(LEAD_WEBHOOK_FIELDS);
  const normalised: Array<[string, unknown]> = Object.entries(
    body as Record<string, unknown>
  ).map(([k, v]) => [k.trim().toLowerCase().replace(/[\s-]+/g, "_"), v]);

  const take = (field: (typeof LEAD_WEBHOOK_FIELDS)[number], raw: unknown) => {
    if (out[field] != null) return;
    const value = scalar(raw);
    if (value !== null) out[field] = value;
  };

  // ⚠️ TWO PASSES, AND THE ORDER OF THEM IS THE RULE. An exact field name beats
  // an alias whatever order the keys arrive in — a body carrying both `name`
  // and `full_name` must resolve the same way every time, and a single pass
  // lets whichever the platform happened to serialise first decide. That is not
  // something the customer controls, so it is not something that may matter.
  for (const [key, raw] of normalised) {
    if (known.has(key)) take(key as (typeof LEAD_WEBHOOK_FIELDS)[number], raw);
  }
  for (const [key, raw] of normalised) {
    const field = ALIASES[key];
    if (field) take(field, raw);
  }

  return out;
}
