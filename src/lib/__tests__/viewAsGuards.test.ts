/**
 * File-text guards for admin view-as (§62), in the §42.8 discipline: anchored
 * on the real files, comments stripped, each one a rule that a one-token
 * change would silently undo and that no pure unit can see.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..", "..");
const REPO = path.resolve(SRC, "..");

function code(rel: string): string {
  return readFileSync(path.join(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("§62 the middleware is the control", () => {
  it("is the ONE middleware file, under src/, and the two dead ones are gone", () => {
    expect(existsSync(path.join(SRC, "middleware.ts"))).toBe(true);
    expect(existsSync(path.join(REPO, "middleware.ts"))).toBe(false);
    expect(existsSync(path.join(SRC, "lib/supabase/middleware.ts"))).toBe(false);
  });

  it("delegates the decision to viewAsRefusal and imports nothing that reaches Supabase", () => {
    const mw = code("middleware.ts");
    expect(mw).toContain("viewAsRefusal(");
    expect(mw).toContain("request.cookies.has(VIEW_AS_COOKIE)");
    expect(mw).not.toMatch(/supabase|updateSession/);
  });

  it("matches /api only, excluding the Stripe webhook, the crons and the Monday syncs", () => {
    const mw = code("middleware.ts");
    expect(mw).toContain('matcher: ["/api/((?!webhook|cron|monday).*)"]');
  });

  it("viewAs.ts stays import-free — it is bundled into the edge middleware and a client component", () => {
    expect(code("lib/viewAs.ts")).not.toMatch(/^\s*import\s/m);
  });
});

describe("§62 identity", () => {
  it("getCurrentCustomer honours the cookie through resolveViewAs and strips the admin claim", () => {
    const auth = code("lib/auth.ts");
    expect(auth).toContain("resolveViewAs(user, cookies().get(VIEW_AS_COOKIE)?.value)");
    expect(auth).toContain("user: withoutAdminClaim(user)");
    // The swap loads by id; the ordinary path still loads by user_id.
    expect(auth).toContain('.eq("id", viewAsId)');
    expect(auth).toContain('.eq("user_id", user.id)');
  });

  it("the dashboard layout never stamps first login on a viewed customer", () => {
    expect(code("app/dashboard/layout.tsx")).toContain("if (!viewAs) await markFirstLoginAndNotify(customer);");
  });

  it("the view-as route is session-admin only on POST and never reads x-admin-key", () => {
    const route = code("app/api/admin/view-as/route.ts");
    expect(route).not.toMatch(/x-admin-key|ADMIN_SECRET_KEY/);
    const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function DELETE"));
    expect(post).toContain("isAdminUser(user)");
    const del = route.slice(route.indexOf("export async function DELETE"));
    expect(del).not.toContain("isAdminUser");
    expect(del).toContain("maxAge: 0");
  });

  it("sign-out and sign-in both clear the cookie so it cannot follow the next person", () => {
    expect(code("components/dashboard/SignOutButton.tsx")).toContain('fetch(VIEW_AS_ROUTE, { method: "DELETE" })');
    expect(code("app/login/page.tsx")).toContain('fetch(VIEW_AS_ROUTE, { method: "DELETE" })');
  });
});

describe("§62 reads follow the swap", () => {
  const REFACTORED = [
    "app/api/customer/presentation/[leadId]/route.ts",
    "app/api/customer/presentation/brand/route.ts",
    "app/api/customer/training/[moduleId]/play-url/route.ts",
    "app/api/customer/lead-analysis/[jobId]/route.ts",
    "app/api/customer/files/[id]/download/route.ts",
    "app/api/leads/[id]/report/route.ts",
    "app/api/leads/export/route.ts",
    "app/dashboard/training/page.tsx",
    "app/dashboard/training/[slug]/page.tsx",
    "app/dashboard/goals/page.tsx",
  ];

  it("no refactored file resolves identity inline any more", () => {
    for (const f of REFACTORED) {
      const src = code(f);
      expect(src, f).toContain("getCurrentCustomer()");
      expect(src, f).not.toContain('eq("user_id"');
      expect(src, f).not.toContain("auth.getUser()");
    }
  });

  it("the two GET-only refactors keep their writes on the session lookup", () => {
    for (const f of ["app/api/customer/settings/presentation/route.ts", "app/api/customer/settings/presentation/brand/route.ts"]) {
      const src = code(f);
      const get = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function PUT"));
      expect(get, f).toContain("getCurrentCustomer()");
      expect(get, f).not.toContain('eq("user_id"');
      const put = src.slice(src.indexOf("export async function PUT"));
      expect(put, f).toContain("auth.getUser()");
    }
  });

  it("the file download compares ownership on the customer, not the session user", () => {
    const src = code("app/api/customer/files/[id]/download/route.ts");
    expect(src).toContain("ownerId !== customer.id");
    expect(src).not.toContain("customers!inner(user_id)");
  });

  it("the goals page reads its won count on the service role scoped by customer.id", () => {
    const src = code("app/dashboard/goals/page.tsx");
    expect(src).toContain("createAdminClient()");
    expect(src).toContain('.eq("customer_id", customer.id)');
  });

  it("the two auth.uid() Insights blocks stand down in a view rather than showing the admin's figures", () => {
    const analytics = code("app/dashboard/analytics/page.tsx");
    expect(analytics).toContain("if (!viewAs) {");
    expect(analytics).toContain('userClient.rpc("get_engagement_benchmarks")');
    expect(analytics).toMatch(/viewAs \? \([\s\S]*aren&apos;t\s+available in this view/);
    const board = code("app/dashboard/leaderboard/page.tsx");
    expect(board).toContain('allRows.filter((r) => r.group_key !== "you")');
  });
});

describe("§62 the frame and the two browser-side writes", () => {
  it("AppShell provides the context and renders the banner in its own file, not TopBar", () => {
    const shell = code("components/shell/AppShell.tsx");
    expect(shell).toContain("<ViewAsProvider value={viewAs}>");
    expect(shell).toContain("{viewAs && <ViewAsBanner viewAs={viewAs} />}");
    expect(code("components/shell/TopBar.tsx")).not.toContain("viewAs");
  });

  it("the banner says read-only, offers Exit, and never prints a customer id", () => {
    const banner = code("components/shell/ViewAsBanner.tsx");
    expect(banner).toContain("read-only");
    expect(banner).toContain("Exit");
    expect(banner).not.toContain("customerId");
    expect(banner).toContain('fetch(VIEW_AS_ROUTE, { method: "DELETE" })');
  });

  it("LeadFiles withholds upload and delete, and NotificationsCentre skips its mark-read effect", () => {
    const files = code("components/dashboard/LeadFiles.tsx");
    expect(files).toContain("useReadOnlyView()");
    expect(files).toContain("{!readOnly && (");
    const centre = code("components/dashboard/NotificationsCentre.tsx");
    expect(centre).toContain("useReadOnlyView()");
    expect(centre).toMatch(/useEffect\(\(\) => \{\s*if \(readOnly\) return;/);
  });
});

describe("§62 the admin entry point", () => {
  it("Customer portal points at the picker, and the picker page exists", () => {
    expect(code("app/admin/layout.tsx")).toContain('{ label: "Customer portal", href: "/admin/portal" }');
    expect(existsSync(path.join(SRC, "app/admin/portal/page.tsx"))).toBe(true);
  });

  it("the picker's first option is the admin's own live dashboard, and archived rows are labelled", () => {
    const picker = code("components/admin/ViewAsPicker.tsx");
    expect(picker).toContain("Open my dashboard");
    expect(picker).toContain("Archived");
    const page = code("app/admin/portal/page.tsx");
    expect(page).toContain("archived: c.is_active === false");
    // The status word comes from the tested module, never a copy in the page —
    // the copy is what labelled every active customer "cancelling" (§62).
    expect(page).toContain("status: portalStatus(c)");
    expect(page).not.toContain("pendingCancellation(");
  });
});
