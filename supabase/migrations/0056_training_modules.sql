-- ============================================================================
-- Training — ordered videos, audio recordings and written playbook articles,
-- free to every subscriber, plus per-customer progress.
--
-- Entirely additive. Nothing here reads, writes or derives from lead_balance,
-- gr_lead_balance, monthly_allocation, leads_received_this_month, or any
-- billing, pacing or capacity column. Training has no interaction with lead
-- allocation, credits, Stripe or capacity, and no gate on subscription tier:
-- every authenticated customer sees every published module.
--
-- Sequencing is presentational. sort_order gives the list an order; nothing is
-- locked behind completing the module before it.
-- ============================================================================

create table if not exists public.training_modules (
  id                      uuid primary key default gen_random_uuid(),
  slug                    text not null unique,
  title                   text not null,
  summary                 text not null,
  content_type            text not null
                            check (content_type in ('video', 'audio', 'article')),
  sort_order              integer not null default 0,

  -- Video: an embed URL on an allowlisted host. No video file ever enters
  -- Storage — the provider serves it.
  video_provider          text check (video_provider in ('loom', 'youtube', 'vimeo')),
  video_url               text,
  video_duration_seconds  integer,

  -- Audio: a path inside the private 'training-audio' bucket. Unlike video,
  -- these are our own files (call recordings), so they are stored rather than
  -- embedded — and stored privately, because a recording of a real landlord is
  -- personal data and a public object URL is permanent and guessable.
  audio_storage_path      text,
  audio_duration_seconds  integer,

  -- Article body, and optional notes beneath a video or recording.
  body_markdown           text,

  lead_type_scope         text not null default 'both'
                            check (lead_type_scope in ('management', 'guaranteed_rent', 'both')),
  is_published            boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- Publish-time integrity: a draft may be as incomplete as it likes, so that
  -- a module can be created before its video is recorded or its recording
  -- uploaded. The moment it is published it must actually be playable or
  -- readable, because publishing is what puts it in front of a customer.
  constraint training_modules_publishable check (
    is_published = false
    or (content_type = 'video'
        and video_url is not null
        and video_provider is not null)
    or (content_type = 'audio'
        and audio_storage_path is not null)
    or (content_type = 'article'
        and body_markdown is not null
        and btrim(body_markdown) <> '')
  )
);

create index if not exists idx_training_modules_published_order
  on public.training_modules(is_published, sort_order);

create table if not exists public.training_progress (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete cascade,
  module_id    uuid not null references public.training_modules(id) on delete cascade,
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (customer_id, module_id)
);

create index if not exists idx_training_progress_customer
  on public.training_progress(customer_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.training_modules  enable row level security;
alter table public.training_progress enable row level security;

-- Published modules are readable by any authenticated user — the same shape as
-- leads_select_authenticated (0001), narrowed to published rows so drafts stay
-- invisible. No INSERT, UPDATE or DELETE policy exists: every write goes
-- through an admin server route on the service role.
drop policy if exists "training_modules_select_published" on public.training_modules;
create policy "training_modules_select_published" on public.training_modules
  for select using (
    auth.role() = 'authenticated' and is_published = true
  );

-- Progress is readable by the owning customer only, resolving auth.uid() to a
-- customers row exactly as lead_notes_select_own (0009) does.
--
-- SELECT only, deliberately. Writes go through PATCH /api/customer/training/[id]
-- on the service role, so a browser-writable INSERT would add nothing except a
-- path for a customer to POST fabricated completions straight to PostgREST.
-- Consistent with CLAUDE.md invariant 7.
drop policy if exists "training_progress_select_own" on public.training_progress;
create policy "training_progress_select_own" on public.training_progress
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = training_progress.customer_id
        and c.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Storage bucket for audio.
--
-- Private, 100 MB per object. Reads are served through short-lived signed URLs
-- minted server-side, so nothing here needs a public object URL — and must not
-- have one. These are recordings of real, identifiable people; a public bucket
-- path works for anyone who has it, forever, with no login.
--
-- Path convention: training-audio/<module_id>/<filename>. Unlike lead-files
-- (0011), which keys its policy on the owner's uid because each object belongs
-- to one customer, training audio is shared content every subscriber reads —
-- so the read policy is bucket-wide and there is no per-user prefix to check.
-- Writes are service-role only: no insert, update or delete policy is created
-- for authenticated users.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('training-audio', 'training-audio', false, 104857600)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit;

drop policy if exists "training_audio_object_select" on storage.objects;
create policy "training_audio_object_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'training-audio');

-- ---------------------------------------------------------------------------
-- Seed. All unpublished and scoped to both products, with no media — the
-- publishable CHECK permits that precisely so these can exist as drafts while
-- the videos are still being recorded. Zac fills in the URLs and publishes
-- through /admin/training.
--
-- ON CONFLICT DO NOTHING so a re-run cannot overwrite edits made since.
-- ---------------------------------------------------------------------------
insert into public.training_modules
  (slug, title, summary, content_type, sort_order, lead_type_scope, is_published)
values
  ('the-first-ninety-seconds',
   'The first ninety seconds',
   'How to open the call so the landlord knows why you are ringing. Performed, not explained.',
   'video', 10, 'both', false),

  ('using-the-income-figure',
   'The estimated income figure, and how to use it',
   'What the number on the lead actually represents, and how to talk about it without overpromising.',
   'video', 20, 'both', false),

  ('the-follow-up-sequence',
   'The follow-up sequence, and when to stop',
   'How many touches, over how long, and the point at which more contact costs you more than it wins.',
   'video', 30, 'both', false),

  ('recovering-a-stalled-lead',
   'Recovering a stalled lead',
   'A no-show and an expired offer is not a dead lead. What the recovery move looks like.',
   'video', 40, 'both', false),

  ('after-they-say-yes',
   'After they say yes',
   'The signature is not the finish line. Getting the onboarding done before the property goes cold.',
   'video', 50, 'both', false),

  ('why-leads-dont-sign',
   'Why leads don''t sign',
   'The two points at which leads are lost, the four reasons behind them, and why a well-worked loss is not a failure.',
   'article', 60, 'both', false)
on conflict (slug) do nothing;
