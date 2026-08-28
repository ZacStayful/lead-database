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
