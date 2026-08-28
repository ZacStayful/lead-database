/**
 * Finding the one conversation with a landlord (§40).
 *
 * ⚠️ THIS IS THE SECOND BUG THAT STOPPED REPLIES REACHING THE SYSTEM, and it is
 * a different one from the identity fix in `resolveWebhookIdentity`.
 *
 * `lead_message_threads` is UNIQUE on `(customer_id, counterparty_phone_norm)`
 * for WhatsApp — a generated column, `normalised_phone(counterparty_phone)`.
 * Both call sites looked the thread up by the RAW string instead:
 *
 *     .eq("counterparty_phone", rawPhone)
 *
 * The send path stores what the lead's row holds (`07788643769`). An inbound
 * webhook carries the same number in international form (`+447788643769`). Those
 * are different strings and the SAME normalised key — so the lookup missed, the
 * insert then violated the unique index, and the event was discarded for having
 * no thread. Every reply on a number we had already messaged died there, which
 * is every reply worth having.
 *
 * The lookup now uses the key the constraint uses. A 23505 on the insert is
 * treated as "somebody else just made it" and re-read, which also closes the
 * genuine race between two events arriving together.
 *
 * ONE DEFINITION, both callers — the discipline §19.4 uses for
 * `customer_can_see_pool_lead` and §22 for `announcementTargetsCustomer`. Two
 * readings of "which conversation is this" is exactly how this happened.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export async function findOrCreateWhatsappThread(
  admin: Admin,
  p: {
    customerId: string;
    assignmentId: string | null;
    leadId: string | null;
    /** As it will be stored if this creates the thread. */
    rawPhone: string;
    /** normalisePhone(rawPhone) — the key the unique index is built on. */
    phoneKey: string;
    providerChatId?: string | null;
  }
): Promise<string | null> {
  const findByKey = async () => {
    const { data } = await admin
      .from("lead_message_threads")
      .select("id")
      .eq("customer_id", p.customerId)
      .eq("channel", "whatsapp")
      .eq("counterparty_phone_norm", p.phoneKey)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };

  const existing = await findByKey();
  if (existing) return existing;

  const { data: made, error } = await admin
    .from("lead_message_threads")
    .insert({
      customer_id: p.customerId,
      assignment_id: p.assignmentId,
      lead_id: p.leadId,
      channel: "whatsapp",
      counterparty_phone: p.rawPhone,
      provider_chat_id: p.providerChatId ?? null,
    })
    .select("id")
    .maybeSingle();

  if (made) return (made as { id: string }).id;

  // 23505: the thread exists under a differently-formatted raw phone, or a
  // concurrent event created it a moment ago. Either way, re-read by the key.
  if ((error as { code?: string } | null)?.code === "23505") {
    return findByKey();
  }

  if (error) {
    console.error("[messaging/threads] create failed", error.message);
  }
  return null;
}
