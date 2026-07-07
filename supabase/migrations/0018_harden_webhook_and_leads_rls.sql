-- ============================================================================
-- Security / robustness hardening.
--
-- (1) Stripe webhook idempotency. Stripe delivers events at-least-once and
--     retries on any non-2xx or timeout, so invoice.paid (which grants lead
--     credit) can arrive more than once. A dedup table keyed on the Stripe
--     event id lets the handler claim each event exactly once and skip repeats,
--     preventing double-crediting of lead_balance / gr_lead_balance.
--
-- (2) leads RLS. The original policy let ANY authenticated user select EVERY
--     row in public.leads, so a customer using the anon client could read leads
--     that were never assigned to them (names, addresses, phone, email).
--     Restrict browser reads to leads the caller is actually assigned. Admin
--     and background writes use the service role, which bypasses RLS.
-- ============================================================================

-- (1) Stripe event dedup ----------------------------------------------------
create table if not exists public.stripe_events (
  id           text primary key,          -- Stripe event id (evt_...)
  type         text,
  processed_at timestamptz not null default now()
);

-- Service-role only: RLS on with no policies, never touched by the browser.
alter table public.stripe_events enable row level security;

-- (2) Tighten leads read access --------------------------------------------
drop policy if exists "leads_select_authenticated" on public.leads;
drop policy if exists "leads_select_own_assignments" on public.leads;
create policy "leads_select_own_assignments" on public.leads
  for select using (
    exists (
      select 1
      from public.lead_assignments la
      join public.customers c on c.id = la.customer_id
      where la.lead_id = leads.id
        and c.user_id = auth.uid()
    )
  );
