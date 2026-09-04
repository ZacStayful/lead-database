/**
 * The error envelope for /api/v1 and the MCP server.
 *
 * DELIBERATELY DIFFERENT FROM THE REST OF THE APP. Every other route in this
 * codebase answers `{ error: "some sentence" }`, which is right for a fetch()
 * in our own dashboard that renders the string. A machine client needs
 * something to branch on that survives a copy edit, so these responses carry
 * `{ error: { code, message } }` and the code is the contract.
 */
export type ApiErrorCode =
  | "unauthorized"
  | "invalid_api_key"
  | "revoked_api_key"
  | "expired_api_key"
  // The OAuth trio. NOT a reuse of the api_key codes above, deliberately: their
  // messages say "API key", and an OAuth caller has never had one. Telling
  // somebody to check a credential that does not exist for them sends them
  // looking in the wrong place — and these are also what let the WWW-Authenticate
  // builder pick `error="invalid_token"`, which is the parameter a client acts on.
  | "invalid_token"
  | "revoked_token"
  | "expired_token"
  | "insufficient_scope"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "service_unavailable"
  | "internal_error";

export const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  invalid_api_key: 401,
  revoked_api_key: 401,
  expired_api_key: 401,
  invalid_token: 401,
  revoked_token: 401,
  expired_token: 401,
  insufficient_scope: 403,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  service_unavailable: 503,
  internal_error: 500,
};

export interface ApiFailure {
  ok: false;
  code: ApiErrorCode;
  message: string;
}

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

export function fail(code: ApiErrorCode, message: string): ApiFailure {
  return { ok: false, code, message };
}

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

/**
 * The ONE message a caller ever sees for a database or infrastructure failure.
 *
 * A Supabase error's `.message` names the table and the column it failed on —
 * `new row for relation "lead_assignments" violates check constraint ...` — so
 * passing one through publishes schema detail to anybody who can provoke it.
 * Several existing routes in this codebase do exactly that (see
 * /api/customer/settings), which is defensible for a same-origin dashboard and
 * is not defensible here.
 *
 * This looks like a downgrade in debuggability and is not: the detail is logged
 * server-side against the request id, so it is one lookup away in the request
 * log or the Vercel console.
 */
export function internal(context: string, detail: unknown): ApiFailure {
  console.error(`[api] ${context}`, detail);
  return fail(
    "internal_error",
    "Something went wrong on our side. Quote the X-Request-Id header if you contact support."
  );
}

/**
 * The single "no" for anything the caller may not see.
 *
 * A lead that is not theirs, a lead that does not exist, and a lead with no
 * stored report all produce THIS EXACT VALUE. 404-vs-403 on a real id is an
 * oracle for which ids exist, and `POST /api/customer/events` already refuses
 * to leak that distinction for the same reason. Parity is a property of the
 * bytes, so there is one constructor rather than three call sites writing
 * their own sentence.
 */
export function notFound(): ApiFailure {
  return fail("not_found", "Not found.");
}
