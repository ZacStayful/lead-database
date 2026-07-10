# Branch & Feature Audit — reconciling work across sessions

> Snapshot of every remote branch vs `origin/main` (the production/integration
> line), content-verified (squash-merge-proof: checked whether each branch's
> signature files actually exist in `main`, not commit-graph ahead/behind).
> Goal: see what is shipped, what is built-but-unmerged, and what is duplicated,
> so no one rebuilds live work — and so the `0021` migration collision is
> resolved before any merge.

## `main` is the source of truth for "what's live"

The branch a given Claude Code session lands on may be a **fork behind `main`**
(e.g. `claude/lead-database-features-eunw0v`). `CLAUDE.md` was generated from
that fork, so it documents the reject-reason/contact-validation flow as if it is
live — **it is not on `main`.** Treat `main` as production; treat `CLAUDE.md`'s
§5E (reject reasons) as *pending*, not shipped, until the reject branch merges.

## ✅ Shipped (merged to `main`, verified by file presence)

| Feature | Origin branch (now redundant) | Proof in `main` |
| --- | --- | --- |
| GR product expansion | `guaranteed-rent-expansion-tph2d9` | merged (#3) |
| Two pricing plans incl. 10-lead £150 tier | `management-10-lead-tier` | `src/lib/plans.ts` has `lead_10` |
| Mobile nav / responsive header | `mobile-view-header-dashboard-yni3la` | `src/components/dashboard/MobileNav.tsx` |
| Objection Assistant tool | `objection-assistant-integration-04m2em` | `src/app/dashboard/objection-assistant/page.tsx` (#8) |
| "How Leads Are Qualified" landing section | `qualification-process-audit-f6mq9f` | `src/components/landing/QualificationProcess.tsx` (#10) |
| Company & Compliance footer (wired in root layout) | `company-compliance-footer-ksgf25` | `src/components/layout/CompanyComplianceFooter.tsx` (#11) |
| Privacy Policy + "If Something's Not Right" | `privacy-policy-draft-i16i5j` | `src/app/privacy-policy/page.tsx`, `src/app/policies/lead-quality-and-data/page.tsx` (#12) |
| Live Activity ledger + counter | `live-activity-ledger-counter-nk4lps` | `supabase/migrations/0021_create_public_activity_stats.sql` (#13) |
| Enquiry fields / password reset / bugfixes | `session-cd7h1v` | superseded (migrations 0013/0014 in main) |

The dedicated branches above can be deleted — their content is in `main`.

## 🔨 Built but NOT merged (the real pending inventory)

| Feature | Branch | New files | Migration(s) |
| --- | --- | --- | --- |
| **Lead filtering** — postcode area + bedroom range, per-product (`gr_` mirror), `filter_status` (off/active/pending_lift), `filter_lift_effective_date`. Comment: "trades the volume guarantee for relevance." | `stayful-lead-filtering-4pou4k` | `src/lib/postcode.ts`, `src/app/dashboard/filtering/page.tsx`, `src/components/dashboard/LeadFilteringPanel.tsx`, `src/app/api/customer/filter/route.ts` | `0021_lead_filtering`, `0022_backfill_lead_postcodes` |
| **Reject-reason + contact validation** (Twilio Lookup + ZeroBounce) | `lead-rejection-reason-popup-u5pdvb` (dup on `lead-database-features-eunw0v`, `stayful-lead-marketplace-49kyjq`) | `RejectLeadDialog.tsx`, `src/components/ui/dialog.tsx`, `src/lib/validation/contactValidation.ts` | `0021_reject_reason_and_contact_validation` |
| **First-login welcome email + security hardening** (privileged-RPC exposure, Stripe double-credit, GR pacing) — *contains the reject-reason work too* | `first-login-email-audit-16ky9n` | `src/lib/firstLogin.ts` (+ reject files) | `0021`–`0024` |

### Guarantee dependency
The subscription **volume guarantee's "unfiltered customers only" exclusion**
depends on the filtering feature's `filter_status = 'off'`. That schema is real
but lives only on `stayful-lead-filtering-4pou4k` — **not on `main`, so not
live.** The guarantee cannot reference filter state in production until that
branch merges.

### Security note
`first-login-email-audit-16ky9n` carries unmerged **security fixes**
(privileged-RPC exposure, Stripe double-credit). Consider prioritising these
independently of the guarantee work.

## 💥 Migration `0021` — 3-way collision

`main` already owns `0021` = `create_public_activity_stats` (shipped, #13).
Two pending features also claim `0021`:

| `0021_*` file | Branches | Status |
| --- | --- | --- |
| `create_public_activity_stats.sql` | `main`, `live-activity-ledger` | **shipped — owns 0021** |
| `reject_reason_and_contact_validation.sql` | `eunw0v`, `lead-rejection-reason-popup`, `49kyjq`, `first-login-email-audit` | pending — collides |
| `lead_filtering.sql` (+ `0022_backfill`) | `stayful-lead-filtering` | pending — collides |

`first-login-email-audit` further stacks `0022`–`0024` on top of its own
`0021_reject`, so all four of its migrations must shift.

### Suggested landing order into `main` (renumber as each lands)
1. **reject-reason + contact validation** → `0022` (foundational; 4 branches depend on it; also unblocks `CLAUDE.md` §5E being true on main).
2. **first-login security hardening** → `0023`+ — it *includes* reject-reason, so dedupe against step 1 rather than double-applying.
3. **lead filtering** → next free numbers (`00NN_lead_filtering` + `00NN+1_backfill_lead_postcodes`).

After merges, regenerate `CLAUDE.md` from `main` and refresh
`supabase/schema.sql` (still stale at ~0012).
