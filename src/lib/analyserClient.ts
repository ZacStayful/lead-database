/**
 * Talking to the Stayful property analyser.
 *
 * One property in, figures and a PDF out, over `POST /api/internal/analyse` on
 * the analyser app, authenticated with a shared secret header.
 *
 * NEVER THROWS. Every failure comes back as a variant of `AnalyserOutcome`, for
 * the reason the analyser's own pipeline gives for the same rule: one bad
 * property must not be able to take down a batch that has already been paid
 * for. The caller decides what a given variant costs a row.
 *
 * We deliberately send NO landlord details — no name, no email, no phone. Only
 * the property. That is a privacy decision, and it is also the mechanism that
 * guarantees nothing reaches Monday.com: the analyser's own side-effect step
 * returns early when it has no email, phone or Monday item id to work from, so
 * an owned lead cannot leak onto the leads board even by accident.
 */

import type { AnalyserSuccess } from "./leadAnalysis";

/** Where the analyser lives, and the secret it expects. */
function config(): { url: string; secret: string } | null {
  const base = process.env.ANALYSER_API_URL?.trim();
  const secret = process.env.ANALYSER_INTERNAL_SECRET?.trim();
  if (!base || !secret) return null;
  return { url: `${base.replace(/\/+$/, "")}/api/internal/analyse`, secret };
}

/**
 * A row is 20-30s typically and around 70s at worst — the revenue API alone
 * polls for up to 25s, and a PDF is rendered afterwards. 90s leaves headroom
 * without letting a hung request eat the worker's whole budget.
 */
const DEFAULT_TIMEOUT_MS = 90_000;

export type AnalyserOutcome =
  /** A completed run. `payload.quality_ok` may still be false. */
  | { kind: "ok"; payload: AnalyserSuccess; pdfBytes: Uint8Array | null }
  /**
   * This property cannot be analysed and will not be next time either — a
   * postcode that does not geocode, an input the validator rejects. Terminal.
   */
  | { kind: "row_failed"; errorCode: string; message: string }
  /** A transient fault. Worth another attempt, and worth burning one on. */
  | { kind: "retryable"; errorCode: string; message: string }
  /**
   * Our fault, not the property's: no secret, the wrong secret, or the
   * analyser telling us to slow down. The row must NOT burn an attempt for
   * this — it never got a chance — and the run should stop rather than march
   * the rest of a paid batch into the same wall.
   */
  | { kind: "blocked"; errorCode: string; message: string };

export interface AnalyseRequest {
  requestId: string;
  address: string;
  postcode: string;
  bedrooms: number;
}

export async function runLeadAnalysis(
  req: AnalyseRequest,
  opts: { timeoutMs?: number } = {}
): Promise<AnalyserOutcome> {
  const cfg = config();
  if (!cfg) {
    return {
      kind: "blocked",
      errorCode: "not_configured",
      message:
        "ANALYSER_API_URL or ANALYSER_INTERNAL_SECRET is unset — the analyser cannot be reached.",
    };
  }

  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": cfg.secret,
      },
      body: JSON.stringify({
        request_id: req.requestId,
        address: req.address,
        postcode: req.postcode,
        bedrooms: req.bedrooms,
        include_pdf: true,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout is genuinely ambiguous: the analyser may well have completed
    // the run (and paid for the report) after we stopped listening. Retryable
    // rather than terminal, and the analyser's own 24-hour report cache means a
    // retry for the same postcode and bedroom count does not buy it twice.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      kind: "retryable",
      errorCode: timedOut ? "timeout" : "network",
      message: err instanceof Error ? err.message : "Could not reach the analyser",
    };
  }

  if (res.status === 401 || res.status === 404) {
    // 404 is the analyser's fail-closed state when its own secret is unset —
    // not a missing route. Either way this is a deployment problem and no
    // number of retries fixes it.
    return {
      kind: "blocked",
      errorCode: res.status === 401 ? "unauthorized" : "endpoint_disabled",
      message: `Analyser refused the request (HTTP ${res.status}). Check ANALYSER_INTERNAL_SECRET on both apps.`,
    };
  }

  if (res.status === 429) {
    return { kind: "blocked", errorCode: "busy", message: "Analyser is at capacity." };
  }

  if (res.status === 400) {
    const body = await safeJson(res);
    return {
      kind: "row_failed",
      errorCode: "invalid_input",
      // The analyser returns its validator's wording verbatim, which is written
      // to be shown to a customer.
      message: String(body?.error ?? "The analyser rejected this property"),
    };
  }

  if (!res.ok) {
    return {
      kind: "retryable",
      errorCode: `http_${res.status}`,
      message: `Analyser returned HTTP ${res.status}`,
    };
  }

  const body = await safeJson(res);
  if (!body) {
    return { kind: "retryable", errorCode: "bad_json", message: "Analyser sent unreadable JSON" };
  }

  if (body.ok === false) {
    // runAnalysis() does not throw — a dead property is a 200 saying so.
    return {
      kind: "row_failed",
      errorCode: String(body.error_code ?? "analysis_failed"),
      message: String(body.error ?? "The analyser could not price this property"),
    };
  }

  const pdf = body.pdf as { base64?: unknown; bytes?: unknown } | null | undefined;
  return {
    kind: "ok",
    // Nothing downstream trusts this shape: buildOutcomeFromAnalyserResponse
    // re-checks every figure against the constraints they are about to meet.
    payload: body as unknown as AnalyserSuccess,
    pdfBytes: decodePdf(pdf?.base64, pdf?.bytes),
  };
}

/**
 * base64 → bytes, refusing anything that does not survive the trip.
 *
 * This is the seam, and it is the shape that fails quietly: a truncated or
 * mangled payload decodes to *something*, and a something-shaped file is
 * exactly what gets stored as a report an operator can open. The declared
 * length is checked against the decoded length, and the result must still
 * begin `%PDF-`.
 */
function decodePdf(base64: unknown, declaredBytes: unknown): Uint8Array | null {
  if (typeof base64 !== "string" || !base64) return null;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(base64, "base64"));
  } catch {
    return null;
  }
  if (bytes.byteLength === 0) return null;
  if (typeof declaredBytes === "number" && declaredBytes !== bytes.byteLength) {
    console.error("analyserClient: PDF length mismatch", {
      declared: declaredBytes,
      decoded: bytes.byteLength,
    });
    return null;
  }
  const magic = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
  if (magic !== "%PDF-") {
    console.error("analyserClient: decoded document is not a PDF", { magic });
    return null;
  }
  return bytes;
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
