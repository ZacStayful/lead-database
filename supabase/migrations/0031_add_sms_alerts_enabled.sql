-- Per-customer opt-out for the instant new-lead SMS alert.
-- Defaults to true (opted in) so existing customers keep receiving alerts; the
-- customer can switch it off from Settings. Sending is gated on this flag in
-- lib/sms.ts. Not writable via any browser RLS policy — updated only through the
-- authenticated /api/customer/settings server route (service role).

alter table public.customers
  add column if not exists sms_alerts_enabled boolean not null default true;
