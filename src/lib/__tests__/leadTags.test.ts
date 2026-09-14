import { describe, expect, it } from "vitest";
import { normaliseTags } from "../leadTags";
import { validateSnippet, snippetsForChannel, type Snippet } from "../messaging/snippets";

describe("normaliseTags", () => {
  it("trims, collapses whitespace, drops empties and dedupes case-insensitively", () => {
    expect(normaliseTags(["  hot ", "Hot", "", "3-bed\n\nBristol", "hot"])).toEqual({
      ok: true,
      tags: ["hot", "3-bed Bristol"],
    });
  });

  it("refuses a non-array and a non-string element", () => {
    expect(normaliseTags("hot").ok).toBe(false);
    expect(normaliseTags(["hot", 3]).ok).toBe(false);
  });

  it("bounds the length of a tag and the number of tags to the DB CHECK", () => {
    expect(normaliseTags(["x".repeat(41)]).ok).toBe(false);
    expect(normaliseTags(["x".repeat(40)]).ok).toBe(true);
    expect(normaliseTags(Array.from({ length: 21 }, (_, i) => `t${i}`)).ok).toBe(false);
    expect(normaliseTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).ok).toBe(true);
  });

  it("an empty list clears the tags", () => {
    expect(normaliseTags([])).toEqual({ ok: true, tags: [] });
  });
});

describe("validateSnippet", () => {
  it("accepts a titled body on channel any by default", () => {
    expect(validateSnippet({ title: " Intro ", body: "Hi {{first_name}}, it's Michael." })).toEqual({
      ok: true,
      title: "Intro",
      body: "Hi {{first_name}}, it's Michael.",
      channel: "any",
    });
  });

  it("refuses a raw link and points at the booking-link field", () => {
    const r = validateSnippet({ title: "Book", body: "Book here https://calendly.com/x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/booking_link/);
    expect(validateSnippet({ title: "Book", body: "see www.example.com" }).ok).toBe(false);
    expect(validateSnippet({ title: "Book", body: "Use {{booking_link}} to pick a time" }).ok).toBe(true);
  });

  it("refuses an empty title, an empty body, an over-long body and an unknown channel", () => {
    expect(validateSnippet({ title: "", body: "x" }).ok).toBe(false);
    expect(validateSnippet({ title: "t", body: "   " }).ok).toBe(false);
    expect(validateSnippet({ title: "t", body: "x".repeat(481) }).ok).toBe(false);
    expect(validateSnippet({ title: "t", body: "x".repeat(480) }).ok).toBe(true);
    expect(validateSnippet({ title: "t", body: "x", channel: "sms" }).ok).toBe(false);
  });
});

describe("snippetsForChannel", () => {
  const list: Snippet[] = [
    { id: "1", channel: "any", title: "a", body_template: "a", is_active: true, created_at: "", updated_at: "" },
    { id: "2", channel: "email", title: "b", body_template: "b", is_active: true, created_at: "", updated_at: "" },
    { id: "3", channel: "whatsapp", title: "c", body_template: "c", is_active: false, created_at: "", updated_at: "" },
  ];
  it("offers 'any' plus the channel's own, active only", () => {
    expect(snippetsForChannel(list, "whatsapp").map((s) => s.id)).toEqual(["1"]);
    expect(snippetsForChannel(list, "email").map((s) => s.id)).toEqual(["1", "2"]);
  });
});
