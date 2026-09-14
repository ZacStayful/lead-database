/**
 * File-text guards for the CRM redesign (§56.7), in the §42.8 discipline:
 * anchored on the real files, comments stripped, each one a rule the
 * cross-check settled and a one-token change could silently undo.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

function code(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const REDESIGN_DIRS = ["components/shell", "components/conversations", "components/lead", "components/home", "app/dashboard/conversations"];
const redesignFiles = REDESIGN_DIRS.flatMap((d) => walk(path.join(ROOT, d))).map((p) => path.relative(ROOT, p));

describe("§56.7 redesign guards", () => {
  it("offers no SMS channel anywhere (there is no customer→landlord SMS)", () => {
    for (const f of redesignFiles) {
      expect(/\bsms\b/i.test(code(f)), f).toBe(false);
    }
  });

  it("never hard-codes the sending hours — they come from ChannelAvailability.quietUntil", () => {
    for (const f of redesignFiles) {
      expect(/\b0[89]:00\b|\b20:00\b/.test(code(f)), f).toBe(false);
    }
    expect(code("components/conversations/Composer.tsx")).toContain("quietUntil");
  });

  it("shows Received and never the enquiry date on the contact panel (§11)", () => {
    const panel = code("components/lead/ContactPanel.tsx");
    expect(panel).toContain('label="Received"');
    expect(panel).not.toContain("enquiry_date");
  });

  it("labels the two incomes as the operator's and Stayful's, and never merges them (§25)", () => {
    const panel = code("components/lead/ContactPanel.tsx");
    expect(panel).toContain("Your estimate");
    expect(panel).toContain("saveIncome");
    expect(panel).not.toContain("gross_annual_income");
    expect(code("components/lead/useLeadWorkflow.ts")).toContain("income_estimate");
    const work = code("components/lead/WorkThisLead.tsx");
    expect(work).toContain("IncomeProjection");
    expect(work).not.toContain("income_estimate");
  });

  it("scopes every lead to the viewer before it reaches the browser (§32.8)", () => {
    expect(code("lib/leadWorkspace.ts")).toContain("viewerScopedLead(");
    expect(code("lib/messaging/inbox.ts")).toContain("viewerScopedLead(");
    for (const page of [
      "app/dashboard/conversations/page.tsx",
      "app/dashboard/conversations/[leadId]/page.tsx",
      "app/dashboard/leads/[id]/page.tsx",
    ]) {
      const src = code(page);
      expect(/loadLeadWorkspace|fetchInboxRows/.test(src), page).toBe(true);
      expect(src.includes('select("*, lead:leads(*)")'), page).toBe(false);
    }
  });

  it("records detail_opened from exactly one component", () => {
    const hits = redesignFiles.filter((f) => code(f).includes('"detail_opened"'));
    expect(hits).toEqual(["components/lead/LeadWorkspace.tsx"]);
  });

  it("a wa.me tap is a whatsapp_click, never message_sent (§40.15)", () => {
    const composer = code("components/conversations/Composer.tsx");
    expect(composer).toContain('event_type: "whatsapp_click"');
    expect(composer).not.toContain("message_sent");
    const thread = code("components/conversations/ThreadColumn.tsx");
    // A click row renders through SystemRow, never with a tick.
    expect(thread).toContain('it.kind === "click"');
  });

  it("loads the ⌘K lead list lazily from a query-free route, never with the layout", () => {
    const layout = code("app/dashboard/layout.tsx");
    expect(layout).not.toContain('from("lead_assignments")');
    expect(layout).not.toContain("paletteLeads");
    const palette = code("components/shell/CommandPalette.tsx");
    expect(palette).toContain('fetch("/api/customer/leads/palette"');
    const route = code("app/api/customer/leads/palette/route.ts");
    expect(route).toContain("getCurrentCustomer()");
    expect(route).toContain('.eq("customer_id", customer.id)');
    expect(route).not.toContain("searchParams");
    expect(route).not.toContain("request.json");
    expect(route).toContain("no-store, private");
  });

  it("the inbox connect prompt reuses the composer's setup copy and keys on the customer's own connection", () => {
    const prompt = code("components/conversations/ConnectPrompt.tsx");
    expect(prompt).toContain("SETUP_BLURB.whatsapp");
    expect(prompt).toContain("TIMELINES_SETUP_VIDEO_URL");
    expect(prompt).toContain("TIMELINES_SIGNUP_URL");
    // The $25 line and the token step live in SETUP_BLURB, never restated here.
    expect(prompt).not.toMatch(/\$25|TimelinesAI account \(/);
    for (const page of ["app/dashboard/conversations/page.tsx", "app/dashboard/conversations/[leadId]/page.tsx"]) {
      const src = code(page);
      expect(src, page).toContain("getWhatsappConnection(admin, customer.id)");
      expect(src, page).toContain('whatsapp?.status === "connected"');
    }
    const list = code("components/conversations/InboxList.tsx");
    expect(list).toContain("!connect.connected");
  });

  it("keeps the old single-column lead page and its dialog gone", () => {
    expect(() => statSync(path.join(ROOT, "components/dashboard/LeadDetail.tsx"))).toThrow();
    expect(() => statSync(path.join(ROOT, "components/dashboard/LeadMessageButtons.tsx"))).toThrow();
  });

  it("keeps every lead-page control in Work this lead", () => {
    const work = code("components/lead/WorkThisLead.tsx");
    for (const needle of [
      "LeadOutcomePanel",
      "DeadLeadClaimCard",
      "ContactTimeline",
      "IncomeProjection",
      "IncomeReportLink",
      "AnalysisOfferPanel",
      "LandlordHandoff",
      "Mark as contacted",
      "Mark as signed",
      "Delete this lead",
      "Open STR Analyser",
      "Objection Assistant",
      "income-presentation",
      "Undo",
    ]) {
      expect(work, needle).toContain(needle);
    }
  });

  it("the shell keeps Request a feature as a direct link and adds no Call button", () => {
    const sidebar = code("components/shell/Sidebar.tsx");
    const topbar = code("components/shell/TopBar.tsx");
    expect(code("lib/dashboardNav.ts")).toContain("Request a feature");
    expect(/\bCall\b/.test(topbar)).toBe(false);
    expect(sidebar).toContain("Report a bug");
  });
});
