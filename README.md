# Stayful Lead Marketplace

A vertically integrated lead subscription platform for [Stayful](https://stayful.co.uk),
a UK short-term-rental property management company. Unqualified landlord
enquiries are sold to other STR operators via a subscription portal:
**£300 / month for 20 leads**, max 2 operators per lead. Each payment tops up a
running `lead_balance` of credits, so any leads not received in a cycle carry
forward automatically.

## Stack

- **Framework:** Next.js 14 (App Router)
- **Hosting:** Vercel
- **Database & auth:** Supabase (Postgres + RLS + Realtime)
- **Payments:** Stripe (monthly subscription)
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
3. `supabase/migrations/0004_remove_overflow.sql` — drop the overflow flag
4. `supabase/migrations/0005_add_lead_balance.sql` — lead credit balance + balance-gated assignment
5. `supabase/migrations/0006_add_reject.sql` — assignment status set + atomic reject
6. `supabase/migrations/0002_cron.sql` — monthly `leads_received_this_month` reset (needs pg_cron)

### 2. Auth

- Enable email/password auth in Supabase.
- Admin users get `role: "admin"` in their user metadata (set manually in the
  Supabase dashboard). Everyone else is a `customer`.
- Middleware (`middleware.ts`) protects `/dashboard/*` and `/admin/*`.

### 3. Stripe

Create two products and copy the price IDs into env:

- **Stayful Lead Subscription** — £300 / month recurring → `STRIPE_MONTHLY_PRICE_ID`

Add a webhook endpoint → `{APP_URL}/api/webhook/stripe` listening for
`customer.subscription.{created,updated,deleted}`, `invoice.paid`,
`invoice.payment_failed`.

#### Post-call discount (one-time manual setup)

The post-call offer feature (single-use 10%-off first month, 24h expiry) needs a
one-time Stripe configuration — the app never creates these itself:

1. **Create one Coupon** — `percent_off: 10`, `duration: once`, `currency: gbp`,
   name `Post-call 10%`. Copy its id into `STRIPE_POST_CALL_COUPON_ID`. The coupon
   may apply to both Management products, but must **not** be single-redemption at
   the coupon level (`max_redemptions` is enforced per promotion **code**, so one
   coupon backs many prospects) and must work on either Management Payment Link —
   one code, either link.
2. **Enable "Allow promotion codes"** on **both** existing Management Payment
   Links (Stripe dashboard, or
   `payment_links.update(id, { allow_promotion_codes: true })`):
   - 10 leads / £150 — `https://buy.stripe.com/5kQdR8bzM6Ha5fh48P4Ja01`
   - 20 leads / £300 — `https://buy.stripe.com/eVq14m8nA4z29vx20H4Ja00`
3. **Store both link base URLs** in `STRIPE_MANAGEMENT_10_PAYMENT_LINK_URL` and
   `STRIPE_MANAGEMENT_20_PAYMENT_LINK_URL`. The offer route appends
   `?prefilled_promo_code=<code>` to whichever link the caller sends.

The app generates one Promotion Code per prospect (wrapping the coupon,
`max_redemptions: 1`, `expires_at` = +24h) via `POST /api/admin/post-call-offer`,
triggered either from the admin **Offers** page or by an n8n workflow (bearer
`N8N_WEBHOOK_SECRET`) when a Monday item enters the "Web meeting sat" group.
Reminder email + SMS fire at 12h / 4h / 1h remaining via
`/api/cron/post-call-offer-reminders`, stopping once the code is redeemed. That
endpoint must be hit **every ~15 minutes** with an `Authorization: Bearer
$CRON_SECRET` header. On a Vercel **Pro** plan add it to `vercel.json` crons;
on **Hobby** (daily-cron limit) drive it from an external scheduler instead
(e.g. an n8n Schedule trigger — the same n8n instance already used here). Redemption is detected on the Stripe `invoice.paid` webhook and
surfaced in admin as a **"Discount applied — N-lead plan"** badge. SMS reminders
also require `TWILIO_MESSAGING_FROM` (a Twilio number or Messaging Service SID);
if unset, email still sends.

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
lead → `get_next_customers_for_lead` (max 2, deficit-first pacing, positive
`lead_balance` required) → `assign_lead_to_customer` atomically for each (spends
one lead credit) → notification row + Resend email → threshold emails at 18 /
allocation. On each subscription `invoice.paid`, `lead_balance` is topped up by
20. Customers may reject a `new` assignment, which refunds one credit and
reassigns the lead to the next eligible customer.

## Routes

| Area | Route | Notes |
| --- | --- | --- |
| Public | `/`, `/login`, `/signup` | Landing, auth, Stripe checkout |
| Customer | `/dashboard`, `/dashboard/leads`, `/dashboard/notifications`, `/dashboard/settings` | Realtime lead feed |
| Admin | `/admin`, `/admin/customers`, `/admin/customers/[id]`, `/admin/leads`, `/admin/leads/[id]`, `/admin/offers` | Requires `role: admin` |
| API | `/api/webhook/n8n`, `/api/webhook/stripe`, `/api/leads/export`, `/api/admin/assign`, `/api/admin/customers/[id]/allocation`, `/api/admin/post-call-offer`, `/api/cron/post-call-offer-reminders` | Plus customer assignment / lead reject / billing-portal helpers |

## Design

Clean, flat, minimal. White cards, 0.5px borders, no gradients/shadows.
Signature element: **unread lead cards have a 3px solid `#5D8156` left border**;
viewed cards have none.

## Security notes

- All privileged writes go through server routes using the Supabase **service
  role** key. Browser clients only ever use the anon key under RLS.
- Customers cannot self-edit `monthly_allocation`, `price_paid`, or billing
  flags — those columns are not writable via any RLS policy.
