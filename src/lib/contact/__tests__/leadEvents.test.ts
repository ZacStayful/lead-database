import { describe, expect, it } from "vitest";
import {
  CONTACT_EVENT_TYPES,
  countAttempts,
  isContactEvent,
} from "@/lib/contact/leadEvents";
import { CLIENT_LEAD_EVENT_TYPES } from "@/lib/types";

const ev = (t: string) => ({ event_type: t } as never);

describe("CONTACT_EVENT_TYPES", () => {
  it("is exactly the four going-after-the-landlord signals", () => {
    // A literal list on purpose (§27.2): deriving it from LeadEventType would
    // let a future addition join silently.
    expect([...CONTACT_EVENT_TYPES]).toEqual([
      "tel_click",
      "whatsapp_click",
      "mailto_click",
      "message_sent",
    ]);
  });

  it("EXCLUDES detail_opened — reading a lead is not contacting it", () => {
    expect(isContactEvent("detail_opened")).toBe(false);
  });

  it("excludes our own nudges, as every aggregate must (§3)", () => {
    expect(isContactEvent("nudge_sent")).toBe(false);
  });

  it("excludes an inbound reply — that is the landlord's act, not the operator's", () => {
    expect(isContactEvent("message_received")).toBe(false);
  });

  it("excludes record-keeping that proves no outreach", () => {
    expect(isContactEvent("note_added")).toBe(false);
    expect(isContactEvent("file_added")).toBe(false);
    expect(isContactEvent("stage_changed")).toBe(false);
  });

  it("counts every client-writable contact type, so a button cannot go unrecorded", () => {
    const clickable = CLIENT_LEAD_EVENT_TYPES.filter((t) => t !== "detail_opened");
    for (const t of clickable) expect(isContactEvent(t)).toBe(true);
  });
});

describe("countAttempts", () => {
  it("is 0 for no events, null and undefined", () => {
    expect(countAttempts([])).toBe(0);
    expect(countAttempts(null)).toBe(0);
    expect(countAttempts(undefined)).toBe(0);
  });

  it("counts one click", () => {
    expect(countAttempts([ev("tel_click")])).toBe(1);
  });

  it("counts mixed channels", () => {
    expect(
      countAttempts([ev("tel_click"), ev("whatsapp_click"), ev("mailto_click")])
    ).toBe(3);
  });

  it("ignores opens and nudges among real attempts", () => {
    expect(
      countAttempts([
        ev("detail_opened"),
        ev("tel_click"),
        ev("nudge_sent"),
        ev("detail_opened"),
        ev("whatsapp_click"),
      ])
    ).toBe(2);
  });

  it("returns 0 for a lead that was only ever looked at — the 666-vs-15 case", () => {
    expect(countAttempts(Array.from({ length: 40 }, () => ev("detail_opened")))).toBe(0);
  });
});
