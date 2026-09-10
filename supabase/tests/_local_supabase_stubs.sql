create extension if not exists pgcrypto;
create role anon; create role authenticated; create role service_role;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid());
-- pg_cron is not installable here; stub the two calls the migrations make.
create schema if not exists cron;
create table if not exists cron.job (jobname text);
create or replace function cron.schedule(text, text, text) returns bigint language sql as $$ select 1::bigint $$;
create or replace function cron.unschedule(text) returns boolean language sql as $$ select true $$;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select 'authenticated'::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create publication supabase_realtime;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid
);
create or replace function storage.foldername(text) returns text[] language sql immutable as $$
  select string_to_array($1, '/')
$$;
