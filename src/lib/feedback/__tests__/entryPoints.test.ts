import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FEATURE_REQUEST_HEADER_PATH,
  FEATURE_REQUEST_LABEL,
  FEATURE_REQUEST_PATH,
  featureRequestPath,
} from "@/lib/featureRequest";

// §56.7: the header became a sidebar; the nav model is the one place the
// entry is declared, so the guard reads that file.
const NAV = readFileSync(join(process.cwd(), "src/lib/dashboardNav.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const SIDEBAR = readFileSync(join(process.cwd(), "src/components/shell/Sidebar.tsx"), "utf8");

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
    // The email and the banner have shipped; §50 must not move them.
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

describe("the dashboard sidebar", () => {
  it("carries the feature request as its own entry, on the header path", () => {
    // dashboardNav.ts is import-free by design, so it restates the path; the
    // nav test pins the restatement against featureRequest.ts.
    expect(NAV).toContain(`"${FEATURE_REQUEST_HEADER_PATH}"`);
    expect(NAV).toContain('label: "Request a feature"');
  });

  it("is a direct link, not a group", () => {
    // A group would put the promoted thing one click deeper than the footer
    // link it replaces, which is the opposite of the point.
    expect(NAV).toMatch(/key:\s*"feature",\s*label:\s*"Request a feature",\s*href:\s*FEATURE_REQUEST_HREF/);
  });

  it("keeps the label the customer already knows, and the bug link beside Settings", () => {
    expect(FEATURE_REQUEST_LABEL).toBe("Request a feature");
    expect(SIDEBAR).toContain('href="/feedback?type=bug"');
  });
});
