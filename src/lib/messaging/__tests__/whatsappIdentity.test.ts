/**
 * The two identity traps, both taken from LIVE data in the real workspace.
 *
 * These are not hypotheticals. Both shapes below were returned by list_chats
 * against the connected account while planning this feature, and either one
 * would silently bind a message to the wrong landlord.
 */
import { describe, it, expect } from "vitest";
import {
  isDialableJid,
  normalisePhone,
  phoneFromChat,
  matchKeyFromChat,
  isAllowedToMessage,
  toE164,
  resolveWebhookIdentity,
} from "../whatsappIdentity";

describe("TRAP 1 — the LID", () => {
  it("REJECTS a live @lid chat despite its populated phone field", () => {
    // Verbatim shape from the live workspace. `phone` looks like a number and
    // is not one; the jid is the tell.
    const chat = { phone: "+236974988349577", jid: "236974988349577@lid" };
    expect(isDialableJid(chat.jid)).toBe(false);
    expect(phoneFromChat(chat)).toBeNull();
    expect(matchKeyFromChat(chat)).toBeNull();
  });

  it("REJECTS the second live @lid chat", () => {
    const chat = { phone: "+150388430917656", jid: "150388430917656@lid" };
    expect(phoneFromChat(chat)).toBeNull();
  });

  it("accepts a genuine user jid", () => {
    const chat = { phone: "+447429592121", jid: "447429592121@s.whatsapp.net" };
    expect(phoneFromChat(chat)).toBe("447429592121");
    expect(matchKeyFromChat(chat)).toBe("429592121");
  });

  it("rejects a chat with no jid at all", () => {
    expect(phoneFromChat({ phone: "+447429592121" })).toBeNull();
    expect(phoneFromChat({ phone: "+447429592121", jid: null })).toBeNull();
  });

  it("rejects groups", () => {
    expect(
      phoneFromChat({
        phone: "+447429592121",
        jid: "447429592121@s.whatsapp.net",
        is_group: true,
      })
    ).toBeNull();
  });
});

describe("TRAP 2 — a valid jid is still not enough", () => {
  it("REJECTS the live '+0' chat, which PASSES the jid test", () => {
    // { "phone": "+0", "jid": "0@s.whatsapp.net" } — real, from the workspace.
    const chat = { phone: "+0", jid: "0@s.whatsapp.net" };
    expect(isDialableJid(chat.jid)).toBe(true); // the jid check says yes...
    expect(phoneFromChat(chat)).toBeNull(); // ...and normalisation saves us
  });

  it("rejects all-zero and too-short numbers", () => {
    expect(phoneFromChat({ phone: "+0000000000", jid: "0000000000@s.whatsapp.net" })).toBeNull();
    expect(phoneFromChat({ phone: "+12345", jid: "12345@s.whatsapp.net" })).toBeNull();
  });
});

describe("normalisePhone mirrors SQL normalised_phone (0070)", () => {
  // ⚠️ Duplicated on purpose (§27.2). These expectations are what the SQL
  // function returns; deriving them from the TS implementation would assert
  // nothing. If this table fails, the two normalisers have drifted and
  // landlords will be mis-matched.
  it.each([
    ["+447429592121", "429592121"],
    ["07429 592121", "429592121"],
    ["0033 689768525", "689768525"],
    ["0689 768525", "689768525"],
    ["0000 0000000", null],
    ["000000", null],
    ["123456", null], // 6 digits: under the floor
    ["1234567", "1234567"], // 7 digits: exactly at the floor
    ["+0", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("normalisePhone(%s) === %s", (input, expected) => {
    expect(normalisePhone(input as string | null)).toBe(expected);
  });

  it("compares on the last 9 digits, so country prefixes do not defeat a match", () => {
    expect(normalisePhone("+447429592121")).toBe(normalisePhone("07429592121"));
  });
});

describe("send guards", () => {
  it("honours is_allowed_to_message, defaulting to allowed when absent", () => {
    expect(isAllowedToMessage({ is_allowed_to_message: false })).toBe(false);
    expect(isAllowedToMessage({ is_allowed_to_message: true })).toBe(true);
    expect(isAllowedToMessage({})).toBe(true);
  });

  it("converts a UK lead phone to E.164, refusing junk", () => {
    expect(toE164("07429 592121")).toBe("+447429592121");
    expect(toE164("+447429592121")).toBe("+447429592121");
    expect(toE164("0000 0000000")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
  });
});

/**
 * The bug that stopped every reply reaching the system for a day.
 *
 * The shapes below are copied from a REAL read-back against the live workspace,
 * not from the docs — the docs are what produced the bug.
 */
describe("resolveWebhookIdentity", () => {
  /** Verbatim from GET /messages/55ff57a4-…, the landlord's actual reply. */
  const INBOUND = {
    from_me: false,
    sender_phone: "+447788643769",
    recipient_phone: "+447957516879",
  };

  /** The same call for a message the operator sent. */
  const OUTBOUND = {
    from_me: true,
    sender_phone: "+447957516879",
    recipient_phone: "+447788643769",
  };

  it("reads a landlord's reply as inbound, from the sender", () => {
    const r = resolveWebhookIdentity({ message: INBOUND });
    expect(r.direction).toBe("inbound");
    expect(r.rawPhone).toBe("+447788643769");
  });

  it("reads the operator's own send as outbound, from the recipient", () => {
    // The counterparty is the OTHER end, so it swaps with the direction. Taking
    // sender_phone unconditionally would file every outbound message against
    // the operator's own number and match no lead at all.
    const r = resolveWebhookIdentity({ message: OUTBOUND });
    expect(r.direction).toBe("outbound");
    expect(r.rawPhone).toBe("+447788643769");
  });

  it("resolves to the same match key the lead is stored under", () => {
    // 07788643769 in the leads table, +447788643769 on the wire.
    expect(normalisePhone(resolveWebhookIdentity({ message: INBOUND }).rawPhone)).toBe(
      normalisePhone("07788643769")
    );
  });

  /**
   * ⚠️ THE REGRESSION. The API has no `direction` field — reading one meant
   * `undefined`, which fell through to "not received" and filed a landlord's
   * reply as outbound.
   */
  it("does not depend on a `direction` field the API never returns", () => {
    const withStray = { ...INBOUND, direction: undefined } as unknown as typeof INBOUND;
    expect(resolveWebhookIdentity({ message: withStray }).direction).toBe("inbound");
  });

  it("falls back to the body only where the API said nothing", () => {
    const r = resolveWebhookIdentity({
      message: null,
      bodyJid: "447788643769@s.whatsapp.net",
      bodyDirection: "received",
    });
    expect(r.direction).toBe("inbound");
    expect(r.rawPhone).toBe("447788643769");
  });

  it("prefers the read-back over a body that disagrees", () => {
    const r = resolveWebhookIdentity({
      message: INBOUND,
      bodyJid: "447000000001@s.whatsapp.net",
      bodyDirection: "sent",
    });
    expect(r.direction).toBe("inbound");
    expect(r.rawPhone).toBe("+447788643769");
  });

  it("still applies both identity traps to a body-derived number", () => {
    // The live "+0" chat passes the jid test and must die on normalisation.
    expect(
      resolveWebhookIdentity({ message: null, bodyJid: "0@s.whatsapp.net" }).rawPhone
    ).toBeNull();
    // A LID is not a phone number and must never be read as one.
    expect(
      resolveWebhookIdentity({
        message: null,
        bodyJid: "236974988349577@lid",
        bodyPhone: null,
      }).rawPhone
    ).toBeNull();
  });

  it("returns null rather than guessing when nothing carries a number", () => {
    expect(resolveWebhookIdentity({ message: { from_me: false } }).rawPhone).toBeNull();
    expect(resolveWebhookIdentity({ message: null }).rawPhone).toBeNull();
  });
});
