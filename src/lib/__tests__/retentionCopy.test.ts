import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  KEEP_CRM_POINTS,
  KEEP_CRM_SUMMARY,
  keepCrmBulletsHtml,
} from "../retentionCopy";

/** The escaper `emails.ts` passes in, reproduced so the HTML test is honest. */
function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function source(relative: string): string {
  return readFileSync(join(__dirname, "..", "..", relative), "utf8");
}

describe("KEEP_CRM_POINTS", () => {
  it("states the limitation as well as the offer", () => {
    expect(KEEP_CRM_POINTS.length).toBeGreaterThan(0);
    // Shown to somebody who is leaving: if it only lists what they keep it
    // reads as a sales pitch, and the one thing they most need to understand —
    // that no new leads arrive — is the thing that would be missing.
    expect(
      KEEP_CRM_POINTS.some((p) => /only thing that stops|new leads/i.test(p))
    ).toBe(true);
  });

  it("is free of markup, so every consumer can escape it its own way", () => {
    for (const point of KEEP_CRM_POINTS) {
      expect(point).not.toMatch(/[<>]/);
      expect(point.trim()).toBe(point);
    }
    expect(KEEP_CRM_SUMMARY).not.toMatch(/[<>]/);
  });
});

describe("keepCrmBulletsHtml", () => {
  it("emits every point as an escaped list item", () => {
    const html = keepCrmBulletsHtml(esc);
    for (const point of KEEP_CRM_POINTS) {
      expect(html).toContain(`<li>${esc(point)}</li>`);
    }
    expect(html.match(/<li>/g)).toHaveLength(KEEP_CRM_POINTS.length);
  });

  it("routes every point through the escaper it is given", () => {
    // Proves the points are not interpolated raw. If somebody later edits a
    // point to contain an ampersand, the emails must not ship broken markup.
    const shouty = keepCrmBulletsHtml((v) => `[${v}]`);
    for (const point of KEEP_CRM_POINTS) {
      expect(shouty).toContain(`<li>[${point}]</li>`);
    }
  });
});

describe("the four surfaces all read from this module", () => {
  // The whole reason this file exists. A surface that stops importing it has
  // started keeping its own copy of the promise, which is how the screen and
  // the email come to say different things.
  const surfaces = [
    "components/dashboard/SettingsPanel.tsx",
    "components/dashboard/CancelSubscriptionCard.tsx",
    "lib/emails.ts",
  ];

  for (const surface of surfaces) {
    it(`${surface} imports the shared copy`, () => {
      expect(source(surface)).toContain("@/lib/retentionCopy");
    });
  }

  it("covers both confirmation emails", () => {
    const emails = source("lib/emails.ts");
    for (const fn of [
      "sendSubscriptionPausedEmail",
      "sendSubscriptionCancelledEmail",
    ]) {
      const start = emails.indexOf(`export async function ${fn}`);
      expect(start).toBeGreaterThan(-1);
      const body = emails.slice(start, emails.indexOf("\nexport ", start + 1));
      expect(body).toContain("keepCrmBulletsHtml(esc)");
    }
  });
});
