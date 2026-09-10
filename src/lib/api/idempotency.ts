/**
 * Request idempotency — claim by INSERT, then act.
 *
 * ⚠️ NOTHING ELSE ON THIS API SURFACE HAS ANY. Every existing guard is keyed on
 * something the server generates INSIDE the request, so a caller whose
 * connection drops after we committed gets a second of everything when it
 * retries. `create_customer_leads` does dedupe, but on CONTENT, and its identity
 * key needs all three of name, email and phone (§30.3) — a partial row does not
 * dedupe at all, and a retry after a timeout creates a second landlord.
 *
 * The pattern is the house one. `credit_invoice()` uses it against Stripe
 * redelivery (§19.5), the announcement send uses it (§21.2), `stripe_events`
 * uses it, and every outbound message uses it (§40.13). Its whole point is that
 * CHECKING whether we already did the work and then doing it leaves a window
 * between the two, where claiming by write does not.
 *
 * ⚠️ THE TABLE IS NEVER A STRING FROM A REQUEST. §27.1's standing rule is that
 * no endpoint takes a table name, a column list or an arbitrary filter, and a
 * helper that accepted one would be that rule undone one layer down. Surfaces
 * are a closed union resolved through SURFACES below, so adding one is a
 * deliberate edit to this file.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Every surface that claims a key. One entry, and adding a second is an edit here. */
const SURFACES = {
  customer_leads: "customer_lead_webhook_claims",
} as const;

export type IdempotentSurface = keyof typeof SURFACES;

/** Postgres unique-violation. The whole mechanism rests on this one code. */
export const UNIQUE_VIOLATION = "23505";

/**
 * The longest key we will store, matching
 * `customer_lead_webhook_claims_key_len`. Refused rather than truncated: two
 * different keys sharing a prefix would silently become one, which is a
 * duplicate suppressed rather than a duplicate prevented.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export type ClaimOutcome<Row> =
  /** Ours. Do the work, then `settleClaim` — or `releaseClaim` if it fails. */
  | { status: "claimed"; claimId: string }
  /** Somebody got here first. Rebuild the answer from `row` and return 200. */
  | { status: "replay"; row: Row }
  /** The database could not be reached. The caller decides; do NOT act. */
  | { status: "error"; message: string };

/**
 * Take the key, or find out we already have.
 *
 * ⚠️ The unique index LEADS ON `customer_id`, mirroring
 * `lead_messages_idempotency_idx` (0116) — which 0116's header calls the
 * containment guarantee. Two customers may use the same key without colliding,
 * and one customer's keys are structurally unreachable from another's.
 */
export async function claimIdempotencyKey<Row = Record<string, unknown>>(
  admin: SupabaseClient,
  params: {
    surface: IdempotentSurface;
    customerId: string;
    key: string;
    /** Extra columns written with the claim, e.g. which webhook took it. */
    extra?: Record<string, unknown>;
    /** What a replay needs to read back. Never `*`. */
    replayColumns: string;
  }
): Promise<ClaimOutcome<Row>> {
  const table = SURFACES[params.surface];

  const { data, error } = await admin
    .from(table)
    .insert({
      customer_id: params.customerId,
      idempotency_key: params.key,
      ...(params.extra ?? {}),
    })
    .select("id")
    .maybeSingle();

  if (!error && data) {
    return { status: "claimed", claimId: (data as { id: string }).id };
  }

  if (error?.code !== UNIQUE_VIOLATION) {
    return { status: "error", message: error?.message ?? "Could not claim the key" };
  }

  // Lost the race, or this is an ordinary retry. Read the winner's row back.
  const { data: existing, error: readError } = await admin
    .from(table)
    .select(params.replayColumns)
    .eq("customer_id", params.customerId)
    .eq("idempotency_key", params.key)
    .maybeSingle();

  if (readError || !existing) {
    // The row collided a moment ago and is not readable now. Reporting this as
    // a failure is the safe direction: acting would be a second create, and the
    // caller's own retry will find a settled row.
    return {
      status: "error",
      message: readError?.message ?? "The key is in use but could not be read back",
    };
  }

  return { status: "replay", row: existing as Row };
}

/** Record what the claim produced, so a replay can rebuild the same answer. */
export async function settleClaim(
  admin: SupabaseClient,
  surface: IdempotentSurface,
  claimId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const { error } = await admin.from(SURFACES[surface]).update(fields).eq("id", claimId);
  if (error) console.error("[idempotency] settle failed", { surface, claimId, error });
}

/**
 * Hand the key back.
 *
 * ⚠️ CALL THIS WHENEVER THE WORK FAILS AFTER A SUCCESSFUL CLAIM. A claim left
 * behind by a failed create poisons that key for ever: every retry finds it,
 * replays a success, and reports a lead that does not exist. `stripe_events`
 * deletes its claim on a throw for exactly this reason, and §40.8 records the
 * cost of getting it wrong once already.
 */
export async function releaseClaim(
  admin: SupabaseClient,
  surface: IdempotentSurface,
  claimId: string
): Promise<void> {
  const { error } = await admin.from(SURFACES[surface]).delete().eq("id", claimId);
  if (error) {
    // Loud, because the consequence is silent: the customer's retries will all
    // replay a success that created nothing, and nothing else will notice.
    console.error("[idempotency] RELEASE FAILED — key is poisoned", {
      surface,
      claimId,
      error,
    });
  }
}
