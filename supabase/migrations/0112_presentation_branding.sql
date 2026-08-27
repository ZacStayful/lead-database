-- ---------------------------------------------------------------------------
-- 0112 — An operator's own branding on the income presentation.
--
-- `public/income-presentation/` is the deck a management customer walks a
-- landlord through, and since 0093 it arrives filled in from the lead's
-- analysis. It has always been OURS to look at: Stayful green throughout, and
-- the operator's identity reduced to one line of text — "prepared by <name>".
--
-- This is the other half of §26's argument. The management fee is not taken
-- from the report because the operator presenting is not Stayful and must not
-- quote our price as theirs; by exactly the same reasoning they should not be
-- presenting our colours as theirs either. Their logo, their colour, no Stayful
-- mark on any slide.
--
-- ANY SUBSCRIBER, MANAGEMENT OR GR. The lead-seeded half stays management-only
-- (invariant 6 — a GR operator earns a margin, not a fee, so the pitch is not
-- theirs), but a GR customer reaches the blank tool from Documents today and a
-- logo is an identity rather than a product feature.
--
-- Additive and inert on its own: nothing here touches a balance, counter,
-- pacing or capacity column, and no existing query reads either column.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 — Where the branding lives.
--
-- SMALL BY DESIGN. `getCurrentCustomer()` reads this table with `select("*")`
-- on every dashboard load, so whatever sits here is fetched on every page an
-- operator opens. The blob holds a colour and a pointer; the LOGO'S BYTES live
-- in storage (section 3) precisely so they never ride along.
--
-- Shape, and the whitelist that enforces it, is `validatePresentationBrand()`
-- in src/lib/presentationBrand.ts:
--
--   { "accent": "#2f7d4f",
--     "logo": { "path": "<customer_id>/logo", "mime": "image/png",
--               "sizeBytes": 24576 } }
--
-- jsonb rather than columns for the same reason `presentation_settings` is:
-- this is a display profile read by one feature, not something any query joins,
-- filters or aggregates on.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists presentation_brand            jsonb not null default '{}'::jsonb,
  add column if not exists presentation_brand_updated_at timestamptz;

comment on column public.customers.presentation_brand is
  'The operator''s own branding for the income presentation: an accent colour '
  'and a pointer at their logo in the presentation-brand bucket. Validated and '
  'defaulted by validatePresentationBrand(); every colour BUT the accent is '
  'derived from it at render time, so a customer cannot store a palette that '
  'renders a slide unreadable. Deliberately small — customers is read with '
  'select("*") on every dashboard load, so the logo''s bytes must never be '
  'here.';

-- ---------------------------------------------------------------------------
-- 2 — ⚠️ A SEPARATE TIMESTAMP FROM presentation_settings_updated_at.
--
-- That column is the "have they set their terms up yet" test (§26.5), and it is
-- NULL-versus-set rather than a test of the blob's contents, precisely so a
-- customer who saves a profile identical to the defaults counts as configured.
--
-- Sharing it here would mean uploading a logo silently answers a question
-- nobody asked: the tool would stop prompting an operator about the fee and
-- contract terms they have never once looked at, and present Stayful's generic
-- wording under their own logo. Two facts, two columns.
-- ---------------------------------------------------------------------------
comment on column public.customers.presentation_brand_updated_at is
  'When the branding was last saved. NULL means never — which is a different '
  'fact from presentation_settings_updated_at being null, and must stay so: a '
  'logo upload may not silence the prompt about terms the operator has not '
  'reviewed.';

-- ---------------------------------------------------------------------------
-- 3 — The bucket, following lead-reports (0092) exactly.
--
-- PRIVATE, AND WITH NO storage.objects POLICY AT ALL — deny-all to the browser.
-- lead-files is the other shape available and it does not fit: every one of its
-- policies keys on (storage.foldername(name))[1] = auth.uid()::text because each
-- object belongs to one customer *as their own file*. A logo is read by the
-- operator's own browser through our route and by nobody else, so a signature
-- is the whole authorisation story and a policy would only be a second one.
--
-- ⚠️ THE PATH IS FIXED: <customer_id>/logo, no extension. One object per
-- customer, replaced by overwrite (upsert), so there is no second file to
-- delete, no window in which two exist, and a png-to-jpg swap cannot orphan the
-- old one. The mime type is carried in the jsonb instead, which is also what
-- makes the extensionless path safe to serve.
--
-- SVG IS ALLOWED. It is only ever rendered inside an <img>, where browsers
-- refuse scripts and external references, and a vector logo is the one that
-- still looks right projected onto a wall. It must never be inlined into the
-- page's own markup. The route sniffs the bytes rather than trusting the
-- declared type, and holds SVG to a tighter size cap than raster.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'presentation-brand',
  'presentation-brand',
  false,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
