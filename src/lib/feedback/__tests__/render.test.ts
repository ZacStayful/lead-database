import { describe, expect, it } from "vitest";
import { NEXT_MIGRATION } from "../sectionIndex";
import { renderPrompt, type PromptContext } from "../render";
import type { Brief } from "../schemas";

const brief: Brief = {
  title: "Stop rejected leads reappearing on the priority list",
  request_class: "bug",
  severity: "major",
  prior_art_kind: "none",
  prior_art_detail: "",
  understanding: "Leads the customer rejected still rank in the priority feed.",
  could_not_determine: ["Whether it survives a page refresh."],
  acceptance_criteria: ["A rejected lead never appears in the priority list."],
  files_to_look_at: ["src/lib/leadOrder.ts", "src/app/dashboard/leads/priority/page.tsx"],
  claude_sections: [4, 5],
  invariants_at_risk: ["4. Every delivered lead is chargeable. Reject does not refund."],
  plan_considerations: "Applies to both products.",
  needs_migration: false,
  out_of_scope: ["Changing what reject costs."],
  open_questions: ["Should discard behave the same way?"],
};

const ctx: PromptContext = {
  reference: 42,
  kind: "bug",
  summary: "Rejected leads keep coming back",
  body: "I said no to a lead on Tuesday and it was top of my priority list again on Wednesday.",
  page: "Priority",
  planSnapshot: "Management £300/20",
  businessName: "The Hosting Edit",
  submittedAt: new Date("2026-09-10T09:00:00Z"),
  answers: [
    { id: "q1", question: "Which did you use?", answer: "Reject", depth: 0 },
    { id: "q2", question: "In your own words: what you expected", answer: "For it to go away", depth: 2 },
  ],
};

describe("the generated prompt", () => {
  const out = renderPrompt(brief, ctx);

  it("leads with the task and the ticket reference", () => {
    expect(out.startsWith(`# ${brief.title}`)).toBe(true);
    expect(out).toContain("STF-0042");
  });

  it("quotes the customer verbatim, every line", () => {
    for (const line of ctx.body.split("\n")) expect(out).toContain(`> ${line}`);
  });

  it("carries the four sections a hand-written request never has", () => {
    // These are the reason this feature is worth building. If any goes missing
    // the prompt is just a tidier version of the email we already had.
    expect(out).toContain("## What could NOT be determined");
    expect(out).toContain("## Invariants in the blast radius");
    expect(out).toContain("## Tests");
    expect(out).toContain("## Where to look");
  });

  it("renders acceptance criteria as checkboxes", () => {
    expect(out).toContain("- [ ] A rejected lead never appears in the priority list.");
  });

  it("expands a section number into its real CLAUDE.md title", () => {
    expect(out).toContain("§5 Reject and discard");
  });

  it("drops a section number that does not exist rather than citing a lie", () => {
    const bad = renderPrompt({ ...brief, claude_sections: [999] }, ctx);
    expect(bad).not.toContain("§999");
  });

  it("names the test files covering the paths it points at", () => {
    // Derived from the route map, not asked of the model: `npm run build` runs
    // vitest first, so this is the difference between one round trip and two.
    const withTests = renderPrompt(
      { ...brief, files_to_look_at: ["src/lib/leadImport.ts"] },
      ctx
    );
    expect(withTests).toContain("src/lib/__tests__/leadImport.test.ts");
  });

  it("surfaces a simplified answer as the signal it is", () => {
    expect(out).toContain("simplified 2 times");
  });

  it("says nothing about simplification when they answered as first asked", () => {
    const plain = renderPrompt(brief, { ...ctx, answers: [ctx.answers[0]] });
    expect(plain).not.toContain("simplified");
  });

  it("gives the next migration number, and only when one is needed", () => {
    expect(out).toContain("Not needed");
    const migrating = renderPrompt({ ...brief, needs_migration: true }, ctx);
    expect(migrating).toContain(NEXT_MIGRATION);
    expect(migrating).toContain("BEFORE the code that reads it");
    // schema.sql is stale on main; telling a session to update it would produce
    // a file that looks current and is not.
    expect(migrating).toContain("Do not update `supabase/schema.sql`");
  });

  it("shouts when the thing already shipped, because everything else is then wrong", () => {
    const shipped = renderPrompt(
      { ...brief, prior_art_kind: "shipped", prior_art_detail: "Shipped in 0112 (§37)." },
      ctx
    );
    expect(shipped).toContain("THIS ALREADY SHIPPED");
    expect(shipped).toContain("Either it regressed, or the customer could not find it");
    // And it must come before the detail, so a reader cannot miss it.
    expect(shipped.indexOf("ALREADY SHIPPED")).toBeLessThan(shipped.indexOf("## Who reported it"));
  });

  it("says nothing about prior art when there is none", () => {
    expect(out).not.toContain("Prior art");
  });

  it("still reads as a whole prompt when the model returned almost nothing", () => {
    const thin = renderPrompt(
      {
        ...brief,
        could_not_determine: [],
        acceptance_criteria: [],
        invariants_at_risk: [],
        out_of_scope: [],
        open_questions: [],
        claude_sections: [],
        files_to_look_at: [],
      },
      { ...ctx, answers: [], page: null, businessName: null, planSnapshot: null }
    );
    expect(thin).toContain("## Task");
    expect(thin).toContain("Read §9 anyway");
    expect(thin).not.toMatch(/\n{3,}/);
    expect(thin).not.toContain("undefined");
    expect(thin).not.toContain("null");
  });
});
