import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  activeSidebarKey,
  activeTabHref,
  buildSidebar,
  FEATURE_REQUEST_HREF,
  REPLACEMENTS_HREF,
  sectionTitle,
  tabsetFor,
  type NavFlags,
} from "../dashboardNav";
import { FEATURE_REQUEST_HEADER_PATH } from "../featureRequest";
import { REPLACEMENT_PATH } from "../quality/replacementEntitlement";

const ALL: NavFlags = {
  messagingOn: true,
  adsOn: true,
  holdsManagement: true,
  holdsAny: true,
  isAdmin: true,
  unreadReplies: 3,
};
const NONE: NavFlags = {
  messagingOn: false,
  adsOn: false,
  holdsManagement: false,
  holdsAny: false,
  isAdmin: false,
  unreadReplies: 0,
};

const APP = path.resolve(__dirname, "../../app");
function pageExists(href: string): boolean {
  const p = href.split("?")[0].split("#")[0];
  if (!p.startsWith("/dashboard") && !p.startsWith("/admin") && !p.startsWith("/feedback")) return false;
  return existsSync(path.join(APP, p.slice(1), "page.tsx"));
}

describe("buildSidebar", () => {
  it("restates the two path constants exactly", () => {
    expect(REPLACEMENTS_HREF).toBe(REPLACEMENT_PATH);
    expect(FEATURE_REQUEST_HREF).toBe(FEATURE_REQUEST_HEADER_PATH);
  });

  it("keeps Request a feature as a direct item and Admin for admins only", () => {
    const keys = (f: NavFlags) => buildSidebar(f).secondary.map((i) => i.key);
    expect(keys(ALL)).toContain("feature");
    expect(keys(NONE)).toContain("feature");
    expect(keys(ALL)).toContain("admin");
    expect(keys(NONE)).not.toContain("admin");
  });

  it("gates Follow-ups on messaging and API access on holding a product", () => {
    expect(buildSidebar(ALL).main.map((i) => i.key)).toContain("followups");
    expect(buildSidebar(NONE).main.map((i) => i.key)).not.toContain("followups");
    expect(buildSidebar(ALL).secondary.map((i) => i.key)).toContain("api");
    expect(buildSidebar(NONE).secondary.map((i) => i.key)).not.toContain("api");
  });

  it("puts the unread-reply count on Conversations only, and only above zero", () => {
    const m = buildSidebar(ALL);
    expect(m.main.find((i) => i.key === "conversations")?.badge).toBe(3);
    expect(m.main.filter((i) => i.badge !== undefined)).toHaveLength(1);
    expect(buildSidebar(NONE).main.find((i) => i.key === "conversations")?.badge).toBeUndefined();
  });

  // §61: nobody found Replace a lead while it was a sub-tab alone, so it is a
  // sidebar item of its own, directly under Leads, for everyone.
  it("puts Replace a lead directly under Leads in the sidebar, for everyone", () => {
    for (const f of [ALL, NONE]) {
      const keys = buildSidebar(f).main.map((i) => i.key);
      expect(keys.indexOf("replacements")).toBe(keys.indexOf("leads") + 1);
    }
    const item = buildSidebar(ALL).main.find((i) => i.key === "replacements")!;
    expect(item.href).toBe(REPLACEMENTS_HREF);
    expect(item.label).toBe("Replace a lead");
  });

  it("every href resolves to a page on disk", () => {
    const m = buildSidebar(ALL);
    for (const i of [...m.main, ...m.secondary, m.bottom]) {
      expect(pageExists(i.href), i.href).toBe(true);
    }
  });

  it("never offers SMS anywhere", () => {
    const src = readFileSync(path.resolve(__dirname, "../dashboardNav.ts"), "utf8");
    expect(/\bsms\b/i.test(src)).toBe(false);
  });
});

describe("activeSidebarKey", () => {
  const m = buildSidebar(ALL);
  it("lights by longest prefix, with the design's overrides", () => {
    expect(activeSidebarKey(m, "/dashboard")).toBe("dashboard");
    expect(activeSidebarKey(m, "/dashboard/leads/priority")).toBe("leads");
    expect(activeSidebarKey(m, "/dashboard/leads/abc-123")).toBe("leads");
    expect(activeSidebarKey(m, "/dashboard/replacements")).toBe("replacements");
    expect(activeSidebarKey(m, "/dashboard/filtering")).toBe("filtering");
    expect(activeSidebarKey(m, "/dashboard/documents")).toBe("documents");
    expect(activeSidebarKey(m, "/dashboard/guide")).toBe("learn");
    expect(activeSidebarKey(m, "/dashboard/goals")).toBe("insights");
    expect(activeSidebarKey(m, "/dashboard/follow-ups")).toBe("followups");
    expect(activeSidebarKey(m, "/dashboard/conversations/xyz")).toBe("conversations");
    expect(activeSidebarKey(m, "/dashboard/settings/messaging")).toBe("settings");
  });
});

describe("tabsetFor", () => {
  it("includes Replace a lead in the Leads tabset and gates Goals on management", () => {
    const leads = tabsetFor("/dashboard/leads", ALL)!;
    expect(leads.tabs.map((t) => t.href)).toContain(REPLACEMENTS_HREF);
    expect(tabsetFor("/dashboard/analytics", ALL)!.tabs.map((t) => t.label)).toContain("Goals");
    expect(tabsetFor("/dashboard/analytics", NONE)!.tabs.map((t) => t.label)).not.toContain("Goals");
  });

  it("has no tabset for the dashboard, API, support and notifications", () => {
    for (const p of ["/dashboard", "/dashboard/api", "/dashboard/support", "/dashboard/notifications"]) {
      expect(tabsetFor(p, ALL)).toBeNull();
      expect(sectionTitle(p)).not.toBe("Lead Database");
    }
  });

  it("every tab href resolves to a page on disk", () => {
    // ⚠️ HARDCODED, so a new section has to be added here by hand — which is
    // the point: a list derived from tabsetFor would grow with it and check
    // nothing new.
    const paths = [
      "/dashboard/conversations",
      "/dashboard/leads",
      "/dashboard/analytics",
      "/dashboard/training",
      "/dashboard/packages",
      "/dashboard/settings",
      "/dashboard/ads",
    ];
    for (const p of paths) {
      const t = tabsetFor(p, ALL)!;
      for (const tab of t.tabs) expect(pageExists(tab.href), tab.href).toBe(true);
    }
  });

  /**
   * ⚠️ WITHOUT A CASE HERE THE TOP BAR READS "Lead Database" on a page that is
   * plainly about something else — a rule the suite already encodes for every
   * other section without tripping on a new one.
   */
  it("titles the ads section rather than falling back to the product name", () => {
    expect(sectionTitle("/dashboard/ads")).toBe("Facebook adverts");
    expect(sectionTitle("/dashboard/ads/profile")).toBe("Facebook adverts");
    expect(tabsetFor("/dashboard/ads", ALL)?.title).toBe("Facebook adverts");
  });

  /** Demo-only today: off, and it is off everywhere at once. */
  it("hides the ads section entirely when the flag is off", () => {
    expect(tabsetFor("/dashboard/ads", NONE)).toBeNull();
    const sidebar = buildSidebar(NONE);
    expect(sidebar.main.some((i) => i.key === "ads")).toBe(false);
    expect(buildSidebar(ALL).main.some((i) => i.key === "ads")).toBe(true);
  });

  it("marks the active tab by longest prefix and rests on the first hash tab", () => {
    const leads = tabsetFor("/dashboard/leads/priority", ALL)!;
    expect(activeTabHref(leads, "/dashboard/leads/priority")).toBe("/dashboard/leads/priority");
    expect(activeTabHref(leads, "/dashboard/leads/abc")).toBe("/dashboard/leads");
    const settings = tabsetFor("/dashboard/settings", ALL)!;
    expect(activeTabHref(settings, "/dashboard/settings")).toBe("/dashboard/settings#profile");
    expect(activeTabHref(settings, "/dashboard/settings/messaging")).toBe(
      "/dashboard/settings/messaging"
    );
  });
});

describe("isColumnsPath", () => {
  it("is the inbox, a thread and a lead page — and nothing else", async () => {
    const { isColumnsPath } = await import("../dashboardNav");
    expect(isColumnsPath("/dashboard/conversations")).toBe(true);
    expect(isColumnsPath("/dashboard/conversations/abc")).toBe(true);
    expect(isColumnsPath("/dashboard/conversations/snippets")).toBe(false);
    expect(isColumnsPath("/dashboard/leads/abc")).toBe(true);
    expect(isColumnsPath("/dashboard/leads/priority")).toBe(false);
    expect(isColumnsPath("/dashboard/leads/add")).toBe(false);
    expect(isColumnsPath("/dashboard/leads/expired")).toBe(false);
    expect(isColumnsPath("/dashboard/leads")).toBe(false);
    expect(isColumnsPath("/dashboard")).toBe(false);
  });
});
