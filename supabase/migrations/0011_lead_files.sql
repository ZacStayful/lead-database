-- ============================================================================
-- Lead file attachments — customers can attach files (e.g. an STR Analyser
-- PDF) to a lead they've been assigned, and retrieve them later.
--
-- Files live in a private Storage bucket 'lead-files'; this table holds the
-- metadata. Storage objects are laid out as  <user_id>/<assignment_id>/<file>
-- so a single path-prefix check secures both upload and read.
-- ============================================================================

create table if not exists public.lead_files (
  id                 uuid primary key default gen_random_uuid(),
  lead_assignment_id uuid references public.lead_assignments(id) on delete cascade,
  customer_id        uuid references public.customers(id) on delete cascade,
  file_name          text not null,
  storage_path       text not null,
  size_bytes         bigint,
  mime_type          text,
  created_at         timestamptz not null default now()
);

create index if not exists idx_lead_files_assignment
  on public.lead_files(lead_assignment_id);
create index if not exists idx_lead_files_customer
  on public.lead_files(customer_id);

alter table public.lead_files enable row level security;

-- Customers may read their own file metadata. Inserts/deletes go through server
-- routes using the service role, so no write policy is exposed to the browser.
drop policy if exists "lead_files_select_own" on public.lead_files;
create policy "lead_files_select_own" on public.lead_files
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = lead_files.customer_id
        and c.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Storage bucket + object policies.
-- Private bucket, 25 MB per file. Path convention: <user_id>/<assignment_id>/…
-- so (storage.foldername(name))[1] is the owner's auth uid.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('lead-files', 'lead-files', false, 26214400)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists "lead_files_object_insert" on storage.objects;
create policy "lead_files_object_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'lead-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "lead_files_object_select" on storage.objects;
create policy "lead_files_object_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'lead-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "lead_files_object_delete" on storage.objects;
create policy "lead_files_object_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'lead-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
