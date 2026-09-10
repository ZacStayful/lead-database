-- ---------------------------------------------------------------------------
-- 0135 — An inbound door for approved landlord leads (§48)
--
-- Ticket STF-0009: a customer's Make workflow approves a landlord enquiry and
-- wants it in Stayful, analysed, and presented — with a human on both ends.
-- Everything except the door already exists: customers add their own leads
-- (§30) and pay to analyse them (§31).
--
-- ⚠️ THIS DOES NOT OPEN THE PUBLIC API. §27.1's standing rule is that /api/v1
-- and the MCP tools are read-only in every direction, and all five v1 routes
-- export GET and nothing else. This is a RECEIVER on its own surface, the
-- shape /api/webhook/timelines/[token] and /api/webhook/resend/[token] already
-- established, so that sentence stays true rather than being amended.
--
-- ⚠️ AND IT NEVER CHARGES. The £3 analysis (§31) stays a deliberate in-app
-- action, so no broken automation can run up a bill. The response reports
-- whether a lead IS analysable, which is what the workflow needs to know.
--
-- Additive apart from three CHECK widenings and two function replacements,
-- each of which only ADMITS a value nothing writes yet. Nothing here touches a
-- balance, counter, pacing or capacity column.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Provenance: a fourth way a lead can arrive
-- ===========================================================================
-- ⚠️ DROP THEN ADD, NEVER A BARE `add constraint` — it fails the second time a
-- migration is applied, and this repo re-applies every migration to prove
-- idempotency (§28.9). The constraint name is the LIVE one, checked against
-- pg_constraint rather than guessed.

alter table public.leads drop constraint if exists leads_owner_source_check;
alter table public.leads
  add constraint leads_owner_source_check
  check (owner_source is null or owner_source in ('import', 'manual', 'webhook'));

-- ⚠️ leads_owner_pair_check is UNTOUCHED and still requires
-- (owner_customer_id is null) = (owner_source is null). The receiver sets both
-- or neither; it must never write one alone.

comment on column public.leads.owner_source is
  'How a customer-owned lead arrived: import (spreadsheet), manual (typed), '
  'or webhook (posted by their own automation, §48). Null for marketplace leads.';

-- ===========================================================================
-- 2. create_customer_leads accepts the new source
-- ===========================================================================
-- The body below is 0108's VERBATIM apart from one line. Production's prosrc
-- was confirmed byte-identical to 0108 (md5 3c477b9ee8e941b4b2f6431bf6fc7dfa,
-- 5817 bytes) before it was copied — §11 records that production has drifted
-- from supabase/migrations/ before, so this is checked rather than assumed.
--
-- ⚠️ `create or replace function` DISCARDS THE ACL (§11), so the grants are
-- re-asserted below. Without that this function becomes callable by anon and
-- authenticated, and it inserts leads.

create or replace function public.create_customer_leads(
  p_customer_id uuid,
  p_lead_type   public.lead_type,
  p_source      text,
  p_rows        jsonb
)
returns table (row_index integer, outcome text, created_lead_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_elem      jsonb;
  v_ord       bigint;
  v_name      text;
  v_email     text;
  v_phone     text;
  v_address   text;
  v_key       text;
  v_existing  uuid;
  v_new_id    uuid;
begin
  -- 0135 adds 'webhook'. The body is otherwise 0108's verbatim, and was
  -- confirmed byte-identical to production before being copied (§11).
  if p_source not in ('import', 'manual', 'webhook') then
    raise exception 'Unknown owned-lead source %', p_source;
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id) then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'create_customer_leads expects a JSON array of rows';
  end if;

  -- Bounded so one upload cannot hold a transaction open indefinitely. The
  -- route rejects an over-cap file before it reaches here with a message
  -- telling the customer to split it — truncating would silently lose leads.
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Too many rows in one import (% > 2000)', jsonb_array_length(p_rows);
  end if;

  for v_elem, v_ord in
    select value, ordinality from jsonb_array_elements(p_rows) with ordinality
  loop
    v_name    := nullif(btrim(coalesce(v_elem->>'name', '')), '');
    v_email   := nullif(btrim(coalesce(v_elem->>'email', '')), '');
    v_phone   := nullif(btrim(coalesce(v_elem->>'phone', '')), '');
    v_address := nullif(btrim(coalesce(v_elem->>'address', '')), '');

    row_index       := (v_ord - 1)::integer;
    created_lead_id := null;

    -- A row with no way to reach or identify anybody is a spreadsheet artefact
    -- (a spacer, a totals line, a stray note), not a lead.
    if v_name is null and v_email is null and v_phone is null and v_address is null then
      outcome := 'empty';
      return next;
      continue;
    end if;

    -- Same landlord, same owner, same product. lead_identity_key (0070) is
    -- reused rather than reimplemented so "the same landlord" has ONE
    -- definition repo-wide; it requires all three of name, email and phone, so
    -- a partial row has a null key and never matches — under-matching costs a
    -- duplicate, over-matching would silently discard a real lead.
    --
    -- Scoped to this owner: a customer's private copy is unrelated to whether
    -- WE hold the same landlord, and must not be suppressed by one.
    v_key := public.lead_identity_key(v_name, v_email, v_phone);

    if v_key is not null then
      --
      -- ⚠️ The `exists` is not decoration. The question this asks is "does the
      -- customer ALREADY HAVE this landlord", and `owner_customer_id` alone
      -- stopped answering it once delete gained its copy-only mode (0107): a
      -- lead sold on and then removed by its uploader keeps `owner_customer_id`
      -- for ever — that column is the provenance and the never-sell-it-back
      -- rule — while the uploader can no longer see it under
      -- `leads_select_assigned`.
      --
      -- Without this clause they could never re-add that landlord: the import
      -- would report "duplicate" against a row invisible to them, with nothing
      -- on any screen to explain it. Holding an assignment is what "have" means.
      select l.id into v_existing
      from public.leads l
      where l.owner_customer_id = p_customer_id
        and l.lead_type = p_lead_type
        and public.lead_identity_key(l.lead_name, l.email, l.phone) = v_key
        and exists (
          select 1 from public.lead_assignments la
          where la.lead_id = l.id
            and la.customer_id = p_customer_id
        )
      order by l.created_at
      limit 1;

      if v_existing is not null then
        outcome         := 'duplicate';
        created_lead_id := v_existing;
        return next;
        continue;
      end if;
    end if;

    -- lead_name is NOT NULL and always has been. Rather than weaken the column
    -- for a form that promises no required fields, fall back through whatever
    -- the customer DID give us, so the lead is identifiable in a list.
    insert into public.leads (
      monday_item_id,
      lead_name,
      address,
      phone,
      email,
      lead_profile,
      bedrooms,
      postcode,
      postcode_area,
      lead_type,
      owner_customer_id,
      owner_source,
      max_assignments,
      assignment_count,
      income_report_status,
      owner_resale_allowed
    ) values (
      null,
      coalesce(v_name, v_email, v_phone, v_address, 'Untitled lead'),
      v_address,
      v_phone,
      v_email,
      nullif(btrim(coalesce(v_elem->>'profile', '')), ''),
      nullif(btrim(coalesce(v_elem->>'bedrooms', '')), ''),
      nullif(btrim(coalesce(v_elem->>'postcode', '')), ''),
      nullif(btrim(coalesce(v_elem->>'postcode_area', '')), ''),
      p_lead_type,
      p_customer_id,
      p_source,
      1,
      1,
      'no_report',
      -- Stamped true here, and nowhere else. THIS is the new-uploads-only rule
      -- (§32): every lead that predates 0108 keeps the column default of false
      -- and can never become sellable, whatever is analysed later.
      --
      -- A property of the row rather than a clock. The obvious alternative is a
      -- cutoff timestamp in system_settings compared against created_at, on the
      -- `reclaim_enabled_from` precedent — but a global like that is one bad
      -- read away from enrolling the entire back catalogue at once, and it does
      -- not survive a restore into a different timeline. A per-row boolean
      -- defaulting to false fails in the safe direction by construction.
      true
    )
    returning id into v_new_id;

    insert into public.lead_assignments (lead_id, customer_id, price_paid, status, pipeline_stage)
      values (v_new_id, p_customer_id, 0, 'new', 'cold');

    outcome         := 'created';
    created_lead_id := v_new_id;
    return next;
  end loop;

  return;
end;
$$;
revoke all on function public.create_customer_leads(uuid, public.lead_type, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_customer_leads(uuid, public.lead_type, text, jsonb)
  to service_role;

-- ===========================================================================
-- 3. The receiver's credential
-- ===========================================================================
-- One row per webhook a customer creates. The token is HASHED, never stored
-- raw, following customer_api_keys — a leaked backup must not be a set of live
-- credentials.
--
-- ⚠️ The token travels in the URL PATH, so it is a bearer credential in a place
-- that reaches logs and referrers. That is proportionate ONLY because this door
-- spends no money and creates rows scoped to one customer. If it is ever
-- widened to charge, it must become a signed request first.

create table if not exists public.customer_lead_webhooks (
  id            uuid        primary key default gen_random_uuid(),
  customer_id   uuid        not null references public.customers(id) on delete cascade,
  name          text        not null,
  token_hash    text        not null,
  lead_type     public.lead_type not null default 'management',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,

  constraint customer_lead_webhooks_name_len check (char_length(name) between 1 and 80)
);

-- The lookup is by hash: the route hashes what it was given and matches.
create unique index if not exists customer_lead_webhooks_token_idx
  on public.customer_lead_webhooks (token_hash);

create index if not exists customer_lead_webhooks_customer_idx
  on public.customer_lead_webhooks (customer_id, created_at desc);

-- Deny-all to the browser, as lead_imports and subscription_pauses. Every read
-- goes through the service role.
alter table public.customer_lead_webhooks enable row level security;

-- ===========================================================================
-- 4. Idempotency — the thing this surface has never had
-- ===========================================================================
-- ⚠️ THERE IS NO REQUEST IDEMPOTENCY ANYWHERE ELSE ON THE API SURFACE. Every
-- existing guard is keyed on something the server generates INSIDE the request,
-- so a caller that times out and retries gets a second of everything.
-- create_customer_leads does dedupe, but on CONTENT, and its identity key needs
-- all three of name, email and phone (§30.3) — so a partial row does not dedupe
-- at all, and a Make retry creates a second landlord.
--
-- This is the house pattern: CLAIM BY INSERT, THEN ACT. credit_invoice() uses
-- it against Stripe redelivery (§19.5), the announcement send uses it (§21.2),
-- stripe_events uses it, and every outbound message uses it (§40.13).
--
-- ⚠️ The unique index LEADS ON customer_id, mirroring lead_messages_idempotency_idx
-- (0116). 0116's header calls that the containment guarantee: one customer's
-- keys are structurally unreachable from another's, and two customers may use
-- the same key without colliding.

create table if not exists public.customer_lead_webhook_claims (
  id               uuid        primary key default gen_random_uuid(),
  customer_id      uuid        not null references public.customers(id) on delete cascade,
  webhook_id       uuid        references public.customer_lead_webhooks(id) on delete set null,
  idempotency_key  text        not null,
  -- The MAPPING, not the response. A replay rebuilds the same body from the
  -- lead, so nothing stored here can go stale.
  lead_id          uuid        references public.leads(id) on delete set null,
  outcome          text,
  created_at       timestamptz not null default now(),

  constraint customer_lead_webhook_claims_key_len
    check (char_length(idempotency_key) between 1 and 200),
  constraint customer_lead_webhook_claims_outcome
    check (outcome is null or outcome in ('created', 'duplicate', 'empty'))
);

create unique index if not exists customer_lead_webhook_claims_idem_idx
  on public.customer_lead_webhook_claims (customer_id, idempotency_key);

create index if not exists customer_lead_webhook_claims_created_idx
  on public.customer_lead_webhook_claims (created_at);

alter table public.customer_lead_webhook_claims enable row level security;

comment on table public.customer_lead_webhook_claims is
  'Claim-by-INSERT idempotency for the inbound lead receiver (§48). A repeat of '
  'the same (customer, key) collides on 23505 and the route replays the original '
  'answer. ⚠️ The claim is DELETED when creation then fails, or the key is '
  'poisoned for ever and every retry replays a success that created nothing.';

-- ===========================================================================
-- 5. Housekeeping vocabularies
-- ===========================================================================
-- Both names are the LIVE ones from pg_constraint. Neither ends in _check,
-- which is exactly the kind of thing that is wrong when it is guessed.

alter table public.api_rate_limits drop constraint if exists api_rate_limits_subject_kind;
alter table public.api_rate_limits
  add constraint api_rate_limits_subject_kind
  check (subject_kind in ('key', 'customer', 'oauth_token', 'ip', 'webhook'));

alter table public.api_request_log drop constraint if exists api_request_log_surface;
alter table public.api_request_log
  add constraint api_request_log_surface
  check (surface in ('rest', 'mcp', 'oauth', 'webhook'));

-- ⚠️ api_request_log.key_id is a foreign key to customer_api_keys, so a webhook
-- request logs it NULL — exactly as an OAuth request already does (§45.10).

-- ===========================================================================
-- 6. The rate limiter learns the new subject kind
-- ===========================================================================
-- One line changes. The body is 0132's verbatim otherwise, and production's
-- prosrc was confirmed identical to it apart from a stripped comment block,
-- which is how §31 records migrations being applied here.
--
-- ⚠️ BOTH SIGNATURES' GRANTS ARE RE-ASSERTED. `create or replace` discards the
-- ACL (§11), and the four-argument shim delegates to this one, so leaving
-- either open would expose a writing function to anon.

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

  if p_subject_kind not in ('key', 'oauth_token', 'ip', 'webhook') then
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

revoke all on function public.consume_api_rate_limit(uuid, uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(uuid, uuid, text, integer, integer)
  to service_role;
revoke all on function public.consume_api_rate_limit(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(uuid, uuid, integer, integer)
  to service_role;


-- ===========================================================================
-- 7. Retention for the claims table
-- ===========================================================================
-- ⚠️ THE SIGNATURE DOES NOT CHANGE, AND MUST NOT.
--
-- The obvious move is a third parameter for the claim retention. Adding one
-- with a DEFAULT does not replace this function, it OVERLOADS it — and every
-- existing two-argument call then fails with "function is not unique". That is
-- the trap §34 and §35 both record, and the repo has now hit it twice. So the
-- claim cleanup reuses p_log_retention_days: a claim row is a mapping nobody
-- reads, and it wants the same lifetime as the request log it sits beside.
--
-- ⚠️ THE BODY BELOW IS 0132'S, NOT 0096'S. Both migrations define this
-- function. 0132 added the three OAuth deletes and their return keys, so
-- production's prosrc is 2480 bytes against 0096's 1904 — that is the current
-- body, not drift. It is copied verbatim here with ONE delete block and ONE
-- return key added.
--
-- ⚠️ The new 'webhook' rate-limit windows need nothing here. The blanket
-- window delete below is not filtered by subject_kind, so it already removes
-- them. Only the roll-up into api_usage_daily is 'key'-scoped, and that is
-- right: api_usage_daily.key_id carries an FK to customer_api_keys and cannot
-- hold a webhook id — the same reason OAuth windows are discarded rather than
-- rolled up (§45.10).
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
  v_claims        integer := 0;
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

  -- The idempotency claims (§48). A retrying automation retries within minutes;
  -- after a month the key is of no use to anybody, and keeping it would only
  -- make the table grow for ever. Dropping it means a caller replaying a
  -- month-old key creates a second lead, which is the right trade — that is a
  -- new request, not a retry.
  with gone_claims as (
    delete from public.customer_lead_webhook_claims
    where created_at < v_log_cutoff
    returning 1
  )
  select count(*)::integer into v_claims from gone_claims;

  return jsonb_build_object(
    'rolled_up', v_rolled,
    'windows_deleted', v_windows,
    'log_rows_deleted', v_logs,
    'oauth_codes_deleted', v_codes,
    'oauth_tokens_deleted', v_tokens,
    'oauth_clients_deleted', v_clients,
    'webhook_claims_deleted', v_claims
  );
end;
$$;

-- 0028/0049 again: the ACL is discarded by the create-or-replace above.
revoke all on function public.sweep_api_tables(integer, integer)
  from public, anon, authenticated;
grant execute on function public.sweep_api_tables(integer, integer)
  to service_role;
