import { ticketReference } from "@/lib/supportTickets";
import { CLAUDE_SECTIONS, NEXT_MIGRATION } from "./sectionIndex";
import { ROUTES } from "./productContext";
import type { Answer, Brief } from "./schemas";

/**
 * Composing the implementation prompt from the brief.
 *
 * ⚠️ THE MODEL DOES NOT WRITE THIS PROMPT. It supplies the CONTENT — what it
 * understood, what it could not determine, the criteria, the files — and this
 * function lays it out. That split is deliberate:
 *
 *   1. The section list is then GUARANTEED, not hoped for. A model asked to
 *      produce fifteen sections of markdown will quietly drop the boring ones,
 *      and the boring ones here (tests, migration order, invariants) are the
 *      ones that turn a red build into a green one.
 *   2. It is a pure function, so every branch is unit-tested without spending a
 *      penny or touching the network.
 *   3. The format tunes without re-prompting.
 */

export type PromptContext = {
  reference: number;
  kind: string;
  summary: string;
  body: string;
  page: string | null;
  planSnapshot: string | null;
  businessName: string | null;
  submittedAt: Date;
  answers: Answer[];
};

const RULE = "";

function section(heading: string, body: string | string[]): string[] {
  const lines = Array.isArray(body) ? body : [body];
  if (!lines.length || lines.every((l) => !l.trim())) return [];
  return [`## ${heading}`, "", ...lines, RULE];
}

function bullets(items: string[]): string[] {
  return items.map((i) => `- ${i}`);
}

function checkboxes(items: string[]): string[] {
  return items.map((i) => `- [ ] ${i}`);
}

/** `§46 Logging what customers ask for (0133)` for a section number we actually have. */
function citeSection(n: number): string | null {
  const s = CLAUDE_SECTIONS.find((c) => c.n === n);
  if (!s) return null;
  return `§${s.n} ${s.title}${s.migrations ? ` (migration ${s.migrations})` : ""}`;
}

/**
 * Test files covering the paths the brief points at.
 *
 * Derived rather than asked for: the model is not reliable about which test
 * file covers which module, and the route map already knows. A fix pushed
 * without a case fails `npm run build`, so this is the difference between one
 * round trip and two.
 */
function testsFor(files: string[]): string[] {
  const out = new Set<string>();
  for (const route of ROUTES) {
    if (!route.tests?.length) continue;
    if (route.files.some((f) => files.includes(f))) route.tests.forEach((t) => out.add(t));
  }
  return Array.from(out);
}

const PRIOR_ART_HEADING: Record<string, string> = {
  duplicate: "Prior art — this is a DUPLICATE",
  shipped: "Prior art — THIS ALREADY SHIPPED",
  deferred: "Prior art — this is a DEFERRED DECISION, not new work",
};

export function renderPrompt(brief: Brief, ctx: PromptContext): string {
  const ref = ticketReference(ctx.reference);
  const date = ctx.submittedAt.toISOString().slice(0, 10);

  const out: string[] = [`# ${brief.title}`, ""];

  out.push(
    ...section("Task", [
      brief.understanding,
      "",
      `This came in as ${ref}, classified \`${brief.request_class}\`${
        brief.severity ? ` with severity \`${brief.severity}\`` : ""
      }.`,
    ])
  );

  // Placed second on purpose. If this work already exists, everything below is
  // the wrong plan and the reader needs to know before they read it.
  if (brief.prior_art_kind !== "none" && brief.prior_art_detail) {
    out.push(
      ...section(PRIOR_ART_HEADING[brief.prior_art_kind] ?? "Prior art", [
        brief.prior_art_detail,
        ...(brief.prior_art_kind === "shipped"
          ? [
              "",
              "So this is NOT a feature request. Either it regressed, or the customer could not find it. Both are real bugs and neither is 'build the thing'. Establish which before writing any code.",
            ]
          : []),
      ])
    );
  }

  out.push(
    ...section("Who reported it", [
      ...(ctx.businessName ? [`- Business: ${ctx.businessName}`] : []),
      `- Plan: ${ctx.planSnapshot ?? "no active product"}`,
      ...(ctx.page ? [`- Was on: ${ctx.page}`] : []),
      `- Reported: ${date}`,
      `- Ticket: ${ref} (query \`support_tickets\` by \`reference\` for the full row)`,
    ])
  );

  out.push(...section("What they said, in their words", ["> " + ctx.summary, ">", ...ctx.body.split("\n").map((l) => `> ${l}`)]));

  if (ctx.answers.length) {
    out.push(
      ...section(
        "What they said when asked",
        ctx.answers.flatMap((a) => [
          `**${a.question}**`,
          a.answer,
          // Depth is not trivia. It says the customer could not follow the
          // app's own vocabulary here, and that is very often where the real
          // problem is.
          ...(a.depth > 0
            ? [
                `_(they asked for this question to be simplified ${a.depth} time${
                  a.depth === 1 ? "" : "s"
                } — they did not follow the wording, which may itself be the problem)_`,
              ]
            : []),
          "",
        ])
      )
    );
  }

  out.push(
    ...section(
      "What could NOT be determined",
      brief.could_not_determine.length
        ? bullets(brief.could_not_determine)
        : ["Nothing material. The answers covered it."]
    )
  );

  out.push(...section("Acceptance criteria", checkboxes(brief.acceptance_criteria)));

  const sections = brief.claude_sections.map(citeSection).filter((s): s is string => s !== null);
  out.push(
    ...section("Where to look", [
      ...bullets(brief.files_to_look_at),
      ...(sections.length ? ["", "Read first:", ...bullets(sections)] : []),
    ])
  );

  out.push(
    ...section("Invariants in the blast radius", [
      ...(brief.invariants_at_risk.length
        ? [
            "These are CLAUDE.md §9 rules this change comes near. They describe behaviour that LOOKS like a bug and is not. Do not 'fix' any of them:",
            "",
            ...bullets(brief.invariants_at_risk),
          ]
        : ["None identified. Read §9 anyway before changing anything that touches a balance, a counter, pacing or eligibility."]),
    ])
  );

  out.push(...section("Plan and entitlements", brief.plan_considerations));

  const tests = testsFor(brief.files_to_look_at);
  out.push(
    ...section("Tests", [
      "`npm run build` runs `vitest run` first, so a change without a case fails the build.",
      ...(tests.length ? ["", "Existing coverage for the files above:", ...bullets(tests)] : []),
      "",
      "Mutation-test any assertion worth keeping: break the code deliberately, watch it fail, restore it. An assertion that never fails proves nothing (§42.8).",
    ])
  );

  out.push(
    ...section(
      "Migration",
      brief.needs_migration
        ? [
            `This needs one. The next free number is **${NEXT_MIGRATION}**.`,
            "",
            "⚠️ The migration deploys and is verified against production BEFORE the code that reads it merges. Code arriving first fails every write, and where the write is deliberately non-fatal it fails SILENTLY.",
            "",
            "Do not update `supabase/schema.sql`. It stopped being maintained around 0037 and migrations are the source of truth.",
          ]
        : ["Not needed — this is a code-only change."]
    )
  );

  out.push(...section("Out of scope", brief.out_of_scope.length ? bullets(brief.out_of_scope) : ""));

  out.push(
    ...section(
      "Decide, don't guess",
      brief.open_questions.length
        ? bullets(brief.open_questions)
        : ["Nothing outstanding. If something turns out to be ambiguous, ask rather than picking."]
    )
  );

  out.push(
    "---",
    "",
    `_Generated from ${ref}. Every clarifying answer above came from the customer, not from a model._`
  );

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
