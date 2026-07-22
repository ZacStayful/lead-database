-- Speed-to-lead: record the first time a customer marks a lead contacted.
-- Time from assigned_at to first_contacted_at is the operator's response time —
-- the input to the "faster contact converts more" benchmark. Stamped once and
-- never overwritten, so it captures the true first touch.

alter table public.lead_assignments
  add column if not exists first_contacted_at timestamptz;
