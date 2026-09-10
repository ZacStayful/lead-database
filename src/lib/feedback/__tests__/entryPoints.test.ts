import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FEATURE_REQUEST_HEADER_PATH,
  FEATURE_REQUEST_LABEL,
  FEATURE_REQUEST_PATH,
  featureRequestPath,
} from "@/lib/featureRequest";

const LAYOUT = readFileSync(join(process.cwd(), "src/app/dashboard/layout.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the feature request link", () => {
  it("attributes each entry point differently", () => {
    // ⚠️ THE WHOLE REASON THE PARAMETER EXISTS. One shared constant would have
    // made the header report itself as "Announcement", and "did promoting it
    // work?" would have become unanswerable — while still looking answered.
    expect(FEATURE_REQUEST_PATH).not.toBe(FEATURE_REQUEST_HEADER_PATH);
    expect(FEATURE_REQUEST_PATH).toContain("page=Announcement");
    expect(FEATURE_REQUEST_HEADER_PATH).toContain("page=Header");
  });

  it("did not change the announcement link", () => {
    // The email and the banner have shipped; §47 must not move them.
    expect(FEATURE_REQUEST_PATH).toBe("/feedback?type=feature&page=Announcement");
  });

  it("always names the type explicitly", () => {
    // The page defaults to `feature` for any non-bug value, and the link must
    // not depend on that default staying put.
    expect(featureRequestPath("Anywhere")).toContain("type=feature");
  });

  it("escapes a source that would otherwise break the query string", () => {
    expect(featureRequestPath("Leads & offers")).toContain("page=Leads%20%26%20offers");
  });
});

describe("the dashboard header", () => {
  it("carries the feature request as a top-level entry", () => {
    expect(LAYOUT).toContain("FEATURE_REQUEST_HEADER_PATH");
    expect(LAYOUT).toContain("FEATURE_REQUEST_LABEL");
  });

  it("is a direct link, not a dropdown", () => {
    // A group would put the promoted thing one click deeper than the footer
    // link it replaces, which is the opposite of the point.
    expect(LAYOUT).toMatch(
      /\{\s*label:\s*FEATURE_REQUEST_LABEL,\s*href:\s*FEATURE_REQUEST_HEADER_PATH\s*\}/
    );
  });

  it("is not the last entry, where the bell collision happened", () => {
    // "Admin" is appended after this array for admins, so anything sitting last
    // here is the entry that meets the notification bell first when the row
    // runs out of room.
    const feature = LAYOUT.indexOf("FEATURE_REQUEST_LABEL,");
    const account = LAYOUT.indexOf('label: "Account"');
    expect(feature).toBeGreaterThan(-1);
    expect(account).toBeGreaterThan(feature);
  });

  it("keeps the label the customer already knows from the footer", () => {
    expect(FEATURE_REQUEST_LABEL).toBe("Request a feature");
    expect(LAYOUT).toContain('href="/feedback?type=feature"');
  });
});
