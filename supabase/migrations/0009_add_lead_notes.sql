-- ============================================================================
-- Lead notes — timestamped, customer-private notes attached to a lead the
-- customer has been assigned. Lets an operator keep a running contact history
-- (calls, emails, next steps) against each lead.
--
-- Keyed on lead_assignment_id (unique per customer/lead pair). customer_id is
-- denormalised so RLS and the export can filter without a join.
-- ============================================================================

create table if not exists public.lead_notes (
  id                 uuid primary key default gen_random_uuid(),
  lead_assignment_id uuid references public.lead_assignments(id) on delete cascade,
  customer_id        uuid references public.customers(id) on delete cascade,
  body               text not null,
  created_at         timestamptz not null default now()
);

create index if not exists idx_lead_notes_assignment
  on public.lead_notes(lead_assignment_id);
create index if not exists idx_lead_notes_customer
  on public.lead_notes(customer_id);

alter table public.lead_notes enable row level security;

-- Customers may read their own notes. Inserts go through a server route using
-- the service role, so no insert policy is exposed to the browser client.
drop policy if exists "lead_notes_select_own" on public.lead_notes;
create policy "lead_notes_select_own" on public.lead_notes
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = lead_notes.customer_id
        and c.user_id = auth.uid()
    )
  );
