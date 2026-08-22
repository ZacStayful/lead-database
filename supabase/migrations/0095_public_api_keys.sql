-- ---------------------------------------------------------------------------
-- 0095 — Per-customer API keys, so a subscriber can reach their own data from
--        their own tools.
--
-- Every customer route in this codebase authenticates from a COOKIE SESSION,
-- and the only bearer credential anywhere is CRON_SECRET — one shared secret
-- for our own jobs. A session cannot be refreshed by n8n or by an LLM client,
-- so until now there has been no machine-usable door at all.
--
-- This is a SECOND FRONT DOOR ONTO ROOMS THAT ALREADY HAVE A LOCK. Invariant 7
-- already holds: every privileged write goes through a server route on the
-- service role, and RLS grants `authenticated` select-only. Nothing here
-- widens what a customer may reach — it changes how they may prove who they
-- are. The surface built on top is read-only.
--
-- HASH-ONLY STORAGE, following lead_topup_tokens (0041): the raw key exists in
-- exactly one HTTP response and is never recoverable. A leaked database row
-- cannot reconstruct a usable credential.
--
-- REVOCATION IS A STAMP, NEVER A DELETE. A deleted row takes last_used_at and
-- the prefix with it, which is precisely the evidence wanted after a key
-- leaks.
--
-- Additive and inert: nothing reads these tables until the API code ships, and
-- no balance, counter, pacing or capacity column is touched, so a lagging
-- deploy cannot affect lead allocation.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 — The keys.
--
-- key_prefix is the LOOKUP HANDLE and is not a credential: it identifies which
-- row to compare against, and is safe to display in the dashboard and in an
-- admin list. key_hash is the sha256 of the whole key and is the only thing
-- that authenticates.
--
-- SHA-256 rather than bcrypt/argon2 is deliberate and is argued in
-- src/lib/api/keys.ts: the secret is 40 characters of CSPRNG output with no
-- dictionary behind it, and the lookup runs on EVERY request, so a
-- deliberately slow KDF would tax every call to defend against an attack that
-- does not apply.
--
-- expires_at is nullable and null means never. An expired key reports its own
-- distinct error code, because a customer who cannot tell expiry from a typo
-- will open a support ticket for the wrong thing.
-- ---------------------------------------------------------------------------
create table if not exists public.customer_api_keys (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete cascade,
  name         text not null,
  key_prefix   text not null unique,
  key_hash     text not null,
  scopes       text[] not null default '{profile:read,leads:read}'::text[],
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  last_used_at timestamptz,
  revoked_at   timestamptz
);

alter table public.customer_api_keys drop constraint if exists customer_api_keys_name_len;
alter table public.customer_api_keys add constraint customer_api_keys_name_len
  check (char_length(name) between 1 and 60);

alter table public.customer_api_keys drop constraint if exists customer_api_keys_scopes_len;
alter table public.customer_api_keys add constraint customer_api_keys_scopes_len
  check (cardinality(scopes) > 0);

-- The scope vocabulary. A typo'd scope fails CLOSED, which is safe but silent —
-- the customer gets 403s from a key that looks right in the UI — so it is
-- rejected at creation instead.
--
-- PHASE 2 EXTENDS THIS BY DROPPING AND RE-ADDING, never by a bare
-- `add constraint`, which fails the second time a migration is applied.
alter table public.customer_api_keys drop constraint if exists customer_api_keys_scopes_known;
alter table public.customer_api_keys add constraint customer_api_keys_scopes_known
  check (scopes <@ array['profile:read', 'leads:read']::text[]);

create index if not exists customer_api_keys_customer_idx
  on public.customer_api_keys (customer_id)
  where revoked_at is null;

comment on table public.customer_api_keys is
  'Per-customer API credentials for the read-only public API and MCP server. '
  'Only the sha256 hash is stored; the raw key exists in one HTTP response and '
  'is never recoverable.';
comment on column public.customer_api_keys.key_prefix is
  'Public lookup handle (sfl_live_ + 8 chars). Identifies the row to compare '
  'against and authenticates nothing — safe to display.';
comment on column public.customer_api_keys.key_hash is
  'sha256 hex of the full key. Compared with a timing-safe equality check.';
comment on column public.customer_api_keys.scopes is
  'Subset of the vocabulary in customer_api_keys_scopes_known. Extend that '
  'CHECK by drop-and-re-add, never a bare add constraint.';
comment on column public.customer_api_keys.expires_at is
  'Null means never expires. An expired key reports expired_api_key, distinct '
  'from invalid_api_key, so a customer can tell expiry from a typo.';
comment on column public.customer_api_keys.last_used_at is
  'Written at most once per key per five minutes. Stamping it on every request '
  'would turn a read endpoint into a write endpoint at full request volume.';
comment on column public.customer_api_keys.revoked_at is
  'Revocation is a stamp, never a row delete: a deleted row takes last_used_at '
  'and the prefix with it, which is the evidence wanted after a key leaks.';

-- RLS on with NO POLICY: deny-all to the browser. Stronger than the usual
-- reason here — key_hash must be unreachable EVEN BY THE KEY'S OWNER, and
-- getCurrentCustomer() reads on the service role, so nothing in the dashboard
-- needs a policy to work. Same posture as operator_proof_snapshots (0081).
alter table public.customer_api_keys enable row level security;


-- ---------------------------------------------------------------------------
-- 2 — Rate limiting.
--
-- SUBJECT KIND, not a key_id foreign key. Two ceilings are enforced — per key
-- per minute, and per CUSTOMER per day — and a table keyed on the key alone
-- has nowhere to put the second: with five keys allowed, a per-key daily cap
-- would mean a real per-customer ceiling of five times the number.
--
-- Losing the FK costs almost nothing, because revocation is a stamp rather
-- than a delete (section 1) so a key row is never removed, and the sweep
-- discards windows older than a day regardless.
-- ---------------------------------------------------------------------------
create table if not exists public.api_rate_limits (
  subject_kind  text        not null,
  subject_id    uuid        not null,
  window_start  timestamptz not null,
  request_count integer     not null default 0,
  primary key (subject_kind, subject_id, window_start)
);

alter table public.api_rate_limits drop constraint if exists api_rate_limits_subject_kind;
alter table public.api_rate_limits add constraint api_rate_limits_subject_kind
  check (subject_kind in ('key', 'customer'));

comment on table public.api_rate_limits is
  'Fixed-window request counters. Rolled into api_usage_daily and discarded by '
  'the daily pool sweep, so this table stays small.';

alter table public.api_rate_limits enable row level security;


-- ---------------------------------------------------------------------------
-- 3 — Usage history.
--
-- A ROLLUP RATHER THAN A COUNTER COLUMN. Incrementing a request_count on
-- customer_api_keys would turn every read into a write, which is the same trap
-- last_used_at coalescing exists to avoid. The sweep folds expiring rate-limit
-- windows in here before deleting them, so history costs nothing per request.
-- ---------------------------------------------------------------------------
create table if not exists public.api_usage_daily (
  key_id        uuid not null references public.customer_api_keys(id) on delete cascade,
  day           date not null,
  request_count integer not null default 0,
  primary key (key_id, day)
);

comment on table public.api_usage_daily is
  'Per-key daily request totals, folded in from api_rate_limits by the daily '
  'sweep. Never written on the request path.';

alter table public.api_usage_daily enable row level security;


-- ---------------------------------------------------------------------------
-- 4 — The request log.
--
-- This is what makes the admin view worth having. A usage total says the API
-- was called; it cannot say WHAT was called or why it failed, and an
-- X-Request-Id header is only useful if something stored it.
--
-- REJECTED REQUESTS ARE LOGGED TOO — a bad key, an expired one, a rate limit,
-- the kill switch — and those are the rows most worth seeing. They carry a
-- null key_id and customer_id, which is why both are nullable.
--
-- One insert per request is real write volume. At this book size on a
-- read-only surface it is negligible; if that ever changes, sample rather than
-- drop, and say so here. Swept at 30 days by the daily pool sweep.
-- ---------------------------------------------------------------------------
create table if not exists public.api_request_log (
  id          uuid primary key default gen_random_uuid(),
  request_id  text not null,
  key_id      uuid references public.customer_api_keys(id) on delete set null,
  customer_id uuid references public.customers(id) on delete cascade,
  surface     text not null,
  operation   text not null,
  status_code integer not null,
  error_code  text,
  duration_ms integer,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now()
);

alter table public.api_request_log drop constraint if exists api_request_log_surface;
alter table public.api_request_log add constraint api_request_log_surface
  check (surface in ('rest', 'mcp'));

create index if not exists api_request_log_created_idx
  on public.api_request_log (created_at desc);
create index if not exists api_request_log_customer_idx
  on public.api_request_log (customer_id, created_at desc);

comment on table public.api_request_log is
  'One row per API or MCP request, including rejected ones. Swept at 30 days.';
comment on column public.api_request_log.key_id is
  'Null on a request rejected before a key resolved — which is most of what is '
  'worth looking at when something is wrong.';
comment on column public.api_request_log.surface is
  'rest or mcp. Both front doors log through one path, so a view showing only '
  'one would hide exactly the half you went looking for.';

alter table public.api_request_log enable row level security;


-- ---------------------------------------------------------------------------
-- 5 — Consuming both rate-limit windows in one round trip.
--
-- INCREMENT THEN COMPARE, NEVER CHECK THEN INCREMENT. Reading a count and then
-- writing it leaves a window two concurrent requests both pass through. The
-- same claim-by-write discipline credit_invoice() uses against Stripe
-- redelivery and announcement_deliveries against a double-clicked send.
--
-- Both windows are consumed here rather than in two calls so the request path
-- costs one round trip, not two.
--
-- The caller compares the returned counts against its own limits; this
-- function deliberately takes no limit argument, because a parameter that
-- looks like it enforces something and does not is worse than none.
--
-- RETURNS JSONB, NOT A ONE-ROW TABLE. The first cut returned
-- `table (minute_count integer, day_count integer)`, which PostgREST calls as
-- a set-returning function in a FROM clause. Through that path the upserts did
-- not persist at all — while the identical function committed normally when
-- called directly over SQL — so every caller read a count of 1 for ever and the
-- limit could never be reached. A scalar return is evaluated in the target
-- list, which is the shape every other writing RPC in this codebase uses.
-- ---------------------------------------------------------------------------
create or replace function public.consume_api_rate_limit(
  p_key_id           uuid,
  p_customer_id      uuid,
  p_minute_seconds   integer default 60,
  p_day_seconds      integer default 86400
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_minute_window timestamptz;
  v_day_window    timestamptz;
  v_minute        integer;
  v_day           integer;
begin
  -- A zero or negative window divides by zero inside the floor() below.
  if p_minute_seconds <= 0 or p_day_seconds <= 0 then
    raise exception 'consume_api_rate_limit: window seconds must be positive';
  end if;

  v_minute_window := to_timestamp(
    floor(extract(epoch from now()) / p_minute_seconds) * p_minute_seconds
  );
  v_day_window := to_timestamp(
    floor(extract(epoch from now()) / p_day_seconds) * p_day_seconds
  );

  insert into public.api_rate_limits (subject_kind, subject_id, window_start, request_count)
  values ('key', p_key_id, v_minute_window, 1)
  on conflict (subject_kind, subject_id, window_start)
    do update set request_count = api_rate_limits.request_count + 1
  returning request_count into v_minute;

  insert into public.api_rate_limits (subject_kind, subject_id, window_start, request_count)
  values ('customer', p_customer_id, v_day_window, 1)
  on conflict (subject_kind, subject_id, window_start)
    do update set request_count = api_rate_limits.request_count + 1
  returning request_count into v_day;

  return jsonb_build_object('minute_count', v_minute, 'day_count', v_day);
end;
$$;

-- 0028/0049: a create-or-replace discards the function's ACL, so these two
-- lines must be re-asserted after EVERY future edit to the body above. A
-- signature change needs a fresh pair against the NEW signature — the old one
-- keeps its own ACL and lingers.
revoke all on function public.consume_api_rate_limit(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(uuid, uuid, integer, integer)
  to service_role;


-- ---------------------------------------------------------------------------
-- 6 — The kill switch.
--
-- Following pool_enabled (0073) and escalation_enabled (0062). This is the
-- control that turns the whole surface off without a deploy — the one thing
-- worth having at 2am when a key has leaked or an integration is looping.
--
-- It deliberately does NOT gate the key-management routes: a customer must be
-- able to revoke a key while the API is switched off.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('api_enabled', 'true')
  on conflict (key) do nothing;
