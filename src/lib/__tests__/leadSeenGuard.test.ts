import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Opening a lead marks it seen (§63.5). The writes reach the database, so
 * what is pinned is their shape on the real files (§42.8):
 *
 *   - viewed_at is stamped only where it is still null (first open wins, and
 *     two tabs cannot race);
 *   - only the assignment's own `new_lead` notifications are read, scoped to
 *     the customer;
 *   - loadLeadWorkspace is the one call site, so both lead pages agree;
 *   - the feed's PATCH route still stamps viewed_at as it always did, so a
 *     card expand and a page open remain two routes to one column;
 *   - detail_opened is still recorded once from the browser, never here.
 */
const seen = readFileSync("src/lib/leadSeen.ts", "utf8");
const workspace = readFileSync("src/lib/leadWorkspace.ts", "utf8");
const patch = readFileSync("src/app/api/customer/assignments/[id]/route.ts", "utf8");
const page = readFileSync("src/app/dashboard/page.tsx", "utf8");

const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("markLeadSeen", () => {
  const c = code(seen);

  it("stamps viewed_at only where it is still null", () => {
    expect(c).toContain('.update({ viewed_at: nowIso })');
    expect(c).toContain('.is("viewed_at", null)');
  });

  it("reads only this assignment's own new_lead notifications, scoped to the customer", () => {
    const start = c.indexOf('.from("notifications")');
    const slice = c.slice(start, start + 400);
    expect(slice).toContain('.eq("lead_assignment_id", params.assignmentId)');
    expect(slice).toContain('.eq("customer_id", params.customerId)');
    expect(slice).toContain('.eq("notification_type", "new_lead")');
    expect(slice).toContain('.is("read_at", null)');
  });

  it("never writes a lead event", () => {
    expect(c).not.toContain("lead_events");
    expect(c).not.toContain("detail_opened");
  });
});

describe("the call site", () => {
  it("loadLeadWorkspace marks the lead seen and reflects it in memory", () => {
    const c = code(workspace);
    expect(c).toContain("markLeadSeen(admin, {");
    expect(c).toContain("if (markSeen && !wasViewed) assignment.viewed_at = new Date().toISOString();");
  });

  it("never marks anything while an admin is viewing the customer (§62)", () => {
    const c = code(workspace);
    expect(c).toContain("const markSeen = opts.viewAs !== true;");
    expect(c).toContain("markSeen\n        ? markLeadSeen(admin, {");
    // Both lead pages pass the flag through.
    for (const page of [
      "src/app/dashboard/leads/[id]/page.tsx",
      "src/app/dashboard/conversations/[leadId]/page.tsx",
    ]) {
      expect(code(readFileSync(page, "utf8"))).toContain("viewAs: viewAs != null");
    }
  });

  it("the feed's PATCH route still stamps viewed_at", () => {
    expect(code(patch)).toContain("if (body.viewed && !");
  });
});

describe("the home card", () => {
  const c = code(page);

  it("reads only unread new_lead notifications from the last week", () => {
    const start = c.indexOf('.from("notifications")');
    const slice = c.slice(start, start + 900);
    expect(slice).toContain('.eq("notification_type", "new_lead")');
    expect(slice).toContain('.is("read_at", null)');
    expect(slice).toContain('.gte("created_at", newLeadSince)');
    expect(slice).toContain(".limit(10)");
  });

  it("renders in the announcement slot on the home page only", () => {
    expect(c).toContain("<NewLeadCard card={newLeadCard} />");
    const layout = readFileSync("src/app/dashboard/layout.tsx", "utf8");
    expect(layout).not.toContain("NewLeadCard");
  });
});
