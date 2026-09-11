import { GR_PLANS, PLANS } from "@/lib/plans";
import {
  CLAUDE_SECTIONS,
  DEFERRED,
  INVARIANTS,
  KNOWN_ISSUES,
} from "./sectionIndex";

/**
 * What Claude needs to know about this product before it asks a customer
 * anything, or writes an implementation prompt about it.
 *
 * WITHOUT THIS the model asks generic helpdesk questions — "which browser?",
 * "can you reproduce it?" — and produces a brief that names no files. WITH it,
 * it asks about the priority list by name, knows that "I said no to it" could
 * mean three different things here, and hands over a prompt that already points
 * at `leadOrder.ts` and quotes the invariant the fix must not break.
 *
 * ⚠️ THE ROUTE MAP IS THE ONLY HAND-MAINTAINED PART, AND IT IS TEST-PINNED.
 * Everything else is derived from CLAUDE.md by `scripts/generate-section-index.mjs`.
 * `productContext.test.ts` fails if a page under `src/app/dashboard` has no
 * entry here, and `npm run build` runs vitest first — so a new screen cannot
 * ship invisible to the thing whose whole job is knowing what the screens are.
 *
 * ⚠️ THIS IS A CACHE PREFIX. It is rendered into the `system` block ahead of the
 * cache breakpoint and must therefore be BYTE-IDENTICAL on every request. Never
 * interpolate a date, a customer, a ticket or a random id into it. Anything
 * that varies goes in the user turn — see `prompts.ts`.
 */

export type RouteEntry = {
  /** Path as the customer sees it. */
  path: string;
  /** One line, in the customer's language, not the schema's. */
  purpose: string;
  /** Where a change to this screen most likely lands. */
  files: string[];
  /** Existing coverage. A fix here without a case fails `npm run build`. */
  tests?: string[];
  /** CLAUDE.md section explaining why it works the way it does. */
  section?: number;
};

/**
 * Customer-facing screens only. Admin screens are deliberately absent: a
 * customer cannot see them, so a question about one is always the model
 * confusing itself.
 */
export const ROUTES: RouteEntry[] = [
  {
    path: "/dashboard",
    purpose: "Home. Leads waiting, credits left, and how the month is pacing.",
    files: ["src/app/dashboard/page.tsx", "src/lib/pacing.ts"],
    tests: ["src/lib/__tests__/allocationCredit.test.ts"],
    section: 13,
  },
  {
    path: "/dashboard/leads",
    purpose: "Every lead they have been given, newest first.",
    files: [
      "src/app/dashboard/leads/page.tsx",
      "src/components/dashboard/LeadsList.tsx",
    ],
    section: 4,
  },
  {
    path: "/dashboard/leads/priority",
    purpose:
      "The ranked 'work these first' list. Ordering is computed, not chosen by the customer.",
    files: [
      "src/app/dashboard/leads/priority/page.tsx",
      "src/lib/leadOrder.ts",
    ],
    section: 4,
  },
  {
    path: "/dashboard/leads/[id]",
    purpose:
      "One lead: contact details, income analysis, notes, pipeline stage, and the one outcome panel that ends it.",
    files: [
      "src/app/dashboard/leads/[id]/page.tsx",
      "src/components/dashboard/LeadDetail.tsx",
      "src/components/dashboard/LeadOutcomePanel.tsx",
      "src/lib/leadOutcomes.ts",
      "src/lib/outcomeReasons.ts",
    ],
    tests: [
      "src/lib/__tests__/leadOutcomes.test.ts",
      "src/lib/__tests__/outcomeReasons.test.ts",
    ],
    section: 5,
  },
  {
    path: "/dashboard/leads/add",
    purpose: "Upload their own leads from a spreadsheet.",
    files: [
      "src/app/dashboard/leads/add/page.tsx",
      "src/lib/leadImport.ts",
      "src/lib/claudeMapping.ts",
    ],
    tests: [
      "src/lib/__tests__/leadImport.test.ts",
      "src/lib/__tests__/claudeMapping.test.ts",
    ],
    section: 30,
  },
  {
    path: "/dashboard/leads/expired",
    purpose: "The pool of leads other operators did not work, claimable.",
    files: ["src/app/dashboard/leads/expired/page.tsx"],
    section: 19,
  },
  {
    path: "/dashboard/follow-ups",
    purpose: "Leads due a chase, from the per-lead contact plan.",
    files: [
      "src/app/dashboard/follow-ups/page.tsx",
      "src/lib/contact/contactPlan.ts",
    ],
    tests: ["src/lib/contact/__tests__/contactPlan.test.ts"],
    section: 42,
  },
  {
    path: "/dashboard/filtering",
    purpose:
      "Choose which leads they want by area and type. Changes what gets delivered.",
    files: ["src/app/dashboard/filtering/page.tsx"],
    section: 39,
  },
  {
    path: "/dashboard/topup",
    purpose: "Buy extra leads outside the monthly allocation.",
    files: ["src/app/dashboard/topup/page.tsx"],
  },
  {
    path: "/dashboard/analytics",
    purpose: "Their own conversion funnel. Split by product.",
    files: ["src/app/dashboard/analytics/page.tsx"],
    section: 14,
  },
  {
    path: "/dashboard/leaderboard",
    purpose: "How they compare with other operators, anonymised.",
    files: ["src/app/dashboard/leaderboard/page.tsx"],
    section: 20,
  },
  {
    path: "/dashboard/goals",
    purpose:
      "A target for signed management clients. Management only, no GR equivalent.",
    files: ["src/app/dashboard/goals/page.tsx"],
    section: 13,
  },
  {
    path: "/dashboard/training",
    purpose:
      "The video training library, on running an operation and working leads.",
    files: ["src/app/dashboard/training/page.tsx"],
  },
  {
    path: "/dashboard/training/[slug]",
    purpose:
      "One training video, played in the dashboard with progress tracked.",
    files: ["src/app/dashboard/training/[slug]/page.tsx"],
  },
  {
    path: "/dashboard/training/case-studies",
    purpose: "Written case studies of deals other operators have closed.",
    files: ["src/app/dashboard/training/case-studies/page.tsx"],
  },
  {
    path: "/dashboard/training/case-studies/[slug]",
    purpose:
      "One written case study of an operator working a lead to signature.",
    files: ["src/app/dashboard/training/case-studies/[slug]/page.tsx"],
  },
  {
    path: "/dashboard/guide",
    purpose: "How the marketplace works, written for the operator.",
    files: ["src/app/dashboard/guide/page.tsx"],
  },
  {
    path: "/dashboard/objection-assistant",
    purpose: "Help answering a landlord's objection on a call.",
    files: ["src/app/dashboard/objection-assistant/page.tsx"],
  },
  {
    path: "/dashboard/documents",
    purpose:
      "Contracts and templates. The company let agreement is Guaranteed Rent only.",
    files: ["src/app/dashboard/documents/page.tsx"],
  },
  {
    path: "/dashboard/packages",
    purpose: "Their plan, and changing tier or adding the other product.",
    files: ["src/app/dashboard/packages/page.tsx", "src/lib/planChanges.ts"],
    section: 24,
  },
  {
    path: "/dashboard/settings",
    purpose: "Business details, billing portal, pause and cancel.",
    files: [
      "src/app/dashboard/settings/page.tsx",
      "src/components/dashboard/SettingsPanel.tsx",
    ],
    section: 29,
  },
  {
    path: "/dashboard/settings/messaging",
    purpose:
      "Connect WhatsApp or email so landlords can be messaged from the database.",
    files: ["src/app/dashboard/settings/messaging/page.tsx"],
    section: 40,
  },
  {
    path: "/dashboard/notifications",
    purpose: "Notification history and per-channel preferences.",
    files: ["src/app/dashboard/notifications/page.tsx"],
  },
  {
    path: "/dashboard/api",
    purpose: "API keys and connecting an AI assistant over MCP.",
    files: ["src/app/dashboard/api/page.tsx"],
    section: 45,
  },
  {
    path: "/dashboard/support",
    purpose: "Ask for help, and see the requests they have already made.",
    files: [
      "src/app/dashboard/support/page.tsx",
      "src/components/SupportForm.tsx",
    ],
    section: 46,
  },
];

/**
 * The words the customer will NOT use. Every entry here is a term where the
 * customer's phrasing and the schema's phrasing come apart, which is exactly
 * where an unclarified request goes wrong.
 */
export const GLOSSARY: Record<string, string> = {
  lead: "A landlord enquiry. Sourced by Stayful, screened, and sold on to operators.",
  assignment:
    "The join between a lead and the operator it was given to. Almost everything the customer thinks of as 'the lead' actually lives here: pipeline stage, notes, when it arrived.",
  "lead balance":
    "Credits. Spent one at a time on delivery. This is the gate on whether a lead can be assigned at all — an empty balance looks exactly like 'the system has stopped working'.",
  allocation:
    "How many leads the plan includes per month. Separate from the balance.",
  pacing:
    "Whether delivery is on track for the month. Deliberately smoothed, not all at once.",
  reject:
    "Saying a delivered lead was not good enough. It does NOT refund a credit, by design. Customers frequently report this as a billing fault.",
  discard:
    "Removing a lead from their own list. Different from reject, and it deletes the row, so anything counted off it is lost.",
  "pipeline stage":
    "How far a lead has got. The stage list DIFFERS between Management and Guaranteed Rent.",
  swap: "Exchanging a lead for another. Must respect the customer's lead filter.",
  "lead filter": "The customer's stated preferences for which leads they want.",
  "expired pool":
    "Leads nobody worked, returned for anyone to claim. A claim bypasses the normal delivery cap.",
  management:
    "One of the two products. The operator signs the landlord to a management contract.",
  "guaranteed rent":
    "The other product. Fully parallel to Management, with its own balance, allocation, pacing and status columns. A customer may hold either, both or neither.",
  analysis: "The paid income projection on a lead.",
  presentation: "The generated deck an operator shows a landlord.",
  announcement: "A message from Stayful shown in the dashboard and emailed.",
  ticket: "A logged support or feature request. Referenced as STF-nnnn.",
};

/** Things a change here cannot fix, because they are not in this repository. */
export const EXTERNAL_SYSTEMS = [
  "Monday.com — where leads originate. Board structure and column names are outside this repo; ingest is idempotent on monday_item_id.",
  "Stripe — all billing, subscriptions, prices, promo codes and the customer portal.",
  "Resend — every outbound email. No code path may ask Supabase to send one.",
  "Twilio and ZeroBounce — phone and email verification.",
  "Supabase — database and auth. Privileged writes go through server routes on the service role.",
];

/** How work actually ships here. A prompt that ignores these produces a red build. */
export const BUILD_CONVENTIONS = [
  "Migrations live in supabase/migrations/NNNN_name.sql and DEPLOY BEFORE THE CODE THAT READS THEM.",
  "supabase/schema.sql is a stale artefact that stopped being maintained around 0037. Do not update it; migrations are the source of truth.",
  "`npm run build` runs `vitest run` first, so a change without a test case fails the build.",
  "Assertions worth keeping are mutation-tested: break the code deliberately, watch the test fail, restore it.",
  "Every feature adds a numbered section to CLAUDE.md explaining why, not just what.",
  "Tables are RLS-on with no policies; server routes on the service role are the access control.",
];

/** Two products, two tiers each, held independently. */
export function planModel(): string {
  const line = (label: string, p: { leads: number; priceGbp: number }) =>
    `  ${label}: £${p.priceGbp}/month for ${p.leads} leads`;
  return [
    "Management (gate: subscription_status === 'active'):",
    line("lead_10", PLANS.lead_10),
    line("lead_20", PLANS.lead_20),
    "Guaranteed Rent (gate: gr_subscription_status === 'active'):",
    line("lead_10", GR_PLANS.lead_10),
    line("lead_20", GR_PLANS.lead_20),
    "A customer may hold either product, both, or neither. They are fully parallel:",
    "every balance, counter, pacing and eligibility branch must handle both.",
    "The Guaranteed Rent side must NEVER be gated on a management-only column",
    "(account_status, paused_at, subscription_status).",
  ].join("\n");
}

/**
 * The pack, rendered once. Byte-identical on every request — see the warning at
 * the top of this file.
 */
export function productContext(): string {
  const routes = ROUTES.map((r) => {
    const bits = [
      `${r.path} — ${r.purpose}`,
      `    files: ${r.files.join(", ")}`,
    ];
    if (r.tests?.length) bits.push(`    tests: ${r.tests.join(", ")}`);
    if (r.section) bits.push(`    see CLAUDE.md §${r.section}`);
    return bits.join("\n");
  }).join("\n");

  const sections = CLAUDE_SECTIONS.map(
    (s) => `  §${s.n} ${s.title}${s.migrations ? ` (${s.migrations})` : ""}`,
  ).join("\n");

  return [
    "# The product",
    "",
    "Stayful Lead Database is a marketplace. Stayful sources and screens landlord",
    "enquiries and sells them to short-term-rental operators on a monthly",
    "subscription. The people using it run property businesses. They are not",
    "engineers, they do not read documentation, and they will describe a screen by",
    "what they were trying to do on it rather than by its name.",
    "",
    "# Plans",
    "",
    planModel(),
    "",
    "# Screens a customer can see",
    "",
    routes,
    "",
    "# Words they will not use",
    "",
    Object.entries(GLOSSARY)
      .map(([term, meaning]) => `  ${term} — ${meaning}`)
      .join("\n"),
    "",
    "# Invariants — things that look like bugs and are not",
    "",
    INVARIANTS,
    "",
    "# Known issues already documented",
    "",
    KNOWN_ISSUES.map((k) => `  - ${k}`).join("\n"),
    "",
    "# Decisions deliberately left open",
    "",
    "A request matching one of these is not a new feature. It is a decision",
    "someone already chose not to make, and the reasoning is in CLAUDE.md.",
    "",
    DEFERRED.map((d) => `  - ${d}`).join("\n"),
    "",
    "# Outside this codebase",
    "",
    EXTERNAL_SYSTEMS.map((e) => `  - ${e}`).join("\n"),
    "",
    "# How work ships here",
    "",
    BUILD_CONVENTIONS.map((c) => `  - ${c}`).join("\n"),
    "",
    "# The full CLAUDE.md index",
    "",
    sections,
  ].join("\n");
}
