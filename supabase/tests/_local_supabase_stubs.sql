-- Objects the Supabase platform provides that a bare Postgres does not.
--
-- Needed to apply supabase/migrations/ to a scratch database. Re-runnable: the
-- roles and the publication are cluster-wide and survive a drop database, so
-- both are created conditionally.
--
-- auth.users carries only the columns the migrations actually read
-- (last_sign_in_at is used by 0063's engagement weighting). pg_cron cannot be
-- installed locally, so the two calls the migrations make are stubbed and the
-- create-extension line is stripped at apply time.
create extension if not exists pgcrypto;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I', r); end if;
  end loop;
end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  last_sign_in_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select 'authenticated'::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create schema if not exists cron;
create table if not exists cron.job (jobname text);
create or replace function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
create or replace function cron.unschedule(text) returns boolean language sql as $$ select true $$;
do $$ begin if not exists (select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if; end $$;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
