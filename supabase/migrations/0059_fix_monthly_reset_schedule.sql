-- ============================================================================
-- Run the monthly reset DAILY, which is what it has always needed.
--
-- THE BUG
-- -------
-- reset_monthly_counts() was a blanket reset in 0001, scheduled by 0002 for
-- 00:05 on the 1st of the month:
--
--     select cron.schedule('reset-monthly-lead-counts', '5 0 1 * *', ...)
--
-- 0014 then rewrote the FUNCTION to reset each customer on their own billing
-- anchor day:
--
--     where extract(day from coalesce(billing_cycle_anchor, created_at::date))
--           = extract(day from current_date)
--
-- and 0018 extended the same logic to the GR counter. Neither migration changed
-- the SCHEDULE. So a function that only acts on customers whose anchor day
-- matches TODAY is invoked on exactly one day a month — the 1st.
--
-- Every customer whose billing anchor is not the 1st has therefore never had
-- leads_received_this_month reset, and never will.
--
-- Production, at the time of writing: 19 active management subscribers, anchor
-- days 20, 23, 23, 24, 25, 27, 28, 28, 28, 29, 1, 1, 3, 3, 4, 7, 8, 10, 10.
-- Two of the nineteen ever reset. The other seventeen accumulate forever.
--
-- WHY IT HAS NOT BEEN NOTICED
-- ---------------------------
-- leads_received_this_month is not the allocation gate — lead_balance is — so
-- nothing has been blocked or over-delivered, and no customer has been charged
-- wrongly. The damage is to FAIRNESS, and it has been invisible because every
-- customer's balance has been zero and there has been nothing to order:
--
--     deficit = round(days_elapsed/30 * monthly_allocation)
--               - leads_received_this_month
--
-- Past 30 days the first term clamps to the full allocation, so for a customer
-- who has received their allocation once, deficit sits at 0. After a second
-- month it is -20, after a third -40, while a customer who joined yesterday
-- scores +20. Deficit-first ordering hands every lead to the newest subscriber
-- and starves the longest-standing ones, worsening every month they stay.
--
-- credit_invoice() (0029) is not an alternative reset: it tops up lead_balance
-- and writes a payments row, and deliberately touches no counter.
--
-- WHY IT MATTERS NOW
-- ------------------
-- No renewal has happened yet — the product is roughly five weeks old and every
-- subscriber is still inside their first cycle, which is why all 19 balances
-- read zero. The first renewal lands on the earliest anchor day, at which point
-- credit refills and routing has real choices to make for the first time. The
-- corrupted pacing starts biting on that day, not before.
--
-- THE FIX
-- -------
-- Schedule only. The function is already correct, already anchor-aware, and
-- already idempotent — a customer whose anchor day is not today matches no
-- rows, and one whose counter is already 0 is set to 0 again. Running it daily
-- is what its WHERE clause has always assumed.
--
-- 00:05 is kept: it is before the 09:00 Monday syncs, so a customer's counter is
-- reset before the day's leads are routed rather than after.
--
-- NOT BACKFILLED. Existing inflated counters are left alone deliberately —
-- zeroing them all would hand every customer an identical maximum deficit and
-- make the next few days of routing a scramble. Each customer's counter
-- corrects itself on their own next anchor day, which is within a month for
-- everyone, and until then the ordering is no worse than it already is.
-- ============================================================================

select cron.unschedule('reset-monthly-lead-counts')
where exists (
  select 1 from cron.job where jobname = 'reset-monthly-lead-counts'
);

select cron.schedule(
  'reset-monthly-lead-counts',
  '5 0 * * *',
  $$ select public.reset_monthly_counts(); $$
);
