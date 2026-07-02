# Stayful Lead Marketplace

A vertically integrated lead subscription platform for [Stayful](https://stayful.co.uk),
a UK short-term-rental property management company. Unqualified landlord
enquiries are sold to other STR operators via a subscription portal:
**£300 / month for 20 leads**, max 2 operators per lead, £20 overflow leads for
opted-in customers.

## Stack

- **Framework:** Next.js 14 (App Router)
- **Hosting:** Vercel
- **Database & auth:** Supabase (Postgres + RLS + Realtime)
- **Payments:** Stripe (subscription + overflow invoice items)
- **Lead ingestion:** n8n webhook (Monday.com board `18420117742`)
- **Email:** Resend
- **Excel export:** SheetJS (server-generated `.xlsx`)
- **UI:** Tailwind CSS + shadcn/ui, brand green `#5D8156`

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev
```

### 1. Database (required — the app 500s until this is done)

Easiest: open the Supabase SQL editor and paste the whole of
**`supabase/schema.sql`** (a consolidated, idempotent copy of all migrations)
and run it once.

Or run the individual migrations in order:

1. `supabase/migrations/0001_init.sql` — tables, functions, RLS policies
2. `supabase/migrations/0003_pacing.sql` — pacing column + deficit ordering
3. `supabase/migrations/0002_cron.sql` — monthly `leads_received_this_month` reset (needs pg_cron)

### 2. Auth

- Enable email/password auth in Supabase.
- Admin users get `role: "admin"` in their user metadata (set manually in the
  Supabase dashboard). Everyone else is a `customer`.
- Middleware (`middleware.ts`) protects `/dashboard/*` and `/admin/*`.

### 3. Stripe

Create two products and copy the price IDs into env:

- **Stayful Lead Subscription** — £300 / month recurring → `STRIPE_MONTHLY_PRICE_ID`
- **Stayful Overflow Lead** — £20 one-time → `STRIPE_OVERFLOW_PRICE_ID`

Add a webhook endpoint → `{APP_URL}/api/webhook/stripe` listening for
`customer.subscription.{created,updated,deleted}`, `invoice.paid`,
`invoice.payment_failed`.

### 4. n8n

Point the Monday.com "item created" automation at
`POST {APP_URL}/api/webhook/n8n` with header
`Authorization: Bearer {N8N_WEBHOOK_SECRET}` and the JSON body described below.

## Lead ingestion contract

`POST /api/webhook/n8n`

```json
{
  "monday_item_id": "string",
  "lead_name": "string",
  "address": "string",
  "phone": "string",
  "email": "string",
  "lead_profile": "string",
  "bedrooms": "string",
  "enquiry_date": "string",
  "estimated_monthly_income": "string"
}
```

Flow: validate bearer token → idempotency check on `monday_item_id` → insert
lead → `get_next_customers_for_lead` (max 2, round-robin by
`last_assignment_at`) → `assign_lead_to_customer` atomically for each →
notification row + Resend email → threshold emails at 18 / allocation → £20
overflow charge when over allocation.

## Routes

| Area | Route | Notes |
| --- | --- | --- |
| Public | `/`, `/login`, `/signup` | Landing, auth, Stripe checkout |
| Customer | `/dashboard`, `/dashboard/leads`, `/dashboard/notifications`, `/dashboard/settings` | Realtime lead feed |
| Admin | `/admin`, `/admin/customers`, `/admin/customers/[id]`, `/admin/leads`, `/admin/leads/[id]` | Requires `role: admin` |
| API | `/api/webhook/n8n`, `/api/webhook/stripe`, `/api/leads/export`, `/api/admin/assign`, `/api/admin/customers/[id]/allocation` | Plus customer overflow / assignment / billing-portal helpers |

## Design

Clean, flat, minimal. White cards, 0.5px borders, no gradients/shadows.
Signature element: **unread lead cards have a 3px solid `#5D8156` left border**;
viewed cards have none.

## Security notes

- All privileged writes go through server routes using the Supabase **service
  role** key. Browser clients only ever use the anon key under RLS.
- Customers cannot self-edit `monthly_allocation`, `price_paid`, or billing
  flags — those columns are not writable via any RLS policy.
