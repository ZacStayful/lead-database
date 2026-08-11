-- ============================================================================
-- Training media uploads — make the library carry a 10-minute MP3 call
-- recording and a 40-minute MP4 web meeting.
--
-- 0057 built the table, the bucket and the whole module structure. This only
-- adjusts what that migration sized for shorter content, and closes one hole.
--
-- ⚠️ Most of this is ALREADY APPLIED to the production project, out of band,
-- before it existed as a file. Every statement is written to be idempotent so
-- replaying it here is a no-op against production and still rebuilds correctly
-- from scratch.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Two descriptive columns for an uploaded file.
--
-- 0057 stored the path, mime and duration but not what the file was called or
-- how big it is, so the admin list could not show an admin what they had
-- uploaded. Both are display-only and gate nothing.
-- ---------------------------------------------------------------------------
alter table public.training_modules
  add column if not exists media_file_name text,
  add column if not exists media_size_bytes bigint;

-- ---------------------------------------------------------------------------
-- 2. Size the bucket for a 40-minute video, and constrain what may land in it.
--
-- 500 MB was set for call recordings. A 40-minute screen-shared meeting at a
-- realistic bitrate runs past it, and the failure arrives only after the whole
-- upload has been sent. 2 GB is the new ceiling; the app refuses earlier and
-- per kind (100 MB audio, 1.5 GB video — src/lib/training.ts) so the common
-- mistakes get an explanation rather than a storage error.
--
-- greatest() so this can only ever widen the cap, never shrink it under
-- objects already uploaded against a larger one. `public` is deliberately not
-- touched: if this bucket is ever opened up on purpose, a replay of this
-- migration must not silently re-privatise it.
--
-- allowed_mime_types is asserted for the first time here. The bucket accepted
-- anything, so a mislabelled or unexpected file could be stored and later
-- served back to a customer. The list mirrors ALLOWED_MEDIA_MIME exactly — the
-- bucket must never reject something the app has already accepted.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'training-media',
  'training-media',
  false,
  2147483648,
  array[
    'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
    'audio/wav', 'audio/x-wav', 'audio/webm',
    'video/mp4', 'video/webm', 'video/quicktime'
  ]
)
on conflict (id) do update
  set file_size_limit    = greatest(
                             coalesce(storage.buckets.file_size_limit, 0),
                             excluded.file_size_limit
                           ),
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 3. Remove the blanket read grant on the bucket.
--
-- 0057 created `training_media_object_select`, which allowed EVERY
-- authenticated user to read EVERY object in 'training-media', conditioned on
-- nothing but the bucket id. It therefore bypassed both is_published and
-- lead_type_scope: any signed-in customer could list the bucket with the anon
-- key and pull down unpublished drafts or another product's training.
--
-- Nothing leaked — the bucket was still empty when this was found, so the
-- policy never had an object to expose. It becomes a real hole on the first
-- upload, which is what this branch enables.
--
-- Playback does not need it. signedMediaUrl() mints a short-lived signed URL
-- on the service role for a customer who has already passed the page's checks,
-- and a signed URL is authorised by its signature rather than by any policy.
-- Uploads do not need it either: the admin route mints a signed upload URL, so
-- the browser never holds a standing grant. The bucket is therefore left with
-- no storage.objects policy at all.
-- ---------------------------------------------------------------------------
drop policy if exists "training_media_object_select" on storage.objects;

-- ---------------------------------------------------------------------------
-- 4. Make the module read policy honour lead_type_scope.
--
-- 0057's policy returned every published module to every authenticated user,
-- so lead_type_scope was enforced only by the pages that happen to filter on
-- it. Since those pages read on the service role — where RLS gives them
-- nothing — this is defence in depth rather than the control, but a scope
-- column that nothing enforces is worse than no column at all.
--
-- The guaranteed-rent arm reads gr_subscription_status only. account_status
-- and subscription_status are management-only (§3), so either would show GR
-- training to management-only customers (invariant 6).
-- ---------------------------------------------------------------------------
drop policy if exists "training_modules_select_published" on public.training_modules;
create policy "training_modules_select_published" on public.training_modules
  for select to authenticated
  using (
    is_published
    and (
      lead_type_scope = 'both'
      or exists (
        select 1 from public.customers c
        where c.user_id = auth.uid()
          and (
            (training_modules.lead_type_scope = 'management'
              and c.subscription_status = 'active')
            or (training_modules.lead_type_scope = 'guaranteed_rent'
              and c.gr_subscription_status = 'active')
          )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Restore 0057's publishable CHECK.
--
-- An earlier pass at this work widened the constraint so a module with
-- content_type = 'video' could publish on an uploaded file instead of an
-- embed. That was solving a problem 0057 had already solved a different way:
-- 'recording' means "the bytes are ours" for audio AND video, and the player
-- picks <audio> or <video> from media_mime_type via isVideoMime(). Under the
-- widened rule a 'video' module could publish with no video_url, and the page
-- would render its embed branch and show "this video cannot be displayed".
--
-- Written unconditionally rather than guarded, so a database that received the
-- widened version is put back and one that never did is unaffected.
-- ---------------------------------------------------------------------------
alter table public.training_modules
  drop constraint if exists training_modules_publishable;

alter table public.training_modules
  add constraint training_modules_publishable check (
    is_published = false
    or (content_type = 'video'
          and video_url is not null
          and video_provider is not null)
    or (content_type = 'recording' and media_storage_path is not null)
    or (content_type = 'article'
          and body_markdown is not null
          and btrim(body_markdown) <> '')
  );
