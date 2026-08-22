# Public API & MCP — Phase 1 spec

**Read-only.** Per-customer API keys, a versioned REST surface at `/api/v1`, and a
remote MCP server that wraps it. No writes, no billing, no admin, nothing that
spends a credit.

Written against `origin/main` at migration 0093. Numbered sections are referenced
from the code comments the implementation should carry.

---

## 0. Why this phase is cheap, and where the risk actually is

Invariant 7 already holds: every privileged write goes through a server route on
the service role, and RLS grants `authenticated` **select only** — `customers`
(`0001_init.sql:216`), `leads` (`0014_bugfixes.sql:15`), `lead_assignments`
(`0001_init.sql:227`), `lead_notes` (`0009:28`), `lead_files` (`0011:31`). There is
no browser-facing write policy anywhere. So the API is a second front door onto
rooms that already have one door and a lock.

Two findings that shape the phase:

**The dashboard's reads are not in routes.** `/dashboard/leads/page.tsx` queries
`lead_assignments` with `select("*, lead:leads(*)")` inline in a server component,
as do the other dashboard pages. There is nothing to refactor for a read-only
phase — Phase 1 is almost entirely **net-new code alongside** the existing app,
and cannot regress it. The service-layer extraction that Phase 2 needs (so the
rejected-lead guard in `PATCH /api/customer/assignments/[id]` has one definition
rather than two) is deferred with the writes that need it.

**The risk is not auth, it is the serializer.** Auth is a solved shape and easy to
test. The failure that actually ships is `{ ...lead }` in a response body, putting
`monday_item_id`, `income_report_path` and — worst — `assignment_count` /
`max_assignments` into a public contract. §19.7 is explicit that nothing about a
lead's other holders may be exposed, to the point that those fields are absent
from the `PoolLead` type so no later change can reach for them. An API response
built by spread breaks that in one line. See §5.

---

## 1. Migration 0094

Next in sequence (89 applied today). Additive; touches no balance, counter,
pacing or capacity column.

### 1.1 `customer_api_keys`

```sql
create table if not exists public.customer_api_keys (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete cascade,
  name         text not null,
  key_prefix   text not null unique,
  key_hash     text not null,
  scopes       text[] not null default '{profile:read,leads:read}',
  created_at   timestamptz not null default now(),
  created_by   uuid,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  constraint customer_api_keys_name_len   check (char_length(name) between 1 and 60),
  constraint customer_api_keys_scopes_len check (cardinality(scopes) > 0),
  constraint customer_api_keys_scopes_known check (
    scopes <@ array['profile:read','leads:read']::text[]
  )
);

create index if not exists customer_api_keys_customer_idx
  on public.customer_api_keys (customer_id) where revoked_at is null;

alter table public.customer_api_keys enable row level security;
```

**RLS on, no policies — deny-all to the browser.** The precedent is
`subscription_pauses`, `operator_proof_snapshots` and `subscription_plan_changes`
(§24). Here it is stronger than convention: `key_hash` must be unreachable from
the browser *even by the key's owner*, and `getCurrentCustomer()` reads
`customers` on the service role with `select("*")`, so nothing about the
dashboard needs a policy to work.

**The scope CHECK is deliberate and Phase 2 will alter it.** A typo'd scope fails
closed, which is safe but silent — the customer gets 403s from a key that looks
correct in the UI. Rejecting it at creation makes the mistake loud. The §6A
argument for keeping a vocabulary in the application rather than a CHECK does not
apply: that column already held rows spanning both products' stages, and this
table starts empty.

**Revocation is a stamp, never a delete.** A hard delete takes `last_used_at` and
the prefix with it, which is precisely the evidence wanted after a key leaks.

### 1.2 `api_rate_limits` and `consume_api_rate_limit()`

```sql
create table if not exists public.api_rate_limits (
  key_id        uuid not null references public.customer_api_keys(id) on delete cascade,
  window_start  timestamptz not null,
  request_count integer not null default 0,
  primary key (key_id, window_start)
);

alter table public.api_rate_limits enable row level security;
```

The only throttle in the repo today is `lastRequestByEmail` in
`/api/auth/forgot-password`, an in-memory `Map` its own comment calls best-effort
because it lives in one serverless instance. That is an accepted limit for an
endpoint that only ever emails an existing account. It is not adequate for a
public API, where per-instance memory means the effective limit is the real limit
times the number of warm lambdas.

```sql
create or replace function public.consume_api_rate_limit(
  p_key_id uuid, p_limit integer, p_window_seconds integer
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_window timestamptz; v_count integer;
begin
  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  insert into public.api_rate_limits (key_id, window_start, request_count)
  values (p_key_id, v_window, 1)
  on conflict (key_id, window_start)
    do update set request_count = api_rate_limits.request_count + 1
  returning request_count into v_count;
  return v_count;
end $$;

revoke all on function public.consume_api_rate_limit(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(uuid, integer, integer) to service_role;
```

**Increment then compare, never check then increment.** The same claim-by-write
discipline `credit_invoice()` uses against Stripe redelivery and
`announcement_deliveries` uses against a double-clicked send (§22.2): checking
first leaves a window two concurrent requests both pass through.

Note the explicit `revoke` before the `grant`. §11 records that `0028`'s
schema-wide revoke was silently undone by a later `create or replace`, because
recreating a function discards its ACL. Any future edit to this function must
re-assert both lines.

Old windows are swept in `/api/cron/sweep-lead-pool` (`delete from
api_rate_limits where window_start < now() - interval '1 day'`) — an existing
daily job, rather than a new cron for one statement.

---

## 2. Key format

```
sfl_live_<8 chars prefix><40 chars secret>
```

Both segments base62 from `crypto.randomBytes`. Stored: `key_prefix =
'sfl_live_' + first 8` (the lookup handle, not a credential) and `key_hash =
sha256(full key)` as hex.

**SHA-256, not bcrypt or argon2.** The secret is 40 characters of CSPRNG output,
not a human-chosen password, so there is no dictionary to run and the hash is not
the weak link. The lookup happens on *every request*, so a deliberately slow KDF
would add its cost to every call. This is what Stripe and GitHub do with keys of
this shape, and a reviewer will ask, so the reasoning belongs in the code comment.

Compare with `crypto.timingSafeEqual` over the hex digests, after confirming
equal length.

**Shown once, at creation, and never recoverable.** The create response is the
only time the full key exists outside the caller's hands. The UI must say so
before the key is generated, not after.

---

## 3. The auth resolver

`src/lib/api/caller.ts` — one function, both doors.

```ts
export type CallerVia = "session" | "api_key";

export interface Caller {
  customerId: string;
  customer: Customer;
  via: CallerVia;
  scopes: readonly string[];
  keyId: string | null;   // null for a session caller
}

export async function resolveCaller(
  request: NextRequest
): Promise<
  | { ok: true; caller: Caller }
  | { ok: false; status: number; code: ApiErrorCode; message: string }
>;
```

Order of resolution:

1. `Authorization: Bearer sfl_...` present → resolve the key. Any failure here is
   terminal; it must **not** fall through to the session.
2. Otherwise → cookie session, via the existing `getCurrentCustomer()`.
3. Neither → 401.

**An explicit credential must never be silently ignored in favour of an ambient
one.** A customer testing a key from a logged-in browser has to see the key's
result. Falling back would show them their session's data and let a revoked or
under-scoped key look like it works.

Key resolution, in order: parse the prefix → look up by `key_prefix` (unique
index) → reject if `revoked_at is not null` → `timingSafeEqual` the hash → load
the customer → reject if `is_active = false` → `consume_api_rate_limit`.

The `is_active` check is not decoration. §18D: an archived duplicate row keeps its
history and leaves circulation, and both candidate functions already require
`is_active = true`. A key minted against a row that is later archived must stop
working.

Session callers receive every Phase 1 scope implicitly — they are the owner,
holding the owner's cookie, and the dashboard can then be pointed at `/v1` later
with no auth work.

`last_used_at` is written at most once per key per 5 minutes (`update ... where
last_used_at is null or last_used_at < now() - interval '5 minutes'`). Stamping it
on every request turns a read endpoint into a write endpoint at full request
volume, for a field nothing reads in real time.

---

## 4. Endpoints

All under `/api/v1`, all `runtime = "nodejs"`, `dynamic = "force-dynamic"`.

| Method | Path | Scope |
|---|---|---|
| GET | `/v1/me` | `profile:read` |
| GET | `/v1/leads` | `leads:read` |
| GET | `/v1/leads/{assignment_id}` | `leads:read` |
| GET | `/v1/leads/{assignment_id}/notes` | `leads:read` |
| GET | `/v1/leads/{assignment_id}/report` | `leads:read` |

### 4.1 Identifiers: assignment id, everywhere

The existing routes are inconsistent — `/api/leads/[id]/reject`, `/discard`,
`/close` and `/report` all take a **lead** id, while
`/api/customer/assignments/[id]` and `/api/customer/events` take an **assignment**
id. `/v1` uses the assignment id throughout, without exception.

The assignment *is* the customer's relationship to the lead: one lead reaches up
to three operators, each with independent `status`, `pipeline_stage`,
`income_estimate` and notes, and §6A turns on exactly that separation ("the same
lead may sit with another operator as a separate row with its own status"). An API
keyed on lead id would have to answer "whose status?" on every response.

The lead's own id is still returned, as `lead.id`, for correlation across
endpoints.

### 4.2 `GET /v1/me`

```json
{
  "customer": {
    "id": "uuid",
    "business_name": "…",
    "contact_name": "…",
    "email": "…"
  },
  "products": [
    {
      "product": "management",
      "status": "active",
      "paused": false,
      "monthly_allocation": 10,
      "lead_balance": 4,
      "leads_received_this_month": 6,
      "pool_debit": 0,
      "pacing": { "expected": 6, "received": 6, "deficit": 0, "status": "on_track" },
      "filter": { "status": "off", "areas": [], "min_bedrooms": null, "max_bedrooms": null }
    }
  ]
}
```

`products` contains only products actually held, decided by `holdsProduct()` —
per product, reading only that product's columns (invariant 6). `paused` appears
on the management block **only**; there is no GR pause, and emitting `"paused":
false` on a GR block would imply one exists.

`pacing` comes from the existing `computePacing` / `computeGrPacing`, which
already subtract `pool_debit` via `effectiveAllocation`. `pool_debit` is returned
alongside because §19.5 already puts it in front of the customer on their
dashboard, and without it a debited customer's deficit is unexplainable.

**Withheld:** every Stripe id, `cancellation_feedback` / `cancellation_comment`,
all `monday_*` columns, `presentation_settings`, `management_lifetime_leads_received`,
`notification_preferences`, `pause_count`, `cancel_at_period_end`. None is
useful to a workflow and several are internal sales state.

### 4.3 `GET /v1/leads`

Query: `product`, `status`, `pipeline_stage`, `updated_since` (ISO 8601, filters
on `last_status_change_at`), `limit` (default 25, max 100), `cursor`.

```json
{ "data": [ /* §5 objects */ ], "next_cursor": "…" | null }
```

**Cursor pagination, not offset.** Ordering is `assigned_at desc, id desc`; the
cursor is base64 of `<assigned_at>|<id>` and the next page filters strictly below
it. Offset paging over a table that takes inserts from the daily sync mid-walk
returns duplicates and skips rows, and an LLM agent walking pages is exactly the
client that would silently act on the gap.

`assigned_at` alone is not unique — a bulk assign stamps several rows in the same
transaction — hence the id tiebreak in both the sort and the cursor.

### 4.4 `GET /v1/leads/{assignment_id}/report`

Returns JSON, not a 302:

```json
{ "url": "https://…", "expires_at": "2026-08-21T12:01:00Z", "size_bytes": 284119 }
```

A signed URL as JSON is what an MCP client or an n8n HTTP node can actually use;
a redirect to a binary makes both of them do the wrong thing by default. The
signing itself reuses `/api/leads/[id]/report`'s logic and its 60-second window.

Authorisation is the **assignment** predicate only. The existing route also
admits a pool viewer via `customer_can_see_pool_lead` (§25), and `/v1` deliberately
does not — see §7.

`404` when no report is stored, with the same body as "not yours", per §7.

---

## 5. The serializer is an allow-list

`src/lib/api/serialize.ts`. One function per resource, **explicit field
assignments, never a spread of a database row**. A new column added to `leads` by
a future migration must be invisible to the API until somebody names it here.

```json
{
  "id": "assignment uuid",
  "status": "contacted",
  "pipeline_stage": "web_meeting_booked",
  "source": "allocated",
  "assigned_at": "…",
  "viewed_at": "…",
  "first_contacted_at": "…",
  "last_status_change_at": "…",
  "due_to_call_date": null,
  "income_estimate": null,
  "price_paid": 15.0,
  "closed_at": null,
  "closed_reason": null,
  "lead": {
    "id": "lead uuid",
    "lead_type": "management",
    "lead_name": "…",
    "address": "…",
    "postcode": "…",
    "postcode_area": "…",
    "bedrooms": "3",
    "phone": "…",
    "email": "…",
    "lead_profile": "…",
    "created_at": "…",
    "gross_annual_income": 36112,
    "avg_nightly_rate": 157,
    "occupancy_rate": 63,
    "income_report_available": true
  }
}
```

`source` is `"allocated"` or `"pool_claim"`, derived from `claimed_from_pool_at`
— the same distinction and the same wording as the XLSX export's Source column
(§19.9). `income_report_available` is derived from `income_report_path != null`;
the path itself never leaves the server.

### 5.1 Withheld, and why each one

| Field | Reason |
|---|---|
| `assignment_count`, `max_assignments` | **The important one.** Together they tell an operator how many competitors hold this lead. §19.7 keeps this out of the pool view entirely — not hidden in the UI, absent from the type — because "three operators passed on this" is an argument against ringing. An API must hold the same line. |
| `monday_item_id` | Internal provenance; also the ingest idempotency key. |
| `income_report_path`, `income_report_asset_id`, `income_report_status`, `income_report_error` | Server-side only (§25). The asset id changes when sales re-run the analyser and has never been a URL. |
| `enquiry_date` | §11: free text of uneven quality that does not always parse, displayed nowhere including admin. Publishing it makes a contract out of a field we deliberately do not trust. Lead age is `assigned_at`, as everywhere else. |
| `pool_entered_at`, `pool_first_entered_at`, `pool_expired_at`, `pool_entry_basis` | Internal lifecycle. `pool_entry_basis` in particular reveals that a lead was never sold to anyone (§19.1). |
| `estimated_monthly_income` | Dead since 0001. |
| `customer_id` | Redundant — it is the caller, by construction. |
| `notification_sent`, `email_sent` | Our delivery mechanics. |
| `is_reclaimed`, `reclaimed_at` | Retired feature (§7). |
| `due_to_call_date_set_at`, `income_estimate_set_at` | Trigger-maintained internals whose nulls mean "pre-0073", not "unset" (§19.3). |

### 5.2 `gross_annual_income` must be labelled in the response, not just the docs

It is Stayful's projection from the analysis PDF, one per lead, identical for
every holder. `income_estimate` is the operator's own hand-typed figure, one per
assignment. §25 forbids merging them, summing them, or using either as a fallback
for the other — and an LLM handed two money fields with similar names will do all
three. The field descriptions in the OpenAPI document and the MCP tool schemas
(§8) are where that distinction has to be spelled out, because on this surface
they *are* the UI.

---

## 6. Errors and rate limits

```json
{ "error": { "code": "insufficient_scope", "message": "This key does not carry the leads:read scope." } }
```

| Code | Status |
|---|---|
| `unauthorized` | 401 |
| `invalid_api_key` | 401 |
| `revoked_api_key` | 401 |
| `insufficient_scope` | 403 |
| `not_found` | 404 |
| `invalid_request` | 400 |
| `rate_limited` | 429 |

**A foreign or nonexistent assignment id both return 404, with an identical
body.** `POST /api/customer/events` already does exactly this, and its comment
gives the reason: a 403 on a real id and a 404 on a fake one turns the endpoint
into an oracle for which ids exist. The same applies to "no report stored" versus
"not your lead" on `/report`.

Every response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`; a 429 also
carries `Retry-After`.

**Limits: 60 requests per minute per key, 5,000 per day per customer.** These are
stated guesses, in the sense §21 uses the phrase — nothing has been measured
because nothing exists yet. `api_rate_limits` is what will let them be checked
against real use, and they should be revisited once a handful of customers are
actually integrated. The per-minute window is the one that matters: an LLM
tool-calling loop bursts.

---

## 7. What Phase 1 deliberately does not do

- **No writes of any kind.** Notes, status, pipeline stage, close and reject are
  Phase 2, and they need the service-layer extraction first so the §6A
  rejected-lead guard has one definition rather than two.
- **No `lead_events` writes, in any phase.** That route is the trust boundary for
  engagement scoring, which decides who receives escalated leads (§3, §10); the
  table has no browser insert policy precisely so engagement cannot be
  manufactured. A key that can post `detail_opened` lets a customer script their
  way to the front of the queue for reclaimed leads. If API activity should
  count for something later, it needs its own event type that scoring ignores.
- **No pool endpoints, read or claim.** Claiming spends money and, per §19.5,
  *succeeds at zero balance* by incrementing `pool_debit` — an agent looping the
  pool is a £15-a-time hazard with no balance gate to stop it. Listing is subtler:
  §19.7's bargain is that calling is free because a human has to make the call,
  and a machine-readable pool with contact details makes bulk-ringing every
  pooled landlord trivial. Both belong in a decision of their own, not in the
  phase that opens the door. Adding a read-only `/v1/pool` later is one endpoint
  over the existing `get_customer_pool_leads`.
- **No billing.** Subscribe, pause, plan change and top-up stay session-only.
- **No admin surface.** No key may reach an `/api/admin` route.
- **No changes to any existing route.** Phase 1 is additive; the dashboard's
  behaviour is untouched.

---

## 8. The MCP server

`/api/mcp`, streamable HTTP transport, on the same Vercel deployment — a customer
adds a URL and a key, with nothing to install. Auth is the same
`Authorization: Bearer sfl_...` header through the same `resolveCaller`.

Tools, one per endpoint: `get_account`, `list_leads`, `get_lead`,
`list_lead_notes`, `get_lead_report_url`.

**The MCP tools call the service functions in-process.** Not HTTP to our own
`/v1`: a self-call on Vercel costs a second invocation and a possible cold start
per tool call, and loses the stack trace across the boundary. The layering is
service functions → (`/v1` route handlers | MCP tools), with the serializer shared
so the two surfaces cannot describe a lead differently.

**Tool descriptions are the product here.** They are the only context the model
gets, so each one states what the data means, not just its type: a lead is a
pre-screened landlord enquiry the customer has paid for; `status` is
self-reported and measures record-keeping, not work (the trap §10 flags for win
rate and §21 for `contacted`); `gross_annual_income` is Stayful's projection for
the property and `income_estimate` is the operator's own figure, and they are
never to be combined.

**Dependency care.** `@modelcontextprotocol/sdk` is new to this repo. `unpdf` is
pinned `~1.7.0` specifically because 1.8.0 added `engines: { node: ">=22" }` while
this project pins no Node version anywhere (§25) — check the same thing before
adding the SDK, and pin it.

---

## 9. Key management

A new **API access** panel in `/dashboard/settings`, plus three session-only
routes:

| Method | Path |
|---|---|
| GET | `/api/customer/api-keys` |
| POST | `/api/customer/api-keys` |
| DELETE | `/api/customer/api-keys/[id]` |

**Session-only, and an API key must never reach them.** A key that can mint keys
is a key that can escalate its own scopes and outlive its own revocation. These
routes call `getCurrentCustomer()` directly and never `resolveCaller`.

- `GET` returns `id`, `name`, `key_prefix`, `scopes`, `created_at`,
  `last_used_at`, `revoked_at`. Never `key_hash`.
- `POST` takes `{ name, scopes? }`, returns the full key **once**, in the only
  response that will ever contain it.
- `DELETE` stamps `revoked_at`. Never a row delete (§1.1).

Gates: the customer must hold at least one product (`holdsProduct` on either),
and at most **5** un-revoked keys may exist. Revoked keys do not count.

---

## 10. Verification

There is no test suite and no ESLint config in this repo. §23.10 and §25 both
record the same lesson from features that shipped with hand-verified happy paths:
the defects clustered on failure paths and in the seams between well-tested
pieces. A public contract is the worst place to repeat that, so this phase
introduces the repo's first tests.

Minimum set:

1. **Resolver** — valid key; revoked key; unknown prefix; correct prefix with
   wrong secret; malformed header; no credential; session fallback; **key and
   session both present** (the key must win); key on an `is_active = false`
   customer.
2. **Scopes** — every endpoint called with a key lacking its scope returns 403,
   and with the scope returns 200.
3. **Serializer** — assert the emitted object's key set **equals** the documented
   allow-list, exactly, at both levels. This is the test that matters most: it is
   the one that fails when migration 0095 adds a column to `leads`, which is the
   only way this API leaks something internal.
4. **Cursor pagination** — a page walk stays correct across an insert made
   between pages, and `assigned_at` ties break deterministically.
5. **Rate limit** — `consume_api_rate_limit` under concurrent calls never lets
   more than the limit through in one window.
6. **404 parity** — foreign id, nonexistent id and report-not-stored produce
   byte-identical bodies.
7. **Migration** — 0094 applied to a scratch Postgres 16 **from empty** (this
   makes 90), both CHECKs exercised, the unique index on `key_prefix` confirmed,
   the FK cascade confirmed on customer delete, and the migration re-applied to
   prove idempotency. The repo convention, per §22–§26.

---

## 11. Deployment order — migration BEFORE code

0094 first. The resolver selects from `customer_api_keys` on every API request
and `consume_api_rate_limit` must exist before any key is issued, so code
arriving first would 500 the whole surface.

Nothing in Phase 1 writes a balance, counter, pacing or capacity column, and no
existing route changes, so a lagging migration cannot affect lead allocation —
the failure is confined to the new endpoints returning errors to a surface no
customer holds a key for yet.

Order within the phase: migration → service layer and serializer → `/v1` routes →
key management UI → issue one key to an internal account and exercise it → MCP
server → document and announce.
