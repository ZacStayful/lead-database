/**
 * Rendering an error for a log line, so the line says something.
 *
 * ⚠️ WHY THIS EXISTS, WHICH IS NOT THE OBVIOUS REASON. Production carried
 *
 *     [prospect-nudges] cap read failed { message: '' }
 *
 * seven times. The instinct is "the error is not being serialised" — but it
 * was: the object genuinely held nothing but an empty string, and a better
 * serialiser would have printed the same nothing.
 *
 * The cause is a `head: true` count. postgrest-js builds a failed response's
 * error from the response BODY:
 *
 *     const body = await res.text()
 *     try   { error = JSON.parse(body) }
 *     catch { error = { message: body } }
 *
 * and `head: true` issues an HTTP HEAD, whose response carries **no body by
 * specification**. So `body` is `""`, the parse throws, and the error is
 * `{ message: "" }` — every time, for every failed head count, whatever went
 * wrong. The one fact that survives is the HTTP status, and it sits on the
 * response object next to `error`, unread, because the call site destructures
 * `{ count, error }` and stops there.
 *
 * Hence the `status` parameter. On a head count it is the ONLY diagnostic
 * there is: 5xx is the gateway (the ~2.5 hour Supabase outage on 2026-09-22
 * aborted 102 cron runs across four jobs this way), 401/403 is the key, 404 is
 * the table. Pass it wherever the query is `head: true`.
 *
 * Pure and dependency-free, so it is unit-tested rather than read off a
 * production log during an incident.
 */

/** The shape supabase-js hands back; every field is optional in practice. */
interface ErrorLike {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  name?: unknown;
}

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * A single-line description of `error`, never empty.
 *
 * `status` is the HTTP status from the same response — pass it for any
 * `head: true` count, where it is the only thing that survives.
 */
export function describeError(error: unknown, status?: number): string {
  const http =
    typeof status === "number" && status > 0 ? `HTTP ${status}` : null;

  if (error == null) {
    return http ? `no error reported (${http})` : "no error reported";
  }

  if (typeof error === "string") {
    return text(error) ?? emptyMessage(http);
  }

  if (error instanceof Error) {
    const name = text(error.name) ?? "Error";
    const msg = text(error.message);
    return join([msg ? `${name}: ${msg}` : name, http]);
  }

  if (typeof error !== "object") {
    return join([String(error), http]);
  }

  const e = error as ErrorLike;
  const message = text(e.message);
  const code = text(e.code);
  const details = text(e.details);
  const hint = text(e.hint);

  // The head-count case: nothing but an empty message, and possibly a status.
  if (!message && !code && !details && !hint) {
    return emptyMessage(http);
  }

  return join([
    code && message ? `${code}: ${message}` : (message ?? code),
    details,
    hint ? `hint: ${hint}` : null,
    http,
  ]);
}

/**
 * ⚠️ Says WHY it is empty rather than printing nothing. An unexplained blank
 * is what sent someone reading postgrest-js's source to find out; the next
 * person should be told in the log line instead.
 */
function emptyMessage(http: string | null): string {
  const why =
    "empty error — a head:true count whose failed response carried no body for postgrest-js to read a reason from";
  return http ? `${http} (${why})` : why;
}

function join(parts: Array<string | null | undefined>): string {
  const kept = parts.filter((p): p is string => !!p && p.trim() !== "");
  return kept.length > 0 ? kept.join(" · ") : "unreadable error";
}
