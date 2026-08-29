/**
 * The wa.me hand-off (§40.15).
 *
 * WHAT IS ACTUALLY AT RISK HERE IS A SILENTLY DEAD BUTTON. A malformed deep
 * link does not throw and does not 400 — WhatsApp simply opens and says the
 * number is invalid, in front of the landlord's name, and the operator concludes
 * the feature is broken. So the cases below are the shapes the 449 live leads
 * are ACTUALLY stored in, taken from the database rather than invented:
 * `07700 900123` (55% of them), `+447700900123`, `+44 07700 900123` (90 of
 * them — a country code followed by a national trunk zero), `0044…`, and the
 * punctuated forms.
 *
 * The other half is the ENCODING. The text goes into a URL query parameter, and
 * a message that loses its line breaks — or stops at the first `&` — is worse
 * than no draft at all, because the operator sends it without re-reading.
 */
import { describe, expect, it } from "vitest";
import {
  HANDOFF_MAX_TEXT,
  WHATSAPP_DEEP_LINK_BASE,
  handoffDigits,
  whatsappHandoffLink,
} from "@/lib/messaging/handoff";

const TEXT = "Hi Sarah, saw your enquiry about the flat.";

describe("the shapes leads are actually stored in", () => {
  it("takes a plain national mobile", () => {
    expect(handoffDigits("07700900123")).toBe("447700900123");
  });

  it("takes the spaced national form, which is 55% of the book", () => {
    expect(handoffDigits("07700 900123")).toBe("447700900123");
  });

  it("takes an already-international number", () => {
    expect(handoffDigits("+447700900123")).toBe("447700900123");
  });

  /**
   * The one that would have broken 90 leads. `+44` and then a national trunk
   * zero: naively concatenating gives 4407700900123, which WhatsApp rejects.
   * leadQuality.ts:131 is the line that saves it.
   */
  it("strips the trunk zero after a country code", () => {
    expect(handoffDigits("+44 07700 900123")).toBe("447700900123");
    expect(handoffDigits("4407700900123")).toBe("447700900123");
  });

  it("takes the 00 dialling prefix", () => {
    expect(handoffDigits("0044 7700900123")).toBe("447700900123");
  });

  it("ignores brackets, hyphens and spaces", () => {
    expect(handoffDigits("(07700) 900-123")).toBe("447700900123");
  });
});

describe("numbers that must produce no link at all", () => {
  // A landline opens WhatsApp to "this number is not on WhatsApp". §18E: that
  // reads as a bug, where an absent button reads as missing data.
  it("refuses a UK landline", () => {
    expect(handoffDigits("020 7946 0000")).toBeNull();
  });

  it("refuses a placeholder somebody typed to clear a required field", () => {
    expect(handoffDigits("0000 0000000")).toBeNull();
  });

  it("refuses a number a digit short", () => {
    expect(handoffDigits("+44778643769")).toBeNull();
  });

  it("refuses empty, blank and null", () => {
    expect(handoffDigits("")).toBeNull();
    expect(handoffDigits("   ")).toBeNull();
    expect(handoffDigits(null)).toBeNull();
    expect(handoffDigits(undefined)).toBeNull();
  });
});

describe("§36.2 — a landlord abroad is a fact, not an error", () => {
  it("lets an explicitly foreign number through", () => {
    expect(handoffDigits("+353 86 123 4567")).toBe("353861234567");
  });

  it("still returns bare digits for it, with no plus", () => {
    expect(handoffDigits("+353861234567")).not.toContain("+");
  });
});

describe("the link itself", () => {
  // §40.11: the URL is a pinned constant, never typed into JSX.
  it("is built on the wa.me short form", () => {
    expect(WHATSAPP_DEEP_LINK_BASE).toBe("https://wa.me/");
  });

  it("carries bare digits — a plus here is what breaks the deep link", () => {
    const link = whatsappHandoffLink("+44 07700 900123", TEXT)!;
    expect(link.startsWith("https://wa.me/447700900123?text=")).toBe(true);
    expect(link.slice(0, link.indexOf("?"))).not.toContain("+");
  });

  it("returns null when there is no usable number", () => {
    expect(whatsappHandoffLink("020 7946 0000", TEXT)).toBeNull();
    expect(whatsappHandoffLink(null, TEXT)).toBeNull();
  });
});

describe("encoding — what the operator wrote is what WhatsApp opens with", () => {
  const roundTrip = (body: string) => {
    const link = whatsappHandoffLink("07700900123", body)!;
    return decodeURIComponent(link.slice(link.indexOf("?text=") + 6));
  };

  it("keeps line breaks", () => {
    const body = "Hi Sarah,\n\nSaw your enquiry.\nWorth a quick chat?";
    expect(roundTrip(body)).toBe(body);
  });

  // An unescaped & truncates the message at that point, silently.
  it("keeps an ampersand, and does not truncate there", () => {
    const body = "Are you after management & guaranteed rent?";
    expect(roundTrip(body)).toBe(body);
  });

  it("keeps apostrophes, accents and emoji", () => {
    const body = "It's Zoë's place — worth a chat? 👍";
    expect(roundTrip(body)).toBe(body);
  });

  it("escapes the characters that would otherwise end the parameter", () => {
    const link = whatsappHandoffLink("07700900123", "a&b c#d")!;
    const q = link.slice(link.indexOf("?text=") + 6);
    expect(q).not.toContain("&");
    expect(q).not.toContain("#");
    expect(q).not.toContain(" ");
  });
});

describe("the message ceiling — it rejects, it does not repair", () => {
  it("matches validateDraft's ceiling rather than inventing one", () => {
    expect(HANDOFF_MAX_TEXT).toBe(480);
  });

  it("accepts a message exactly at the ceiling", () => {
    expect(whatsappHandoffLink("07700900123", "x".repeat(HANDOFF_MAX_TEXT)))
      .not.toBeNull();
  });

  // Truncating would send a landlord half a sentence from the operator's own
  // number. Refusing shows them the number and lets them cut it themselves.
  it("refuses one character over, rather than truncating", () => {
    expect(whatsappHandoffLink("07700900123", "x".repeat(HANDOFF_MAX_TEXT + 1)))
      .toBeNull();
  });

  it("refuses an empty or whitespace-only message", () => {
    expect(whatsappHandoffLink("07700900123", "")).toBeNull();
    expect(whatsappHandoffLink("07700900123", "   \n  ")).toBeNull();
  });

  it("measures the trimmed message, not the raw one", () => {
    const body = "  " + "x".repeat(HANDOFF_MAX_TEXT) + "  ";
    expect(whatsappHandoffLink("07700900123", body)).not.toBeNull();
  });
});
