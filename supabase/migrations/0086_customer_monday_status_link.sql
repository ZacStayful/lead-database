-- ============================================================================
-- Monday customer link — write subscription status back to the sales board.
--
-- Board 18420649520 ("Stayful Lead database enquiries") carries a Status column
-- (color_mm5eda07) whose labels describe a subscriber's commercial state:
-- Management Customer, Guaranteed rent customer, Paused, Cancelled, Wants to pay
-- card declined. Until now every one of those was set BY HAND, so the board was
-- only as current as the last time somebody remembered. This is the schema half
-- of closing that loop: the Stripe events that already move a customer's status
-- in Postgres also move the label on their Monday item.
--
-- Entirely additive. Nothing here reads, writes or derives from lead_balance,
-- gr_lead_balance, monthly_allocation, leads_received_this_month, pool_debit, or
-- any billing, pacing, capacity or allocation column. The columns below are a
-- pointer and a cache; no routing, credit or eligibility decision consults them.
--
-- WHY A LINK COLUMN IS NEEDED AT ALL
-- ----------------------------------
-- There was no customer -> Monday item link anywhere. leads.monday_item_id
-- (0001) is the LEAD side; nothing pointed at the item representing the
-- CUSTOMER. /api/enquiry already creates that item and already receives its id
-- back from createEnquiryContact() — and then discarded it. Capturing it is the
-- cheap half; everything below exists for the rows that predate the capture or
-- arrived by another route (admin invite, GR Payment Link, owner bootstrap).
--
-- WHY monday_item_id IS DELIBERATELY *NOT* UNIQUE
-- -----------------------------------------------
-- leads.monday_item_id is unique because ingest's idempotency depends on it.
-- This one must not be. The link here is a best-effort match against free-text
-- board cells, and the archived-duplicate case (CLAUDE.md 18D) guarantees
-- near-collisions: measured on live data, the board carries
-- info@thehostingedit.co.uk and leslie@homelyshortstays.com, which match
-- ARCHIVED (is_active = false) rows, while the live rows for those two people
-- carry newer addresses. A unique constraint would turn that into a 23505 raised
-- inside the Stripe webhook's lazy resolution — a code path that must never fail
-- loudly, because the handler deletes its stripe_events claim on any throw and
-- Stripe would then redeliver an already-credited invoice.
--
-- monday_link_state records the collision instead of rejecting it. The real
-- protection against two customers driving one item is the label rule refusing
-- archived rows outright (src/lib/mondayStatus.ts), not a constraint here.
--
-- WHY monday_board_id EXISTS WHEN THERE IS ONLY ONE STATUS BOARD
-- -------------------------------------------------------------
-- Because two boards mint these items. GR enquiries go to board 18420913271,
-- which has NO status column at all — verified: its columns are name, date,
-- email, mobile, properties, subitems, lead source. An item created there can
-- never carry a status. Storing the board id lets the writer refuse a
-- wrong-board write ("not_status_board") instead of erroring at Monday, and
-- leaves room for a status column on that board later without a migration.
--
-- WHAT monday_status_label MEANS — READ THIS BEFORE USING IT
-- ---------------------------------------------------------
-- It is "the label WE last wrote", NOT "what the board currently says". It is
-- the idempotency key, and nothing reads it to decide business state.
--
-- That distinction is the whole design. invoice.paid fires monthly per customer,
-- so comparing against this cache is what makes a renewal cost one SELECT and
-- zero Monday HTTP. It also gives the right semantics for a shared board: we
-- write on TRANSITIONS, not continuously, so a salesperson's manual edit to the
-- Status cell survives until that customer's next genuine lifecycle change.
-- Reading the board's current label before every write would instead make our
-- write conditional on somebody else's edit, and double the round trips.
--
-- On a failed push, monday_status_label is deliberately left UNCHANGED so the
-- next event for that customer retries naturally; monday_status_error carries
-- the reason for the admin surface.
-- ============================================================================

alter table public.customers
  add column if not exists monday_item_id           text,
  add column if not exists monday_board_id          text,
  add column if not exists monday_link_state        text not null default 'unlinked',
  add column if not exists monday_link_matched_by   text,
  add column if not exists monday_status_label      text,
  add column if not exists monday_status_synced_at  timestamptz,
  add column if not exists monday_status_error      text;

comment on column public.customers.monday_item_id is
  'Item id on the Monday enquiries board representing this CUSTOMER (not a lead). Best-effort link; deliberately not unique — see 0086 header.';
comment on column public.customers.monday_board_id is
  'Board the item lives on. The GR enquiries board has no status column, so a status write against it is refused rather than attempted.';
comment on column public.customers.monday_link_state is
  'unlinked | linked | not_found | ambiguous. Records the outcome of item resolution, including collisions a unique constraint would have raised.';
comment on column public.customers.monday_link_matched_by is
  'How the link was established: created | email | phone | name | manual. Lets a low-confidence name match be told from an exact email match later.';
comment on column public.customers.monday_status_label is
  'The Status label WE last wrote to the board — the idempotency key, NOT the board''s current value. Nothing reads it to decide business state.';

-- Guard both enums in the database rather than trusting the one writer. These
-- are small closed sets and a typo in application code would otherwise persist
-- silently in a column the admin UI renders.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customers_monday_link_state_check'
  ) then
    alter table public.customers
      add constraint customers_monday_link_state_check
      check (monday_link_state in ('unlinked', 'linked', 'not_found', 'ambiguous'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'customers_monday_link_matched_by_check'
  ) then
    alter table public.customers
      add constraint customers_monday_link_matched_by_check
      check (
        monday_link_matched_by is null
        or monday_link_matched_by in ('created', 'email', 'phone', 'name', 'manual')
      );
  end if;
end $$;

-- Partial: the unlinked rows are the majority at apply time and never looked up
-- by item id. Not unique — see the header.
create index if not exists customers_monday_item_id_idx
  on public.customers (monday_item_id)
  where monday_item_id is not null;
