-- ---------------------------------------------------------------------------
-- 0134 — "What kind of leads", cached (§47)
--
-- ADDITIVE AND INERT. One nullable column, arriving NULL on every row, and
-- nothing reads it until the code ships. Nothing here touches a balance,
-- counter, pacing or capacity column, so a lagging migration cannot affect
-- lead allocation.
--
-- WHAT THIS IS FOR. The Monday enquiries board (18420649520) carries a text
-- column `text_mm6c5qba`, "What kind of leads". It has always been empty,
-- because nothing in the product ever asked: /enquiry derived the product
-- solely from a hidden ?product=guaranteed-rent in the URL, so anyone reaching
-- the form directly was silently filed as Management, and the answer was used
-- only to pick which BOARD the item went to — never recorded on the item.
--
-- ⚠️ THIS IS A CACHE, NOT A FACT — exactly the §23.4 semantics of
-- monday_status_label, which it sits beside. It is "the value WE last wrote to
-- that cell", never what the board currently says. Nothing reads it to decide
-- business state; mondayLeadInterestFor() is a pure function of the product
-- columns and is the only thing that decides the value.
--
-- ⚠️ AND IT NEEDS TO EXIST SEPARATELY FROM monday_status_label, which is the
-- whole reason for this migration. A customer holding management who then also
-- buys GR keeps the label `Management Customer` (management wins, label rule
-- 4), so syncCustomerMondayStatus's unchanged-label fast path returns before
-- touching Monday — and the cell would never flip to "Both". A second cache is
-- what makes that transition visible.
--
-- NULL means two different things, and both are correct: "we have never
-- written that cell" (every row, today) and "we have nothing to say about this
-- customer". mondayLeadInterestFor returns null for anybody holding neither
-- product, which the sync reads as LEAVE THE CELL ALONE — so a prospect's
-- stated interest survives until they buy something, and a customer who
-- cancels keeps the record of what they held. The column is never blanked.
-- ---------------------------------------------------------------------------

alter table public.customers
  add column if not exists monday_lead_interest text;

-- ⚠️ THE VALUE LIST MUST MATCH `LEAD_INTEREST` IN src/lib/monday.ts EXACTLY,
-- including the casing. It is a TEXT column on Monday's side, so Monday
-- enforces nothing and that constant is the only thing keeping the form, the
-- enquiry route, the status sync and the backfill writing one set of strings —
-- which is also what makes the column groupable on the board. The equality is
-- asserted mechanically in a unit test, the cancelOptions.ts precedent (§29),
-- because a drift here fails only the CACHE update: the cell would still be
-- written, and then rewritten on every subsequent event, for ever and in
-- silence.
--
-- Casing follows the board's own vocabulary: ENQUIRY_STATUS already spells it
-- "Guaranteed rent customer" with a lower-case r.
alter table public.customers
  drop constraint if exists customers_monday_lead_interest_valid;
alter table public.customers
  add constraint customers_monday_lead_interest_valid
  check (
    monday_lead_interest is null
    or monday_lead_interest in ('Management', 'Guaranteed rent', 'Both')
  );

comment on column public.customers.monday_lead_interest is
  'CACHE of the last value written to the Monday enquiries board column text_mm6c5qba '
  '("What kind of leads") — never what the board currently says, and never read to decide '
  'business state. Mirrors monday_status_label (§23.4). NULL = we have never written that cell, '
  'or we have nothing to say; the sync then leaves the cell alone rather than blanking it.';
