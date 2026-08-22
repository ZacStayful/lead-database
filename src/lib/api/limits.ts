/**
 * Tunables for the public API.
 *
 * THESE NUMBERS ARE STATED GUESSES, in the sense §21 uses the phrase for the
 * return-likelihood bands: nothing has been measured because nothing existed to
 * measure. `api_rate_limits` and `api_request_log` are what will let them be
 * checked against real use, and they should be revisited once a handful of
 * customers are genuinely integrated.
 *
 * The per-minute window is the one that matters. An LLM tool-calling loop
 * bursts — a model working through twenty leads makes twenty calls in a few
 * seconds — so a daily cap alone would let a runaway integration exhaust a
 * customer's whole allowance before anybody noticed.
 */

/** Per key, per rolling minute window. */
export const RATE_LIMIT_PER_MINUTE = 60;
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** Per CUSTOMER, per day — so five keys cannot multiply the ceiling. */
export const RATE_LIMIT_PER_DAY = 5000;
export const RATE_LIMIT_DAY_SECONDS = 86_400;

/**
 * How stale `last_used_at` is allowed to be.
 *
 * Stamping it on every request would turn a read endpoint into a write endpoint
 * at full request volume, for a field nothing reads in real time. Five minutes
 * is far finer than the "have I ever used this key, and roughly when" question
 * the settings panel asks of it.
 */
export const LAST_USED_COALESCE_MINUTES = 5;

/**
 * How long the `api_enabled` kill switch is cached in process.
 *
 * The switch exists for the 2am case — a leaked key, a looping integration — so
 * it has to take effect without a deploy, but it does not have to take effect
 * instantly. Thirty seconds of lag buys us not reading `system_settings` on
 * every single request. On a cold lambda this degrades to one small indexed
 * read per request, which is the acceptable worst case.
 */
export const KILL_SWITCH_CACHE_MS = 30_000;

/** Most keys a customer may hold at once, un-revoked. */
export const MAX_KEYS_PER_CUSTOMER = 5;

/** Page size for /v1/leads. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Hard ceiling on the notes endpoint, which is otherwise unbounded. */
export const MAX_NOTES = 200;

/**
 * Lifetime of the internally-minted signed URL for a stored analysis PDF.
 *
 * Sixty seconds, matching /api/leads/[id]/report — and it never leaves this
 * process. The API streams the bytes rather than handing the URL out, so the
 * window only has to cover our own server-side fetch. See service/report.ts for
 * why the URL itself must not be returned.
 */
export const REPORT_SIGNED_URL_TTL_SECONDS = 60;
