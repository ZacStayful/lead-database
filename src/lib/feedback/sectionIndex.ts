// GENERATED FILE — DO NOT EDIT BY HAND.
// Run `npm run gen:context` after changing CLAUDE.md.
// `sectionIndex.test.ts` fails the build if this has drifted.

export type ClaudeSection = { n: number; title: string; migrations: string | null };

/** Every `## N.` heading in CLAUDE.md, with the migrations it names. */
export const CLAUDE_SECTIONS: ClaudeSection[] = [
  { n: 1, title: "What this is", migrations: null },
  { n: 2, title: "Scheduled jobs (`vercel.json`)", migrations: null },
  { n: 3, title: "Core tables", migrations: null },
  { n: 4, title: "Assignment path", migrations: null },
  { n: 5, title: "Reject and discard", migrations: null },
  { n: 6, title: "Automatic contacted flip", migrations: "0043" },
  { n: 7, title: "Soft reclaim — SUPERSEDED by §18", migrations: "0046" },
  { n: 8, title: "Routes", migrations: null },
  { n: 9, title: "Invariants — do not break", migrations: null },
  { n: 10, title: "Engagement scoring and benchmarks", migrations: "0047, 0048" },
  { n: 11, title: "Known issues and gotchas", migrations: null },
  { n: 12, title: "Deferred", migrations: null },
  { n: 13, title: "Goals — management only", migrations: "0051, 0052" },
  { n: 14, title: "Analytics is split by product", migrations: null },
  { n: 15, title: "Email transport — Resend only, never Supabase's mailer", migrations: null },
  { n: 16, title: "Subscriber capacity is per product", migrations: "0054" },
  { n: 17, title: "The Packages tab and self-serve cross-sell", migrations: "no migration" },
  { n: 18, title: "Onboarding a customer onto a product", migrations: "no migration" },
  { n: 18, title: "Inactivity escalation", migrations: "0062–0070" },
  { n: 19, title: "The expired leads pool", migrations: "0073–0076" },
  { n: 20, title: "Insights → Leaderboard", migrations: "0077–0082" },
  { n: 21, title: "Pause, and understanding why customers leave", migrations: "0038, 0084" },
  { n: 22, title: "Announcements", migrations: "0085" },
  { n: 23, title: "Monday subscription-status sync", migrations: "0086" },
  { n: 24, title: "Self-serve tier changes", migrations: "0088" },
  { n: 25, title: "Estimated gross income on a lead", migrations: "0089" },
  { n: 26, title: "The presentation, tailored to every lead", migrations: "0093" },
  { n: 27, title: "The public API and MCP server", migrations: "0095" },
  { n: 28, title: "The filter volume forecast", migrations: "0097–0100" },
  { n: 29, title: "Self-serve cancellation", migrations: "0101" },
  { n: 30, title: "Customer-owned leads", migrations: "0102" },
  { n: 31, title: "Paid lead analysis", migrations: "0104, 0105, 0106" },
  { n: 32, title: "Leaving, coming back, and reselling a lead you brought in", migrations: "0107, 0108" },
  { n: 33, title: "Believe the invoice, not the note", migrations: "no migration" },
  { n: 34, title: "A swapped-in lead must match the customer's filter", migrations: "0109" },
  { n: 35, title: "Admin force-assign must respect the filter too", migrations: "0110" },
  { n: 36, title: "Checking a lead before it is sold", migrations: "0111" },
  { n: 37, title: "The operator's own branding", migrations: "0112" },
  { n: 38, title: "What the analysis says about the market", migrations: "0113" },
  { n: 39, title: "A new filter starts delivering now, not at renewal", migrations: "0114" },
  { n: 40, title: "Messaging a landlord from the database", migrations: "0115–0118" },
  { n: 41, title: "Introducing the operator to the landlord", migrations: "0126" },
  { n: 42, title: "The contact strategy, and a plan per lead", migrations: "0127" },
  { n: 43, title: "Getting locked out, and getting back in", migrations: "0130" },
  { n: 44, title: "Telling a customer their card was declined", migrations: "0125" },
  { n: 45, title: "Connecting an AI assistant: OAuth 2.1", migrations: "0132" },
  { n: 46, title: "Logging what customers ask for", migrations: "0133" },
  { n: 47, title: "Asking the questions before the ticket lands", migrations: "0134" },
];

/**
 * §9 verbatim. The highest-value few hundred words in the repository for this
 * purpose: it is the list of things that LOOK like bugs and are not. Without it
 * in front of a model, "reject does not refund" reads as a billing fault and
 * gets helpfully fixed.
 */
export const INVARIANTS = "1. `(gr_)lead_balance` is the allocation gate; assignment spends exactly one\n   credit atomically.\n2. Credits carry forward; monthly counters reset on the anchor day.\n3. A lead reaches at most `max_assignments` customers **through ordinary\n   routing**. Escalation raises that column directly, ceiling 5 (§18); soft\n   reclaim's derived slot (§7) is retired but its functions remain. A **pool\n   claim bypasses the cap entirely** (§19), so `assignment_count` may exceed\n   `max_assignments` — nothing enforces the comparison, and the two queries that\n   subtract them clamp with `greatest(…, 0)`.\n4. Every delivered lead is chargeable. Reject does not refund. **One narrow\n   exception, since 0114 (§39): a lead that is UNDELIVERED — untouched,\n   returned to the pool at the customer's own request when they apply a lead\n   filter that excludes it — is refunded.** The untouched predicate in\n   `releasable_filter_assignments` is what keeps that distinct from a refund on\n   worked-for value, and must never be loosened.\n5. Ingest is idempotent on `monday_item_id`; Stripe on `stripe_events`.\n6. Management and GR are fully parallel. Every balance/counter/pacing/eligibility\n   branch must handle both `lead_type` values — and must not use a\n   management-only column (`account_status`, `paused_at`,\n   `subscription_status`) to gate GR.\n7. All privileged writes go through server routes on the service role. The two\n   `SECURITY DEFINER` functions `authenticated` may call are\n   `get_engagement_benchmarks()` (§10) and `set_management_customer_goal()`\n   (§13). Both take no id and resolve identity from `auth.uid()` internally.\n8. Subscriber capacity is **per product and weighted** (§16). Management sums\n   `monthly_allocation` over `account_status = 'active'` against\n   `max_active_customers`; GR sums `gr_monthly_allocation` over\n   `gr_subscription_status = 'active'` against `gr_max_active_customers`. The\n   GR side must never read `account_status` (see 6).\n9. `management_lifetime_leads_received` only ever counts **up**. It is neither\n   the allocation gate nor a pacing counter (§13).\n10. **No code path may ask Supabase to send an email.** Links are minted with\n    `generateLink` and delivered through Resend (§15).\n11. A lead that has been **claimed from the expired pool**, that pooled on the\n    `ignored` basis, or that a **customer added themselves** (§30), is never\n    re-allocated by ordinary routing (§19).\n    `lead_retired_from_allocation()` is the single expression of this and is\n    asserted in all three candidate functions, in `get_escalation_candidates`,\n    and inside `assign_lead_to_customer` under its row lock. A lead pooled on\n    the `unassigned` basis is deliberately **not** retired.\n12. `(gr_)pool_debit` is never negative and is settled only inside\n    `credit_invoice()`, behind the same idempotency claim as the credit (§19).\n    Never decrement it from application code.";

/** §11, one line per entry. */
export const KNOWN_ISSUES: string[] = [
  "~~pipeline_stage validation is management-only.~~ Fixed (0050 branch). PATCH /api/customer/assignments/[id] validated every lead against PIPELINE_STAGES, so a GR customer setting any of their own sta…",
  "viewed_at ≠ telemetry. viewed_at is set *only* by expanding a lead card in the feed. Opening /dashboard/leads/[id] does not set it, so a lead read end-to-end via a direct link leaves it null forever.…",
  "enquiry_date is not displayed anywhere, admin included (0071 branch). It is free text of uneven quality from Monday — safe_enquiry_date() exists in 0062 precisely because it does not always parse. Le…",
  "~~get_next_customers_for_lead is executable by anon.~~ Fixed in 0049. 0028 blanket-revoked schema-wide, then 0038 dropped and recreated the function, which discards its ACL. Re-revoked. Any future cr…",
  "Orphaned reject columns, AND the function that reads them. rejection_reason, contact_validation_result, claim_denied exist on lead_assignments in production but in no migration and no code — left by…",
  "supabase/schema.sql is stale. Migrations are the source of truth.",
  "Admin shows \"3 / 2 assigned\" on a reclaimed lead. Truthful, looks odd; the Reclaim history block on the lead detail page explains it. A claimed pool lead does the same and can read \"4 / 3\" — claiming…",
  "Stripe's billing cycle keeps running underneath a pause. pause_collection: { behavior: \"void\" } generates invoices and voids them; resuming does not create a charge, it stops voiding future ones. So…",
  "fully_served for a paused customer is a stale reading, in an unverified direction. got counts assignments since coalesce(billing_cycle_anchor, created_at). Both customers paused at the time of writin…",
  "No ESLint config (next lint prompts interactively) and no test suite.",
];

/** §12, one line per entry. A feature request matching one of these is a decision, not a build. */
export const DEFERRED: string[] = [
  "Drive /api/cron/post-call-offer-reminders (no scheduler; table is empty so nothing has been missed yet).",
  "Decide whether discard should gate on notes only (§5E).",
  "Decide whether a rejected lead should be reclaimable (currently excluded).",
  "Decide whether Goals should get a GR equivalent (§13 — deliberately none).",
  "Backfill accuracy: management_lifetime_leads_received cannot count leads that were delivered and later discarded, because discard deletes the row (§13). Only fixable by recording deliveries somewhere…",
  "Rehearse the §24 tier swap in Stripe test mode before relying on it. The build session could only reach the live account, so subscriptions.update with proration_behavior: \"none\" has not been exercise…",
  "The 20-lead prices (management and GR) are tax_behavior: \"inclusive\" while both 10-lead prices are \"unspecified\". A §24 tier switch is the first thing that will move a customer between the two treatm…",
  "Decide whether repeat pausing should be capped (§21). It is currently unlimited, and 0084 made the duration customer-chosen, so a customer could in principle pause a month at a time indefinitely. sub…",
  "Review the return-likelihood thresholds once ~20 pauses have completed. They are stated guesses (§21) and get_pause_outcomes() is what will let them be checked against what actually happened.",
  "~~Enable cancellation-reason collection on the Stripe billing portal.~~ ⚠️ This entry claimed it was already enabled on live configuration bpc_1Tz1VxCpQPIFzv4r. During the 0101 work that configuratio…",
  "Rehearse the §29 cancel flow in Stripe test mode (the same standing item as §24's tier swap): the API path subscriptions.update({ cancel_at_period_end: true, cancellation_details }) has not been exer…",
];

/** Highest committed migration, from the directory rather than the prose. */
export const LATEST_MIGRATION = 134;

/** The number a new migration must take. Migrations deploy BEFORE the code that reads them. */
export const NEXT_MIGRATION = "0135";
