-- ---------------------------------------------------------------------------
-- 0115 — Per-customer messaging connections (§28)
--
-- Operators message landlords from the dashboard: email through THEIR OWN
-- Resend account, WhatsApp through THEIR OWN TimelinesAI workspace. This
-- migration stores the two connections and nothing else.
--
-- WHY THE CUSTOMER OWNS BOTH ACCOUNTS. An earlier design put every customer's
-- sending domain in Stayful's single Resend account. That pools deliverability
-- reputation across the whole book AND with emails.ts — every activation,
-- invoice and nudge in the business — so one operator sending badly would
-- degrade transactional mail for everybody. Customer-owned accounts mean their
-- reputation, their rate limit (10 req/s each, so no shared bucket to govern)
-- and their bill.
--
-- WHY A FULL-ACCESS RESEND KEY IS ACCEPTABLE. Resend has exactly two scopes:
-- sending_access (which cannot create webhooks or enable open/click tracking)
-- and full_access. There is no middle ground, so automated provisioning
-- requires full_access. What contains the blast radius is the instruction that
-- the customer creates a DEDICATED Resend account holding nothing but this
-- integration. That is why it is an instruction in the wizard and not a
-- suggestion.
--
-- THIS IS THE FIRST REVERSIBLE SECRET IN THE SCHEMA. Every credential until now
-- is a one-way sha256 hash (customer_api_keys.key_hash, 0095) or a process env
-- var. These two must be decrypted to be used, so they are stored as
-- AES-256-GCM ciphertext produced in the application (src/lib/crypto/secretBox),
-- with the key in Vercel's environment — a DIFFERENT trust domain from Postgres.
-- Supabase Vault was rejected deliberately: every credentialed read here runs on
-- the service role, which can select vault.decrypted_secrets, so the credential
-- that dumps the ciphertext would dump the plaintext too. App-layer encryption
-- means the plaintext never exists inside the database at any point, so no
-- future RPC, RLS mistake or `select *` can emit it.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO. It stores no message, no
-- thread and no event — those are 0116. It changes no lead_events vocabulary and
-- no routing function — that is 0117. Nothing reads these tables until the code
-- ships, so a lagging deploy cannot affect lead allocation.
--
-- ⚠️ MX ON A CUSTOMER'S APEX DOMAIN WOULD DESTROY THEIR REAL EMAIL. This is the
-- most damaging thing the feature can do. There are four defences and the CHECK
-- in this file is the WEAKEST of them — see the comment on
-- customer_email_domains_min_labels before trusting it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 — Email: one sending subdomain per customer, provisioned in THEIR account.
-- ---------------------------------------------------------------------------
create table if not exists public.customer_email_domains (
  id                       uuid primary key default gen_random_uuid(),
  customer_id              uuid not null references public.customers(id) on delete cascade,

  -- The dedicated subdomain, e.g. 'leads.theiragency.co.uk'. Constructed by the
  -- wizard from the customer's registrable domain plus a prefix — the customer
  -- never types this whole string, which is defence #1 against the apex.
  domain                   text not null,
  parent_domain            text,

  -- Their Resend credential and what we provisioned with it.
  api_key_ciphertext       text,
  api_key_version          smallint not null default 1,
  api_key_last4            text,
  resend_domain_id         text,
  region                   text not null default 'eu-west-1',

  -- Their webhook, created by us through their key. The signing secret is a
  -- secret in its own right: anyone holding it can forge delivery events.
  webhook_id               text,
  webhook_secret_ciphertext text,
  webhook_secret_version   smallint not null default 1,
  webhook_token            text unique,

  -- The DNS records we must show them, exactly as Resend returned them.
  dns_records              jsonb not null default '[]'::jsonb,

  status                   text not null default 'pending',
  tracking_configured      boolean not null default false,
  receiving_configured     boolean not null default false,

  from_local_part          text not null default 'hello',
  from_display_name        text,
  reply_local_prefix       text not null default 'reply',

  verified_at              timestamptz,
  last_checked_at          timestamptz,
  check_attempts           integer not null default 0,
  last_error               text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.customer_email_domains
  drop constraint if exists customer_email_domains_status_check;
alter table public.customer_email_domains
  add constraint customer_email_domains_status_check
  check (status in ('pending','verifying','verified','failed','disabled'));

alter table public.customer_email_domains
  drop constraint if exists customer_email_domains_shape_check;
alter table public.customer_email_domains
  add constraint customer_email_domains_shape_check
  check (domain = lower(domain) and domain !~ '\.$' and domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');

-- ⚠️ THIS IS A FLOOR, NOT A GUARD, AND MUST NOT BE TRUSTED AS ONE.
-- 'theiragency.co.uk' has three labels and IS an apex, so this constraint
-- passes it. Label counting cannot work on UK domains at all. The real
-- defences live in the application: the wizard constructs the subdomain rather
-- than accepting one (src/lib/messaging/domainRules.ts), a public-suffix rule
-- rejects a registrable domain, and a live DNS pre-flight refuses any name that
-- already resolves MX and confirms the parent does. This CHECK only stops the
-- most obvious nonsense reaching the table.
alter table public.customer_email_domains
  drop constraint if exists customer_email_domains_min_labels;
alter table public.customer_email_domains
  add constraint customer_email_domains_min_labels
  check (array_length(string_to_array(domain, '.'), 1) >= 3);

-- Local parts land in a From header. An unvalidated one is a header-injection
-- vector, which is why this is a constraint and not just route validation.
alter table public.customer_email_domains
  drop constraint if exists customer_email_domains_local_parts_check;
alter table public.customer_email_domains
  add constraint customer_email_domains_local_parts_check
  check (from_local_part ~ '^[a-z0-9][a-z0-9._-]{0,30}$'
     and reply_local_prefix ~ '^[a-z0-9][a-z0-9._-]{0,30}$');

-- A ciphertext with no last4 means we cannot show the customer which key is
-- stored without decrypting it, which is a reason to decrypt we do not want.
alter table public.customer_email_domains
  drop constraint if exists customer_email_domains_key_shape_check;
alter table public.customer_email_domains
  add constraint customer_email_domains_key_shape_check
  check (api_key_ciphertext is null or api_key_last4 is not null);

create unique index if not exists customer_email_domains_customer_idx
  on public.customer_email_domains (customer_id);
create unique index if not exists customer_email_domains_domain_idx
  on public.customer_email_domains (domain);

comment on table public.customer_email_domains is
  'One sending subdomain per customer, provisioned inside the CUSTOMER''S own Resend account (§28). '
  'One row per customer today; lifting that is a matter of dropping the unique index, because the '
  'send path already resolves a domain per message rather than per customer.';
comment on column public.customer_email_domains.domain is
  'A DEDICATED subdomain, never the customer''s apex — MX here would break their real email. '
  'Constructed by the wizard, never typed whole by the customer.';
comment on column public.customer_email_domains.api_key_ciphertext is
  'AES-256-GCM, AAD-bound to the customer id. Never selected by a listing query, never logged, '
  'never returned by any route. See EMAIL_DOMAIN_PUBLIC_COLUMNS.';
comment on column public.customer_email_domains.webhook_token is
  'Unguessable path segment for this customer''s inbound webhook URL. Resend payloads carry no '
  'tenant identifier, so a per-customer URL is how we know whose mail this is.';

-- ---------------------------------------------------------------------------
-- 2 — WhatsApp: one TimelinesAI workspace per customer.
-- ---------------------------------------------------------------------------
create table if not exists public.customer_whatsapp_connections (
  id                     uuid primary key default gen_random_uuid(),
  customer_id            uuid not null references public.customers(id) on delete cascade,

  token_ciphertext       text,
  token_version          smallint not null default 1,
  token_fingerprint      text,
  token_last4            text,

  status                 text not null default 'pending',
  workspace_label        text,
  whatsapp_account_id    text,
  whatsapp_account_phone text,

  -- ⚠️ TimelinesAI webhooks are COMPLETELY UNAUTHENTICATED — their own spec
  -- states that request authentication and custom headers are not supported.
  -- This token in the URL path is the first of four defences; the decisive one
  -- is read-back verification before anything mutates lead state.
  webhook_token          text not null unique,
  webhook_ids            jsonb not null default '[]'::jsonb,

  -- Ban-risk guardrails. A QR-linked device sending at volume is the classic
  -- profile for WhatsApp restricting a number, and the number at risk is the
  -- operator's own.
  daily_send_cap         integer not null default 40,
  min_send_interval_secs integer not null default 45,
  risk_acknowledged_at   timestamptz,

  -- Their workspace's own quota, read back from TimelinesAI so the panel shows
  -- their real remaining sends rather than an assumption. Verified live: the
  -- Shared Inbox plan is 500 messages/month per workspace.
  messaging_quota_total  integer,
  messaging_quota_used   integer,
  quota_checked_at       timestamptz,

  connected_at           timestamptz,
  last_verified_at       timestamptz,
  last_error             text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.customer_whatsapp_connections
  drop constraint if exists customer_whatsapp_connections_status_check;
alter table public.customer_whatsapp_connections
  add constraint customer_whatsapp_connections_status_check
  check (status in ('pending','connected','disconnected','suspended','revoked','error'));

alter table public.customer_whatsapp_connections
  drop constraint if exists customer_whatsapp_connections_caps_check;
alter table public.customer_whatsapp_connections
  add constraint customer_whatsapp_connections_caps_check
  check (daily_send_cap between 1 and 200 and min_send_interval_secs between 10 and 3600);

alter table public.customer_whatsapp_connections
  drop constraint if exists customer_whatsapp_connections_token_shape_check;
alter table public.customer_whatsapp_connections
  add constraint customer_whatsapp_connections_token_shape_check
  check (token_ciphertext is null or token_fingerprint is not null);

create unique index if not exists customer_whatsapp_connections_customer_idx
  on public.customer_whatsapp_connections (customer_id);

comment on table public.customer_whatsapp_connections is
  'One TimelinesAI workspace per customer (§28). TimelinesAI is a QR-LINKED DEVICE, not the '
  'official WhatsApp Business API — confirmed live, accounts return a WhatsApp WID rather than a '
  'Meta phone-number-id. That is why the ban-risk guardrails here are columns and not comments.';
comment on column public.customer_whatsapp_connections.webhook_token is
  'The ONLY thing addressing this customer''s webhook endpoint, because TimelinesAI cannot sign '
  'its payloads. An unknown token must return a 404 byte-identical to a known token with an '
  'unknown message id, so the endpoint cannot enumerate customers.';
comment on column public.customer_whatsapp_connections.risk_acknowledged_at is
  'The customer confirmed they understand WhatsApp may restrict the number. Blocking, not a footnote.';

-- ---------------------------------------------------------------------------
-- 3 — RLS: on, with NO POLICY AT ALL. Deny-all to the browser.
--
-- The same posture as customer_api_keys (0095) and operator_proof_snapshots
-- (0081), and for a stronger reason than either: these rows hold credentials to
-- a customer's email account and WhatsApp number. They must be unreachable even
-- by their own owner's browser. Every read goes through a server route on the
-- service role with an explicit column list, so nothing in the dashboard needs
-- a policy to work.
-- ---------------------------------------------------------------------------
alter table public.customer_email_domains        enable row level security;
alter table public.customer_whatsapp_connections enable row level security;

-- ---------------------------------------------------------------------------
-- 4 — Kill switch and ceilings.
--
-- Seeded FALSE, unlike api_enabled (0095) which seeded true. This is the first
-- thing in the system that sends mail to people who are not our customers; it
-- should take a deliberate flip after the first domain verifies, not arrive on.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('messaging_enabled', 'false') on conflict (key) do nothing;

insert into public.system_settings (key, value)
  values ('messaging_whatsapp_ceiling_per_second', '15') on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 5 — The shared TimelinesAI budget.
--
-- Resend needs no governor: each customer has their own account and therefore
-- their own 10 req/s. TimelinesAI limits to 30 req/s PER IP, and every tenant
-- shares Vercel's egress addresses, so that one genuinely is a shared bucket.
--
-- INCREMENT THEN COMPARE, never check then increment — the claim-by-write
-- discipline credit_invoice() uses against Stripe redelivery. Returns jsonb
-- rather than a table for the reason §27.4 records: a RETURNS TABLE function is
-- called by PostgREST as a set-returning function in a FROM clause, and its
-- upserts do not persist through that path.
-- ---------------------------------------------------------------------------
create table if not exists public.provider_rate_windows (
  provider      text not null,
  window_start  timestamptz not null,
  request_count integer not null default 0,
  primary key (provider, window_start)
);

alter table public.provider_rate_windows
  drop constraint if exists provider_rate_windows_provider_check;
alter table public.provider_rate_windows
  add constraint provider_rate_windows_provider_check
  check (provider in ('resend','timelinesai'));

alter table public.provider_rate_windows enable row level security;

create or replace function public.consume_provider_budget(
  p_provider        text,
  p_window_seconds  integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_count  integer;
begin
  v_window := to_timestamp(floor(extract(epoch from now()) / greatest(p_window_seconds, 1))
                           * greatest(p_window_seconds, 1));

  insert into public.provider_rate_windows (provider, window_start, request_count)
    values (p_provider, v_window, 1)
  on conflict (provider, window_start)
    do update set request_count = public.provider_rate_windows.request_count + 1
  returning request_count into v_count;

  return jsonb_build_object('count', v_count, 'window_start', v_window);
end;
$$;

-- 0095's warning, repeated because it keeps being true: a `create or replace`
-- discards the function's ACL, so these grants must be re-asserted every time
-- this function is edited. See §11 on get_next_customers_for_lead.
revoke execute on function public.consume_provider_budget(text, integer) from public, anon, authenticated;
grant  execute on function public.consume_provider_budget(text, integer) to service_role;

comment on function public.consume_provider_budget(text, integer) is
  'Shared-bucket governor for TimelinesAI (30 req/s per IP, and our tenants share Vercel egress). '
  'Increments first and returns the new count so the caller compares against a ceiling — never '
  'check-then-increment. Callers must FAIL CLOSED on error.';
