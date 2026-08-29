/**
 * The cross-operator cooldown (§40.12).
 *
 * One landlord can be held by several operators at once — 136 of 441 leads are
 * held by two or more today, 28 by three or more, and one by five. None of them
 * can see each other, and until this existed nothing stopped all of them
 * messaging the same person on the same morning. Every other limit in this
 * feature is per customer and cannot ask the question.
 *
 * ⚠️ THIS IS THE ONLY CUSTOMER-AGNOSTIC READ IN THE MESSAGING FEATURE, and it
 * breaches on purpose what 0116's header calls the containment guarantee:
 *
 *     A landlord held by two operators produces TWO threads, one per customer.
 *     The leading customer_id in every unique key is the containment guarantee:
 *     one customer's conversation is structurally unreachable from another's.
 *
 * Every other read in src/ is `.eq("customer_id", …)`. This one has to reach
 * across, because it exists to ask a question about the other operators — so
 * the crossing is confined to this one function, and:
 *
 * ⚠️ IT RETURNS A BOOLEAN AND NOTHING ELSE. No customer id, no name, no count,
 * no timestamp, not even how long is left. §19.7 removed previous-holder
 * information from the pool row set entirely "so no later UI change can reach
 * for it", and 0075's header repeats it in SQL; the rule covers the count, the
 * identity, AND whether they acted at all. A richer return value is a probe:
 * operator A learns when operator B is working a shared landlord.
 *
 * That is also why the caller's message names no retry time. "You can message
 * them again after 4pm tomorrow", minus a cooldown length anyone can measure by
 * experiment, IS the other operator's send time — §19.7's "three operators
 * passed on this" arrived at by subtraction.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Mirrors 0120. A missing setting means this, not "no cooldown". */
export const DEFAULT_LEAD_COOLDOWN_HOURS = 24;

/**
 * The only shape this may return. Widening it is the failure mode the whole
 * module is written against, so the type says so.
 */
export interface CooldownVerdict {
  blocked: boolean;
}

/**
 * Has a DIFFERENT operator messaged this landlord within the cooldown?
 *
 * Keyed on the phone rather than on `lead_id`. §18's duplicate-landlord problem
 * means one person can arrive as several `leads` rows — 28 exact groups when
 * 0070 was written, and deliberately no unique constraint on the identity key —
 * so `lead_id` under-counts in precisely the case that matters: three operators
 * each holding a different row for the same landlord. `counterparty_phone_norm`
 * is generated from `normalised_phone()` and is the identity key the rest of
 * this feature already uses, for that same reason.
 *
 * `status <> 'failed'` mirrors the existing daily cap: a failed send reached
 * nobody, so it must not block anybody else either.
 *
 * FAILS OPEN on a query error, and that is the deliberate choice: this guard
 * protects a landlord from a second message, where the send route's other
 * failure modes protect the operator's own number. Refusing every send because
 * one read failed would take a paid feature down to prevent a duplicate
 * message; letting it through costs at worst one extra message to somebody who
 * was going to be contacted by that operator anyway. The error is logged so a
 * persistent failure is visible rather than silently permissive.
 */
export async function otherOperatorMessagedRecently(
  admin: SupabaseClient,
  params: {
    phoneKey: string;
    customerId: string;
    cooldownHours: number;
    now?: Date;
  }
): Promise<CooldownVerdict> {
  const { phoneKey, customerId, cooldownHours } = params;
  if (!phoneKey || cooldownHours <= 0) return { blocked: false };

  const since = new Date(
    (params.now ?? new Date()).getTime() - cooldownHours * 60 * 60 * 1000
  ).toISOString();

  // Threads first: the phone is the identity, and 0120's partial index on
  // counterparty_phone_norm is what keeps this off a sequential scan. The
  // existing unique index leads on customer_id and cannot serve this.
  const { data: threads, error: threadError } = await admin
    .from("lead_message_threads")
    .select("id")
    .eq("channel", "whatsapp")
    .eq("counterparty_phone_norm", phoneKey)
    .neq("customer_id", customerId);

  if (threadError) {
    console.error("[contactLimits] thread lookup failed", threadError.message);
    return { blocked: false };
  }

  const ids = (threads ?? []).map((t) => (t as { id: string }).id);
  if (ids.length === 0) return { blocked: false };

  const { count, error } = await admin
    .from("lead_messages")
    .select("id", { count: "exact", head: true })
    .in("thread_id", ids)
    .eq("direction", "outbound")
    .neq("status", "failed")
    .gte("created_at", since);

  if (error) {
    console.error("[contactLimits] message count failed", error.message);
    return { blocked: false };
  }

  // Only ever the boolean. The count is discarded here rather than returned.
  return { blocked: (count ?? 0) > 0 };
}

/**
 * What the operator is told, and all they are told.
 *
 * Attributes the block to US — a Stayful contact limit — and asserts nothing
 * about anybody else. It does not say another operator messaged them, does not
 * say when, and carries no digits at all, which a unit test pins so that a
 * future "helpful" addition of a retry time fails the build rather than
 * shipping a leak.
 *
 * It names what they CAN still do, because a refusal with no alternative reads
 * as the product being broken rather than as a rule.
 */
export const LEAD_COOLDOWN_MESSAGE =
  "Messaging is paused for this landlord under our contact limits. You can still call them, and your notes and pipeline are unaffected.";
