-- ============================================================================
-- Testimonials — a one-line quote a customer can leave at the moment they mark
-- a lead as signed. Captured at peak satisfaction (a fresh win) so it doubles
-- as acquisition fuel: with consent_to_publish, these become landing-page proof.
--
-- lead_assignment_id is the win that prompted it (nullable / set null on delete
-- so the quote survives if the lead is ever removed). customer_id is
-- denormalised for RLS and admin filtering.
-- ============================================================================

create table if not exists public.testimonials (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references public.customers(id) on delete cascade,
  lead_assignment_id uuid references public.lead_assignments(id) on delete set null,
  body               text not null,
  rating             smallint check (rating between 1 and 5),
  consent_to_publish boolean not null default false,
  created_at         timestamptz not null default now()
);

create index if not exists idx_testimonials_customer
  on public.testimonials(customer_id);

alter table public.testimonials enable row level security;

-- Customers may read their own testimonials. Inserts go through a server route
-- using the service role, so no insert policy is exposed to the browser client.
drop policy if exists "testimonials_select_own" on public.testimonials;
create policy "testimonials_select_own" on public.testimonials
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = testimonials.customer_id
        and c.user_id = auth.uid()
    )
  );
