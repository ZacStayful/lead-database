-- ---------------------------------------------------------------------------
-- 0130 — A durable rate limit for password reset, so the route can stop lying
--        about unknown addresses (§43).
--
-- WHY THIS EXISTS
-- ---------------
-- /api/auth/forgot-password swallowed "no such user" from generateLink and
-- returned {ok:true}, so a customer who typed the wrong address was told
-- "check your inbox" and nothing was sent. One paying customer lost a day to
-- this: she signed up with a personal address, tried to reset with her business
-- one, and had no way to discover the difference. The route now says plainly
-- when it does not recognise an address.
--
-- That disclosure is only safe with a durable limiter. The route's own comment
-- justified its in-memory Map on the grounds that "the endpoint only ever
-- emails an address that already has an account" — which stops being true the
-- moment it discloses. A per-instance Map would leave an account oracle bounded
-- only by one serverless instance's memory. The two changes ship together.
--
-- ⚠️ THE SUBJECT IS A SHA-256 HASH, NEVER THE ADDRESS. Hashed in TypeScript
-- before it gets here. A plaintext column would quietly accumulate every email
-- anyone has ever typed into a public form — a list we have no reason to hold
-- and no policy covering.
--
-- ⚠️ RETURNS JSONB, NOT A TABLE. PostgREST calls a set-returning function in a
-- FROM clause, where its upserts do not persist — §27.4, which cost a day when
-- consume_api_rate_limit was written the other way and silently counted
-- nothing while the request log beside it filled up correctly.
--
-- All three windows are consumed in ONE round trip, following
-- consume_api_rate_limit (0095) rather than consume_provider_budget (0115),
-- because this sits on a user-facing request path and three sequential RPCs
-- would be three network hops before the form responds.
--
-- Additive: one table, one function. No existing object is redefined, and
-- nothing here touches a balance, counter, pacing or capacity column. Inert
-- until the route reads it — but note the route FAILS CLOSED, so the code must
-- not deploy ahead of this migration or every reset request is throttled.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1 — The windows table.
--
-- One row per (subject, window). With a 60s and a 3600s window per email and a
-- 3600s window per IP, a single customer resetting their password creates at
-- most three rows an hour. RLS on with no policies: deny-all to the browser,
-- as subscription_pauses and operator_proof_snapshots.
-- ---------------------------------------------------------------------------
create table if not exists public.reset_rate_windows (
  subject_kind  text        not null,
  subject_hash  text        not null,
  window_start  timestamptz not null,
  attempts      integer     not null default 0,
  primary key (subject_kind, subject_hash, window_start)
);

alter table public.reset_rate_windows
  drop constraint if exists reset_rate_windows_subject_kind_check;
alter table public.reset_rate_windows
  add constraint reset_rate_windows_subject_kind_check
  check (subject_kind in ('email', 'ip'));

alter table public.reset_rate_windows
  drop constraint if exists reset_rate_windows_hash_check;
alter table public.reset_rate_windows
  add constraint reset_rate_windows_hash_check
  check (subject_hash ~ '^[0-9a-f]{64}$');

alter table public.reset_rate_windows enable row level security;

-- Serves the opportunistic cleanup in the function below.
create index if not exists reset_rate_windows_window_start_idx
  on public.reset_rate_windows (window_start);


-- ---------------------------------------------------------------------------
-- 2 — consume_reset_budget.
--
-- INCREMENT THEN COMPARE, NEVER CHECK THEN INCREMENT. The caller reads the
-- returned counts and decides; this function has no opinion about the limits,
-- so they can be tuned in TypeScript without a migration.
--
-- p_ip_hash is nullable: a request whose client IP the platform does not report
-- is still rate limited on its email, rather than being refused or waved
-- through. The ip_long count comes back null in that case.
-- ---------------------------------------------------------------------------
create or replace function public.consume_reset_budget(
  p_email_hash     text,
  p_ip_hash        text default null,
  p_short_seconds  integer default 60,
  p_long_seconds   integer default 3600
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_short_window timestamptz;
  v_long_window  timestamptz;
  v_email_short  integer;
  v_email_long   integer;
  v_ip_long      integer := null;
begin
  v_short_window := to_timestamp(
    floor(extract(epoch from now()) / greatest(p_short_seconds, 1))
      * greatest(p_short_seconds, 1));
  v_long_window := to_timestamp(
    floor(extract(epoch from now()) / greatest(p_long_seconds, 1))
      * greatest(p_long_seconds, 1));

  insert into public.reset_rate_windows (subject_kind, subject_hash, window_start, attempts)
    values ('email', p_email_hash, v_short_window, 1)
  on conflict (subject_kind, subject_hash, window_start)
    do update set attempts = public.reset_rate_windows.attempts + 1
  returning attempts into v_email_short;

  -- The long window is a separate row because the two windows are different
  -- sizes; a single row cannot express both without losing one of them at the
  -- boundary.
  insert into public.reset_rate_windows (subject_kind, subject_hash, window_start, attempts)
    values ('email', p_email_hash, v_long_window, 1)
  on conflict (subject_kind, subject_hash, window_start)
    do update set attempts = public.reset_rate_windows.attempts + 1
  returning attempts into v_email_long;

  if p_ip_hash is not null then
    insert into public.reset_rate_windows (subject_kind, subject_hash, window_start, attempts)
      values ('ip', p_ip_hash, v_long_window, 1)
    on conflict (subject_kind, subject_hash, window_start)
      do update set attempts = public.reset_rate_windows.attempts + 1
    returning attempts into v_ip_long;
  end if;

  -- Opportunistic cleanup. provider_rate_windows (0115) has none and simply
  -- grows, which is survivable there and avoidable here for almost nothing:
  -- this runs on roughly one request in fifty, against an indexed column, on a
  -- table that is small by construction.
  if random() < 0.02 then
    delete from public.reset_rate_windows
     where window_start < now() - interval '2 days';
  end if;

  return jsonb_build_object(
    'email_short', v_email_short,
    'email_long',  v_email_long,
    'ip_long',     v_ip_long,
    'short_window', v_short_window,
    'long_window',  v_long_window
  );
end;
$$;

-- 0095's warning, repeated because it keeps being true: a `create or replace`
-- discards the function's ACL, so these grants must be re-asserted every time
-- this function is edited. See §11 on get_next_customers_for_lead.
revoke execute on function public.consume_reset_budget(text, text, integer, integer)
  from public, anon, authenticated;
grant  execute on function public.consume_reset_budget(text, text, integer, integer)
  to service_role;

comment on function public.consume_reset_budget(text, text, integer, integer) is
  'Rate limiter for /api/auth/forgot-password, which discloses whether an address is known '
  'and therefore needs a limit that survives across serverless instances. Subjects are '
  'SHA-256 hashes, never addresses. Increments first and returns the new counts so the '
  'caller compares against its own ceilings. Callers must FAIL CLOSED on error.';

comment on table public.reset_rate_windows is
  'Password-reset attempt counters, keyed by SHA-256 of the email address and of the client '
  'IP. Deny-all to the browser (RLS on, no policies); written only by consume_reset_budget '
  'on the service role.';
