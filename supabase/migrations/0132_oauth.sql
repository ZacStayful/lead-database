-- ---------------------------------------------------------------------------
-- 0132 — OAuth 2.1, so an AI assistant can connect without an API key.
--
-- WHY THIS EXISTS. /api/mcp authenticates with a per-customer API key (0095).
-- That serves n8n, Cursor and VS Code, and Claude Desktop through an
-- `mcp-remote --header` bridge. It does not serve the two front doors customers
-- actually reach for: claude.ai custom connectors and ChatGPT connectors,
-- neither of which can present a static key. Measured against production before
-- this was written: the endpoint returns 401 with a bare `WWW-Authenticate:
-- Bearer`, and all four OAuth discovery paths a client then probes return 404.
--
-- 0095's header called the API "a second front door onto rooms that already
-- have a lock". This is a third door onto the same rooms. Invariant 7 still
-- holds; nothing here widens what a customer may reach. It changes how they may
-- prove who they are, and the surface behind it stays read-only.
--
-- HASH-ONLY STORAGE, following customer_api_keys (0095) and lead_topup_tokens
-- (0041): only the sha256 of a code or token is stored, and the raw value exists
-- in exactly one HTTP response. A leaked database row cannot reconstruct a
-- usable credential.
--
-- REVOCATION IS A STAMP, NEVER A DELETE, for the same reason 0095 gives: a
-- deleted row takes last_used_at and the prefix with it, which is precisely the
-- evidence wanted after something leaks.
--
-- ADDITIVE AND INERT. Nothing reads these tables until the code ships, the two
-- CHECK widenings below can only admit values nothing writes yet, and the
-- four-argument consume_api_rate_limit is preserved as a shim so every existing
-- caller keeps working byte-for-byte. oauth_enabled is seeded FALSE, so even
-- with the code deployed the discovery documents 404 and every client behaves
-- exactly as it does today. No balance, counter, pacing or capacity column is
-- touched, so a lagging deploy cannot affect lead allocation.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1 — Registered clients.
--
-- REGISTRATION IS OPEN AND UNAUTHENTICATED, because RFC 7591 dynamic client
-- registration is what MCP clients require — there is no human in the loop to
-- paste a client id. That is safe only because a client is not a credential: it
-- can ask for consent and nothing else, and every request it can make still
-- needs a customer to have sat in front of the consent screen and pressed Allow.
--
-- client_id is the PUBLIC handle and authenticates nothing, exactly as
-- customer_api_keys.key_prefix does. client_secret_hash is null for a public
-- client, which is the MCP norm: those authenticate with PKCE instead, and a
-- secret embedded in a desktop app or a browser is not a secret.
--
-- redirect_uris is capped at 5 by CHECK. It is the open-redirector surface, so
-- it is the one field worth bounding in the schema rather than only in the
-- route.
--
-- created_ip is kept for one reason: this endpoint is open, so if it is ever
-- abused the question will be "who", and a registration with no origin recorded
-- cannot answer it.
-- ---------------------------------------------------------------------------
create table if not exists public.oauth_clients (
  id                         uuid primary key default gen_random_uuid(),
  client_id                  text not null unique,
  client_name                text not null,
  redirect_uris              text[] not null,
  grant_types                text[] not null default '{authorization_code,refresh_token}'::text[],
  response_types             text[] not null default '{code}'::text[],
  token_endpoint_auth_method text not null default 'none',
  client_secret_hash         text,
  scope                      text[] not null default '{profile:read,leads:read}'::text[],
  client_uri                 text,
  logo_uri                   text,
  software_id                text,
  software_version           text,
  created_ip                 text,
  created_at                 timestamptz not null default now(),
  last_used_at               timestamptz,
  disabled_at                timestamptz
);

alter table public.oauth_clients drop constraint if exists oauth_clients_name_len;
alter table public.oauth_clients add constraint oauth_clients_name_len
  check (char_length(client_name) between 1 and 120);

alter table public.oauth_clients drop constraint if exists oauth_clients_redirect_uris_len;
alter table public.oauth_clients add constraint oauth_clients_redirect_uris_len
  check (cardinality(redirect_uris) between 1 and 5);

alter table public.oauth_clients drop constraint if exists oauth_clients_auth_method;
alter table public.oauth_clients add constraint oauth_clients_auth_method
  check (token_endpoint_auth_method in ('none', 'client_secret_post', 'client_secret_basic'));

-- The same vocabulary as customer_api_keys_scopes_known, and extended the same
-- way: DROP AND RE-ADD, never a bare `add constraint`, which fails the second
-- time a migration is applied.
alter table public.oauth_clients drop constraint if exists oauth_clients_scope_known;
alter table public.oauth_clients add constraint oauth_clients_scope_known
  check (scope <@ array['profile:read', 'leads:read']::text[]);

comment on table public.oauth_clients is
  'Applications registered through RFC 7591 dynamic client registration. A '
  'client is not a credential: it can ask for consent and nothing more.';
comment on column public.oauth_clients.client_id is
  'Public handle. Authenticates nothing — safe to display and to log.';
comment on column public.oauth_clients.client_secret_hash is
  'Null for a public client, which is the MCP norm: those authenticate with '
  'PKCE, and a secret shipped inside a desktop app is not a secret.';
comment on column public.oauth_clients.redirect_uris is
  'Capped at 5 by CHECK. This is the open-redirector surface, so it is bounded '
  'in the schema and not only in the route.';
comment on column public.oauth_clients.created_ip is
  'Registration is open. If it is ever abused the question is "who", and a row '
  'with no origin recorded cannot answer it.';

alter table public.oauth_clients enable row level security;


-- ---------------------------------------------------------------------------
-- 2 — Authorization codes.
--
-- SINGLE USE, AND USE IS CLAIMED BY WRITE (see section 6). A code read and then
-- marked used leaves a window two concurrent redemptions both pass through,
-- which is the replay this table exists to prevent.
--
-- code_challenge is the PKCE S256 challenge. It is stored rather than the
-- verifier because the verifier is the client's secret for this one exchange and
-- we must never hold it; we only ever check that its hash matches this.
--
-- redirect_uri is stored so the token exchange can require the same value the
-- authorization was issued for. Without it, a code intercepted by one client can
-- be redeemed by another.
--
-- resource is RFC 8707: which protected resource the token is for. We have
-- exactly one, so this is recorded rather than branched on — but recording it is
-- what makes a second resource a migration rather than a redesign.
-- ---------------------------------------------------------------------------
create table if not exists public.oauth_authorization_codes (
  id             uuid primary key default gen_random_uuid(),
  code_hash      text not null unique,
  client_id      text not null references public.oauth_clients(client_id) on delete cascade,
  customer_id    uuid not null references public.customers(id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  scopes         text[] not null,
  resource       text,
  expires_at     timestamptz not null,
  used_at        timestamptz,
  created_at     timestamptz not null default now()
);

alter table public.oauth_authorization_codes drop constraint if exists oauth_authorization_codes_scopes_len;
alter table public.oauth_authorization_codes add constraint oauth_authorization_codes_scopes_len
  check (cardinality(scopes) > 0);

create index if not exists oauth_authorization_codes_expiry_idx
  on public.oauth_authorization_codes (expires_at);

comment on table public.oauth_authorization_codes is
  'Single-use authorization codes. Only the sha256 is stored, and redemption is '
  'claimed by write rather than checked and then written.';
comment on column public.oauth_authorization_codes.code_challenge is
  'The PKCE S256 challenge. The verifier is the client''s secret for this one '
  'exchange and is never stored — only checked against this.';
comment on column public.oauth_authorization_codes.redirect_uri is
  'The token exchange requires the same value. Without it, a code intercepted '
  'by one client could be redeemed by another.';

alter table public.oauth_authorization_codes enable row level security;


-- ---------------------------------------------------------------------------
-- 3 — Grants. THIS IS THE ROW A CUSTOMER SEES AND REVOKES.
--
-- One open grant per (customer, client), enforced by a partial unique index.
-- Re-consenting to a client you already connected is the ORDINARY case, not an
-- edge one — every reconnect does it — so the authorize flow must UPSERT onto
-- this row. A plain insert fails on the second connect, after the consent
-- screen, at the very end of the flow.
--
-- Tokens hang off a grant (section 4) rather than standing alone so that
-- revoking is one statement: revoke the grant, and every access and refresh
-- token under it dies with it. That is also what makes refresh-token reuse
-- detection able to kill a whole compromised chain.
-- ---------------------------------------------------------------------------
create table if not exists public.oauth_grants (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete cascade,
  client_id    text not null references public.oauth_clients(client_id) on delete cascade,
  scopes       text[] not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

alter table public.oauth_grants drop constraint if exists oauth_grants_scopes_len;
alter table public.oauth_grants add constraint oauth_grants_scopes_len
  check (cardinality(scopes) > 0);

create unique index if not exists oauth_grants_open_idx
  on public.oauth_grants (customer_id, client_id)
  where revoked_at is null;

create index if not exists oauth_grants_customer_idx
  on public.oauth_grants (customer_id)
  where revoked_at is null;

comment on table public.oauth_grants is
  'One open grant per (customer, client). The row a customer sees in Settings '
  'and revokes, and the unit refresh-token reuse detection revokes.';
comment on index public.oauth_grants_open_idx is
  'Reconnecting is the ordinary case, so the authorize flow must upsert onto '
  'this row rather than insert.';

alter table public.oauth_grants enable row level security;


-- ---------------------------------------------------------------------------
-- 4 — Access and refresh tokens, in one table.
--
-- ONE TABLE FOR BOTH KINDS, deliberately, so rotation and chain revocation live
-- in one place rather than being kept in step across two.
--
-- token_prefix is the lookup handle and authenticates nothing (0095's rule);
-- token_hash is the sha256 of the whole token and is the only thing that
-- authenticates.
--
-- rotated_to IS NOT BOOKKEEPING — IT IS LOAD-BEARING. A refresh token is
-- rotated on every use, and a rotated token presented again is normally a replay
-- worth revoking the whole grant over. But an MCP client runs tool calls in
-- PARALLEL, so two requests routinely find the access token expired and refresh
-- at the same moment, and the second one is a race rather than an attack.
-- Following rotated_to inside a short grace window lets the loser of that race
-- be handed the same successor pair instead of having its connection killed.
-- Without it a working connector disconnects at random under exactly the load
-- it is meant to handle — and reconnecting fixes it often enough to look like a
-- network fault rather than a bug.
-- ---------------------------------------------------------------------------
create table if not exists public.oauth_tokens (
  id           uuid primary key default gen_random_uuid(),
  grant_id     uuid not null references public.oauth_grants(id) on delete cascade,
  kind         text not null,
  token_prefix text not null unique,
  token_hash   text not null,
  scopes       text[] not null,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  rotated_to   uuid references public.oauth_tokens(id) on delete set null,
  rotated_at   timestamptz
);

alter table public.oauth_tokens drop constraint if exists oauth_tokens_kind;
alter table public.oauth_tokens add constraint oauth_tokens_kind
  check (kind in ('access', 'refresh'));

alter table public.oauth_tokens drop constraint if exists oauth_tokens_scopes_len;
alter table public.oauth_tokens add constraint oauth_tokens_scopes_len
  check (cardinality(scopes) > 0);

create index if not exists oauth_tokens_grant_idx
  on public.oauth_tokens (grant_id)
  where revoked_at is null;

create index if not exists oauth_tokens_expiry_idx
  on public.oauth_tokens (expires_at);

comment on table public.oauth_tokens is
  'Access and refresh tokens in one table so rotation and chain revocation live '
  'in one place. Only the sha256 is stored.';
comment on column public.oauth_tokens.rotated_to is
  'Load-bearing, not bookkeeping. An MCP client refreshes in parallel, so the '
  'loser of a refresh race must be handed the same successor pair rather than '
  'having its grant revoked as a replay. See the grace window in the token route.';

alter table public.oauth_tokens enable row level security;


-- ---------------------------------------------------------------------------
-- 5 — Fitting OAuth into the existing API housekeeping.
--
-- api_request_log.key_id CARRIES AN FK to customer_api_keys, so a token id
-- cannot go in it. token_id is a second nullable column rather than a widening
-- of the first, because "which key" and "which token" are different questions
-- and a column that means either would have to be read with a discriminator
-- anyway. An OAuth request leaves key_id null.
--
-- api_rate_limits.subject_id deliberately carries NO FK (0095 argues why), so a
-- token id is already safe to put there — only the subject_kind CHECK was in the
-- way. 'ip' is admitted for the open registration endpoint, where the subject is
-- an address rather than a row: the caller stores md5(ip)::uuid, which needs no
-- schema change and cannot collide with a real id.
-- ---------------------------------------------------------------------------
alter table public.api_request_log
  add column if not exists token_id uuid references public.oauth_tokens(id) on delete set null;

alter table public.api_request_log drop constraint if exists api_request_log_surface;
alter table public.api_request_log add constraint api_request_log_surface
  check (surface in ('rest', 'mcp', 'oauth'));

comment on column public.api_request_log.token_id is
  'Set for an OAuth-authenticated request, where key_id is null. Two columns '
  'rather than one because "which key" and "which token" are different questions.';

alter table public.api_rate_limits drop constraint if exists api_rate_limits_subject_kind;
alter table public.api_rate_limits add constraint api_rate_limits_subject_kind
  check (subject_kind in ('key', 'customer', 'oauth_token', 'ip'));


-- ---------------------------------------------------------------------------
-- 6 — Consuming a rate-limit window for something other than an API key.
--
-- ⚠️ A DEFAULTED FIFTH ARGUMENT WOULD NOT REPLACE THE EXISTING FUNCTION — it
-- would create an OVERLOAD, and every existing four-argument call would then
-- fail with "function is not unique". That is the trap 0109 and 0110 both record.
-- So this is a genuinely new five-argument function, and the four-argument form
-- is kept as a SHIM delegating 'key'. Every current caller keeps working
-- unchanged, which is also what lets this migration land ahead of the code.
--
-- The arithmetic is 0095's, unchanged: INCREMENT THEN COMPARE, never check then
-- increment, and both windows consumed in one round trip. The caller compares
-- the returned counts against its own limits; this function deliberately takes
-- no limit argument, because a parameter that looks like it enforces something
-- and does not is worse than none.
--
-- RETURNS JSONB, NOT A ONE-ROW TABLE — 0095's finding: through PostgREST a
-- set-returning function is called in a FROM clause and its upserts did not
-- persist at all, so every caller read a count of 1 for ever.
-- ---------------------------------------------------------------------------
create or replace function public.consume_api_rate_limit(
  p_subject_id       uuid,
  p_customer_id      uuid,
  p_subject_kind     text,
  p_minute_seconds   integer,
  p_day_seconds      integer
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
  if p_minute_seconds <= 0 or p_day_seconds <= 0 then
    raise exception 'consume_api_rate_limit: window seconds must be positive';
  end if;

  if p_subject_kind not in ('key', 'oauth_token', 'ip') then
    raise exception 'consume_api_rate_limit: unsupported subject kind %', p_subject_kind;
  end if;

  v_minute_window := to_timestamp(
    floor(extract(epoch from now()) / p_minute_seconds) * p_minute_seconds
  );
  v_day_window := to_timestamp(
    floor(extract(epoch from now()) / p_day_seconds) * p_day_seconds
  );

  insert into public.api_rate_limits (subject_kind, subject_id, window_start, request_count)
  values (p_subject_kind, p_subject_id, v_minute_window, 1)
  on conflict (subject_kind, subject_id, window_start)
    do update set request_count = api_rate_limits.request_count + 1
  returning request_count into v_minute;

  -- An 'ip' subject has no customer behind it — registration is unauthenticated
  -- — so the daily per-customer window is skipped rather than attributed to a
  -- customer who has not asked for anything.
  if p_customer_id is null then
    return jsonb_build_object('minute_count', v_minute, 'day_count', 0);
  end if;

  insert into public.api_rate_limits (subject_kind, subject_id, window_start, request_count)
  values ('customer', p_customer_id, v_day_window, 1)
  on conflict (subject_kind, subject_id, window_start)
    do update set request_count = api_rate_limits.request_count + 1
  returning request_count into v_day;

  return jsonb_build_object('minute_count', v_minute, 'day_count', v_day);
end;
$$;

-- The original signature, preserved so 0095's callers are untouched.
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
begin
  return public.consume_api_rate_limit(
    p_key_id, p_customer_id, 'key', p_minute_seconds, p_day_seconds
  );
end;
$$;

-- 0028/0049: a create-or-replace discards the function's ACL, so these must be
-- re-asserted after EVERY edit — and a NEW SIGNATURE needs its own pair, because
-- the old one keeps its own ACL and lingers.
revoke all on function public.consume_api_rate_limit(uuid, uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(uuid, uuid, text, integer, integer)
  to service_role;

revoke all on function public.consume_api_rate_limit(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(uuid, uuid, integer, integer)
  to service_role;


-- ---------------------------------------------------------------------------
-- 7 — Redeeming an authorization code.
--
-- CLAIM BY WRITE. The update's own WHERE clause is the check: it matches only a
-- code that is unused and unexpired, and stamps used_at in the same statement.
-- Reading the row and then marking it used leaves a window two concurrent
-- redemptions both pass through — the same discipline credit_invoice() uses
-- against Stripe redelivery and announcement_deliveries against a double-clicked
-- send.
--
-- Returns the row's contents so the caller needs no second read, and returns
-- null when nothing was claimed. The caller cannot tell "no such code" from
-- "already used" from "expired", which is deliberate: they are the same answer
-- to the client and distinguishing them is an oracle.
--
-- RETURNS JSONB for 0095's reason — a set-returning function called through
-- PostgREST is evaluated in a FROM clause and its writes did not persist.
-- ---------------------------------------------------------------------------
create or replace function public.consume_oauth_authorization_code(
  p_code_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.oauth_authorization_codes%rowtype;
begin
  update public.oauth_authorization_codes
     set used_at = now()
   where code_hash = p_code_hash
     and used_at is null
     and expires_at > now()
  returning * into v_row;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id',             v_row.id,
    'client_id',      v_row.client_id,
    'customer_id',    v_row.customer_id,
    'redirect_uri',   v_row.redirect_uri,
    'code_challenge', v_row.code_challenge,
    'scopes',         to_jsonb(v_row.scopes),
    'resource',       v_row.resource
  );
end;
$$;

revoke all on function public.consume_oauth_authorization_code(text)
  from public, anon, authenticated;
grant execute on function public.consume_oauth_authorization_code(text)
  to service_role;


-- ---------------------------------------------------------------------------
-- 8 — Housekeeping, folded into the sweep that already runs daily.
--
-- The body below is 0096's, verified byte-identical to production's live prosrc
-- (comments aside) before this migration was written, with three deletes added.
--
-- ⚠️ OAUTH RATE-LIMIT WINDOWS ARE DISCARDED RATHER THAN ROLLED UP, and that is a
-- known gap rather than an oversight: api_usage_daily.key_id carries an FK to
-- customer_api_keys and cannot hold a token id. The rollup below still filters
-- subject_kind = 'key', and the blanket window delete that follows removes the
-- OAuth rows along with everything else. Per-token usage history is readable
-- from api_request_log, which /admin/api and the customer panel both already
-- use. A per-grant rollup is a later, separate want.
--
-- Expired authorization codes are deleted outright rather than stamped, unlike
-- every credential in this schema. They are not evidence: a code lives five
-- minutes, is single use, and a redeemed one has already produced a grant row
-- that IS the record.
-- ---------------------------------------------------------------------------
create or replace function public.sweep_api_tables(
  p_window_retention_hours integer default 24,
  p_log_retention_days     integer default 30
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_window_cutoff timestamptz;
  v_log_cutoff    timestamptz;
  v_rolled        integer := 0;
  v_windows       integer := 0;
  v_logs          integer := 0;
  v_codes         integer := 0;
  v_tokens        integer := 0;
  v_clients       integer := 0;
begin
  v_window_cutoff := now() - make_interval(hours => greatest(p_window_retention_hours, 1));
  v_log_cutoff    := now() - make_interval(days  => greatest(p_log_retention_days, 1));

  -- Fold the expiring per-key windows into the daily totals. `excluded` carries
  -- the summed value for that key and day, so re-running after a successful
  -- delete finds nothing to add.
  with expiring as (
    select subject_id as key_id,
           (window_start at time zone 'utc')::date as day,
           sum(request_count)::integer as total
    from public.api_rate_limits
    where subject_kind = 'key'
      and window_start < v_window_cutoff
    group by subject_id, (window_start at time zone 'utc')::date
  ),
  -- Only keys that still exist: api_usage_daily has an FK, and a key deleted
  -- outright (rather than revoked) would otherwise fail the whole sweep.
  rolled as (
    insert into public.api_usage_daily (key_id, day, request_count)
    select e.key_id, e.day, e.total
    from expiring e
    join public.customer_api_keys k on k.id = e.key_id
    on conflict (key_id, day)
      do update set request_count = api_usage_daily.request_count + excluded.request_count
    returning 1
  )
  select count(*)::integer into v_rolled from rolled;

  with gone as (
    delete from public.api_rate_limits
    where window_start < v_window_cutoff
    returning 1
  )
  select count(*)::integer into v_windows from gone;

  with gone_logs as (
    delete from public.api_request_log
    where created_at < v_log_cutoff
    returning 1
  )
  select count(*)::integer into v_logs from gone_logs;

  -- A code lives five minutes. An hour's grace is generous and keeps the table
  -- empty rather than merely small.
  with gone_codes as (
    delete from public.oauth_authorization_codes
    where expires_at < now() - interval '1 hour'
    returning 1
  )
  select count(*)::integer into v_codes from gone_codes;

  -- Dead tokens are kept 30 days as the record of what was connected, then go.
  -- A live grant keeps its own tokens: only ones already expired or revoked are
  -- eligible.
  with gone_tokens as (
    delete from public.oauth_tokens
    where (revoked_at is not null and revoked_at < v_log_cutoff)
       or (expires_at < v_log_cutoff)
    returning 1
  )
  select count(*)::integer into v_tokens from gone_tokens;

  -- Registration is open, so clients that were created and never used are the
  -- expected residue. A client with any grant, live or revoked, is kept: it is
  -- what gives a grant row a readable name.
  with gone_clients as (
    delete from public.oauth_clients c
    where c.created_at < v_log_cutoff
      and not exists (select 1 from public.oauth_grants g where g.client_id = c.client_id)
    returning 1
  )
  select count(*)::integer into v_clients from gone_clients;

  return jsonb_build_object(
    'rolled_up', v_rolled,
    'windows_deleted', v_windows,
    'log_rows_deleted', v_logs,
    'oauth_codes_deleted', v_codes,
    'oauth_tokens_deleted', v_tokens,
    'oauth_clients_deleted', v_clients
  );
end;
$$;

-- 0028/0049 again: the ACL is discarded by the create-or-replace above.
revoke all on function public.sweep_api_tables(integer, integer)
  from public, anon, authenticated;
grant execute on function public.sweep_api_tables(integer, integer)
  to service_role;


-- ---------------------------------------------------------------------------
-- 9 — The kill switch, SEEDED FALSE.
--
-- A SECOND switch beside api_enabled, following pool_enabled (0073) and
-- escalation_enabled (0062), so OAuth can be turned off without taking API keys
-- down with it — and so it can be turned ON only once the whole flow has been
-- walked end to end.
--
-- FALSE IS WHAT MAKES STAGED DELIVERY SAFE. With it off the discovery documents
-- 404 and every client behaves exactly as it does today, so the resource-server
-- and authorization-server halves can land in separate deploys without ever
-- advertising an endpoint that is not there yet.
--
-- It deliberately does NOT gate the grant-management routes: a customer must be
-- able to revoke a connected app while OAuth is switched off, exactly as key
-- management ignores api_enabled.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value)
  values ('oauth_enabled', 'false')
  on conflict (key) do nothing;
