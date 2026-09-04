-- ---------------------------------------------------------------------------
-- 0131 — The details a landlord sees, editable by the customer (SS41)
--
-- ADDITIVE AND INERT for the part that matters: four nullable columns, every
-- one arriving NULL, and NULL means "use my account details". So the referral
-- email renders byte-identically on the day this applies, and stays that way
-- until a customer deliberately sets an override.
--
-- WHAT THIS IS FOR. SS41 emails the landlord when a lead is allocated, and
-- renders a details table straight off the account row — Who (contact_name),
-- Company (business_name), Phone (phone), Email (email). The customer can edit
-- exactly one thing in that email, the operator_intro blurb. A customer whose
-- company has been renamed, or who wants landlord enquiries arriving somewhere
-- other than their login inbox, has no way to change any of the rest.
--
-- ⚠️ THESE ARE OVERRIDES, NOT A SECOND SET OF DETAILS, and that distinction is
-- the whole design. The obvious way to do this is to copy the four fields and
-- let the customer edit the copies, which gives two sources of truth that drift
-- the moment one is edited and the other is not. Nullable-with-fallback means a
-- customer who sets nothing still has exactly ONE value; a difference exists
-- only where somebody chose one on purpose.
--
-- ⚠️ AND THE ACCOUNT COLUMNS DO NOT MOVE. `customers.email` is the login AND
-- the Stripe billing address: SS43.3 records that changing it without Stripe
-- arms provisionPaidSubscriber's .eq("email", ...) fallback, and the next
-- unmatched invoice then creates a duplicate customer row and a second auth
-- user. `business_name` / `contact_name` are Monday matcher tier 3, the only
-- tier that resolves two of eighteen live customers. `phone` drives the
-- operator's own SMS alerts. None of that is touched by anything here.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 — The landlord-facing overrides.
--
-- On `customers` beside operator_intro, which is the other half of the same
-- block of the same email. getCurrentCustomer() reads this table with
-- select("*") on the service role, so they are free on every dashboard page.
--
-- Named referral_* to sit with SS41's vocabulary. Deliberately NOT contact_*,
-- which would read as belonging to SS42's contact plans.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists referral_contact_name text;

alter table public.customers
  add column if not exists referral_business_name text;

alter table public.customers
  add column if not exists referral_phone text;

alter table public.customers
  add column if not exists referral_email text;

-- ⚠️ A LENGTH FLOOR OF 1, NOT JUST A CEILING. buildReferralCopy pushes a table
-- row whenever the value is truthy after trimming, so an empty string stored
-- here would render "Phone:" with nothing beside it in an email to a member of
-- the public. Empty means "fall back", and the only way to say that is NULL —
-- the application coerces "" to null and this constraint is what stops any
-- other writer getting it wrong.
alter table public.customers
  drop constraint if exists customers_referral_contact_name_len;
alter table public.customers
  add constraint customers_referral_contact_name_len
  check (referral_contact_name is null or length(btrim(referral_contact_name)) between 1 and 120);

alter table public.customers
  drop constraint if exists customers_referral_business_name_len;
alter table public.customers
  add constraint customers_referral_business_name_len
  check (referral_business_name is null or length(btrim(referral_business_name)) between 1 and 120);

alter table public.customers
  drop constraint if exists customers_referral_phone_len;
alter table public.customers
  add constraint customers_referral_phone_len
  check (referral_phone is null or length(btrim(referral_phone)) between 1 and 40);

alter table public.customers
  drop constraint if exists customers_referral_email_len;
alter table public.customers
  add constraint customers_referral_email_len
  check (referral_email is null or length(btrim(referral_email)) between 1 and 200);

comment on column public.customers.referral_contact_name is
  'Name shown to a landlord in the SS41 referral email, overriding contact_name. NULL = use the '
  'account column. Never read by billing, Monday matching or admin.';

comment on column public.customers.referral_business_name is
  'Company shown to a landlord in the SS41 referral email (and its subject line, via '
  'operatorLabel), overriding business_name. NULL = use the account column.';

comment on column public.customers.referral_phone is
  'Phone shown to a landlord, overriding phone. NULL = use the account column. A LANDLINE is '
  'valid here — the operator''s own SMS alerts still go to customers.phone.';

comment on column public.customers.referral_email is
  'Email shown to a landlord, overriding email. NULL = use the account column. ⚠️ NOT a login and '
  'NOT a billing address: it is deliberately not unique and never reaches auth.users or Stripe.';

-- ---------------------------------------------------------------------------
-- 2 — Drop the orphans from an abandoned duplicate of this feature.
--
-- ⚠️ THE ONE DESTRUCTIVE STEP HERE, and it is safe for a specific reason rather
-- than a general one. A parallel session shipped SS41 while another was part
-- way through building the same thing under the name lead_intro_*; the loser's
-- migration reached production before the collision was noticed, and its code
-- never did. Verified on production immediately before writing this: zero rows
-- in lead_intro_sends, zero customers with lead_intro_enabled, no value in any
-- of the four columns, no system_settings row, and nothing in src/ referencing
-- any of it.
--
-- Left in place they are exactly the drift SS11 warns about — objects present
-- in production and in no migration's intent, which the next person to diff the
-- schema has to work out from scratch.
-- ---------------------------------------------------------------------------
drop table if exists public.lead_intro_sends;

alter table public.customers drop column if exists lead_intro_subject;
alter table public.customers drop column if exists lead_intro_body;
alter table public.customers drop column if exists lead_intro_enabled;
alter table public.customers drop column if exists lead_intro_updated_at;

delete from public.system_settings where key = 'lead_intro_enabled';
