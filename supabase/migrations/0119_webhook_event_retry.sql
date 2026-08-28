-- ---------------------------------------------------------------------------
-- 0119 — Make an unverified webhook event recoverable (§40.8)
--
-- ADDITIVE AND INERT. Two columns and one index. Nothing reads either until the
-- recovery pass ships, and nothing here touches a balance, counter, pacing or
-- capacity column, so a lagging deploy cannot affect lead allocation.
--
-- WHY. TimelinesAI cannot sign a webhook, so the receiver's decisive defence is
-- a read-back against that customer's own token — and it gets three seconds,
-- because the vendor wants a 2xx within five. When that call does not finish in
-- time the row is written `verified = false` with its payload and NOTHING EVER
-- LOOKS AT IT AGAIN. A landlord's reply that arrived during a slow minute at the
-- vendor simply never appears, and it looks exactly like a landlord who never
-- replied — which is why nobody would ever report it.
--
-- ⚠️ THE VENDOR'S OWN RETRIES CANNOT SAVE IT. It retries twice, but our claim
-- row already exists, so each retry short-circuits on 23505 and does nothing.
-- Claiming BEFORE verifying is correct — it is what stops double-processing —
-- but it makes recovery ours alone.
--
-- 0116 already created a partial index for exactly this pass and the pass was
-- never written. This re-points that index at the due-time the pass reads.
-- ---------------------------------------------------------------------------

-- ⚠️ WITHOUT THIS THE PASS CANNOT RUN AT ALL. The claim id is
-- `timelines:<event_type>:<uid>` and carries no tenant, the payload has no
-- reliable customer field, and the read-back needs THAT customer's own token —
-- so an event nobody can attribute is an event nobody can retry. The receiver
-- knows the customer (it resolved them from the path token) and simply never
-- wrote it down.
--
-- Nullable, because every existing row predates it. Those rows are not
-- retryable for other reasons anyway (see the note at the foot of this file).
alter table public.message_webhook_events
  add column if not exists customer_id uuid references public.customers(id) on delete cascade;

alter table public.message_webhook_events
  add column if not exists attempts integer not null default 0;

-- Null means "not scheduled": either already verified, or abandoned after the
-- 24-hour window. The recovery pass selects on `is not null` and `<= now()`, so
-- nulling a row is how it is retired without deleting the evidence that it
-- arrived at all.
alter table public.message_webhook_events
  add column if not exists next_attempt_at timestamptz;

comment on column public.message_webhook_events.attempts is
  'Read-back attempts made. Drives the recovery backoff (1m, 5m, 15m, 1h); the pass gives up 24h '
  'after received_at and nulls next_attempt_at rather than deleting the row.';
comment on column public.message_webhook_events.next_attempt_at is
  'When the recovery pass may try this event again. Null = not scheduled (verified, or abandoned).';

-- 0116 indexed (received_at) where verified = false, anticipating this pass.
-- The pass orders by due-time, not arrival, so the index follows it.
drop index if exists public.message_webhook_events_pending_idx;
create index if not exists message_webhook_events_pending_idx
  on public.message_webhook_events (next_attempt_at)
  where verified = false and next_attempt_at is not null and customer_id is not null;

-- ---------------------------------------------------------------------------
-- No backfill, deliberately.
--
-- Every row present at apply time predates payload storage: the receiver used
-- to keep the body only on the deferred path, and `verified` was NOT NULL
-- DEFAULT true with only that path ever writing it — so every existing row
-- reads `verified = true` whatever actually happened to it. There is nothing to
-- re-run them from, and the partial index excludes them by construction.
--
-- Leaving next_attempt_at null on existing rows is therefore correct rather
-- than an omission: it says "not scheduled", which is the truth.
-- ---------------------------------------------------------------------------
