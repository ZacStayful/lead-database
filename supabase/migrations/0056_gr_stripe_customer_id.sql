-- 0056 — Give Guaranteed Rent its own Stripe customer id.
--
-- WHY
-- ---
-- `customers.stripe_customer_id` was a single column shared by both products.
-- That held while every GR subscription was created against a Stripe customer
-- the app already owned: /api/signup and /api/customer/subscribe both reuse
-- (or create) one Stripe customer per row, so management and GR shared it
-- harmlessly.
--
-- A GR Stripe *Payment Link* breaks that assumption. A Payment Link mints its
-- OWN Stripe customer for the payer, so an existing management subscriber who
-- buys GR through one ends up with two Stripe customers against one row. The
-- `invoice.paid` provisioning path links a paid subscription to a row by
-- email when it cannot find one by Stripe id, and would therefore repoint
-- `stripe_customer_id` at the new GR customer — detaching that customer's
-- MANAGEMENT subscription from every future webhook lookup. Their management
-- renewals would stop crediting, silently, because the id no longer matched.
-- Management's own provisioning would then repoint it back on its next
-- renewal, and the two products would fight over the column indefinitely.
--
-- The products are meant to be fully parallel (CLAUDE.md invariant 6), and
-- every other Stripe field already is: gr_stripe_subscription_id,
-- gr_stripe_price_id. The customer id was the one that was not. This adds it.
--
-- READS MUST CHECK BOTH COLUMNS. A GR subscription bought before this
-- migration is still keyed on `stripe_customer_id`, and the vast majority of
-- customers hold both products against a single Stripe customer. So the
-- webhook resolves a GR event by matching gr_stripe_customer_id OR
-- stripe_customer_id, and only ever WRITES the gr_ column. Nothing backfills:
-- a null gr_stripe_customer_id means "GR bills against the shared customer",
-- which is exactly what it did before.

alter table public.customers
  add column if not exists gr_stripe_customer_id text;

comment on column public.customers.gr_stripe_customer_id is
  'Stripe customer id billing this row''s Guaranteed Rent subscription, when it '
  'differs from stripe_customer_id (a GR Payment Link mints its own customer). '
  'NULL means GR bills against the shared stripe_customer_id. Readers must '
  'match on either column; only GR writers set this one.';

-- Partial index: the webhook looks a customer up by this on every GR event, and
-- the column is null for everyone who did not arrive through a GR Payment Link.
create index if not exists customers_gr_stripe_customer_id_idx
  on public.customers (gr_stripe_customer_id)
  where gr_stripe_customer_id is not null;
