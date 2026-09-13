/**
 * Send one booking-chase WhatsApp to a PROSPECT (§55).
 *
 * ⚠️ WHY THIS IS NOT sendOneMessage(). That function is assignment-shaped: it
 * takes a SendableAssignment, calls assignmentSendable, keys its idempotency on
 * a lead and books a thread against one. A prospect has no lead and no
 * assignment, so there is nothing to hand it. What is reused instead is every
 * primitive underneath it — the vendor client, the credential, the strict phone
 * rule — so there is still exactly one implementation of each.
 *
 * ⚠️ AND IT WRITES NOTHING TO lead_messages, lead_message_threads OR
 * lead_notes. §40.6: about twenty-five predicates read lead_notes, and a row
 * there is a CLAIM THAT AN OPERATOR DID WORK — it bars the lead from the
 * expired pool, exempts it from escalation, blocks discard and blocks the
 * filter refund. A lead_messages row is a delivery claim tied to a lead that
 * does not exist here, and would corrupt the thread view, the status poller and
 * every reporting join. prospect_nudge_sends is the record.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, timelinesTokenAad } from "@/lib/crypto/secretBox";
import { sendMessage as sendWhatsapp } from "@/lib/messaging/timelines";
import { normaliseUkMobile } from "@/lib/leadQuality";
import { toE164 } from "@/lib/messaging/whatsappIdentity";

export type ProspectSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; code: string; detail?: string };

/**
 * Resolve a prospect's stored number to something TimelinesAI will accept.
 *
 * ⚠️ THE STRICT RULE, NOT THE MATCHING ONE — §40.9A's lesson, which cost a live
 * send. `toE164` is built on normalisePhone, the 0070 IDENTITY rule (seven
 * digits, not all zeros), whose job is deciding whether two records describe
 * the same person. It is not a test of whether a number can receive anything,
 * and a number one digit short sails straight through it to a bare http_400.
 *
 * A FOREIGN number is a fact rather than an error (§36.2) and goes to the
 * provider as-is; the provider decides. Everything else that fails the UK
 * mobile test is refused here, before any credential is touched.
 *
 * Pure, so the whole rule is testable without a client.
 */
export function prospectPhone(
  raw: string | null | undefined
): { ok: true; phone: string } | { ok: false; code: string } {
  const uk = normaliseUkMobile(raw);
  if (!uk.ok && uk.reason !== "foreign") {
    return { ok: false, code: `bad_phone_${uk.reason}` };
  }
  const phone = uk.ok ? `+44${uk.value.slice(1)}` : toE164(raw ?? "");
  if (!phone) return { ok: false, code: "bad_phone_unresolvable" };
  return { ok: true, phone };
}

interface ConnectionRow {
  status: string;
  token_ciphertext: string | null;
  whatsapp_account_phone: string | null;
}

/**
 * Send, using the workspace named by `prospect_nudge_sender_customer_id`.
 *
 * ⚠️ QUIET HOURS ARE NOT CONSULTED, AND THAT IS A DECISION RATHER THAN AN
 * OMISSION. §40.12 holds every landlord message to 09:00–20:00 London; the
 * instruction for this feature is that a prospect hears back within two
 * minutes whatever the hour, because they are still at the screen they just
 * filled the form in on. About 1 in 7 enquiries lands outside that window.
 * If that is ever revisited, the window helpers are in
 * src/lib/messaging/sendWindow.ts and this is the only call site to change.
 */
export async function sendProspectWhatsapp(
  admin: SupabaseClient,
  params: { senderCustomerId: string; toPhone: string | null; text: string }
): Promise<ProspectSendResult> {
  const resolved = prospectPhone(params.toPhone);
  if (!resolved.ok) return { ok: false, code: resolved.code };

  const { data, error } = await admin
    .from("customer_whatsapp_connections")
    .select("status, token_ciphertext, whatsapp_account_phone")
    .eq("customer_id", params.senderCustomerId)
    .maybeSingle();

  if (error) return { ok: false, code: "connection_unreadable", detail: error.message };
  const conn = data as ConnectionRow | null;
  if (!conn) return { ok: false, code: "not_connected" };
  // Production's only row has sat at 'revoked' since 2026-08-28, so this is the
  // branch that fires until somebody pastes a fresh token into Settings.
  if (conn.status !== "connected") {
    return { ok: false, code: "not_connected", detail: conn.status };
  }

  let token: string;
  try {
    token = decryptSecret(
      conn.token_ciphertext ?? "",
      timelinesTokenAad(params.senderCustomerId)
    );
  } catch {
    return { ok: false, code: "credential_unreadable" };
  }

  const sent = await sendWhatsapp(token, {
    phone: resolved.phone,
    text: params.text,
    whatsappAccountPhone: conn.whatsapp_account_phone ?? undefined,
  });

  if (!sent.ok) {
    // The vendor's own explanation, which §40.9A records was being discarded.
    console.error("[prospect-nudge] whatsapp send failed", {
      code: sent.code,
      detail: sent.detail,
    });
    return { ok: false, code: sent.code, detail: sent.detail };
  }

  // ⚠️ THE API'S OWN FIELD IS `uid`; `message_uid` is what the WEBHOOK body
  // uses (§40.8, verified against a live message). The declared type says
  // message_uid, so read both rather than trusting one name — a null here is
  // only a lost provider id, but it is the id you want when chasing a delivery.
  const raw = sent.data as unknown as { message_uid?: string; uid?: string };
  return { ok: true, providerMessageId: raw?.message_uid ?? raw?.uid ?? null };
}
