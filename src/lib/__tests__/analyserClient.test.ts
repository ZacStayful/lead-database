import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runLeadAnalysis } from "../analyserClient";

const REQ = { requestId: "row-1", address: "12 Foo St, Bristol BS4 3AA", postcode: "BS4 3AA", bedrooms: 3 };
const PDF = Buffer.from("%PDF-1.3\nhello");

function body(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    quality_ok: true,
    quality_reason: null,
    figures: { gross_annual_income: 40000 },
    pdf: { base64: PDF.toString("base64"), bytes: PDF.byteLength },
    ...overrides,
  };
}

function respond(status: number, json: unknown) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.ANALYSER_API_URL = "https://analyser.test";
  process.env.ANALYSER_INTERNAL_SECRET = "s3cret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANALYSER_API_URL;
  delete process.env.ANALYSER_INTERNAL_SECRET;
});

describe("runLeadAnalysis: what it sends", () => {
  it("sends the property and nothing about the landlord", async () => {
    // This is not merely a privacy nicety. The analyser's side-effect step
    // returns early when it has no email, phone or Monday item id — so sending
    // none of them is what guarantees a customer's private lead can never
    // appear on the shared Monday leads board.
    let seen: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen = { url, init };
      return respond(200, body());
    });

    await runLeadAnalysis(REQ);

    expect(seen!.url).toBe("https://analyser.test/api/internal/analyse");
    expect((seen!.init.headers as Record<string, string>)["x-internal-secret"]).toBe("s3cret");
    const sent = JSON.parse(String(seen!.init.body));
    expect(sent).toEqual({
      request_id: "row-1",
      address: "12 Foo St, Bristol BS4 3AA",
      postcode: "BS4 3AA",
      bedrooms: 3,
      include_pdf: true,
    });
    for (const forbidden of ["email", "phone", "name", "monday_item_id"]) {
      expect(sent).not.toHaveProperty(forbidden);
    }
  });

  it("tolerates a trailing slash on the configured base URL", async () => {
    process.env.ANALYSER_API_URL = "https://analyser.test/";
    let url = "";
    vi.stubGlobal("fetch", async (u: string) => {
      url = u;
      return respond(200, body());
    });
    await runLeadAnalysis(REQ);
    expect(url).toBe("https://analyser.test/api/internal/analyse");
  });
});

describe("runLeadAnalysis: classifying what comes back", () => {
  it("is blocked, not failed, when it is not configured", async () => {
    delete process.env.ANALYSER_INTERNAL_SECRET;
    const out = await runLeadAnalysis(REQ);
    expect(out.kind).toBe("blocked");
    // Blocked means the row hands its attempt back: it never got a chance.
  });

  it("treats a refused secret as blocked rather than a dead property", async () => {
    for (const status of [401, 404]) {
      vi.stubGlobal("fetch", async () => respond(status, { error: "no" }));
      const out = await runLeadAnalysis(REQ);
      expect(out.kind).toBe("blocked");
    }
  });

  it("treats 429 as blocked — capacity is not the property's fault", async () => {
    vi.stubGlobal("fetch", async () => respond(429, { error_code: "busy" }));
    expect((await runLeadAnalysis(REQ)).kind).toBe("blocked");
  });

  it("treats a rejected input as terminal, and keeps the wording", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(400, { error: "A valid UK postcode is required.", error_code: "invalid_input" })
    );
    const out = await runLeadAnalysis(REQ);
    expect(out.kind).toBe("row_failed");
    if (out.kind === "row_failed") {
      expect(out.message).toBe("A valid UK postcode is required.");
    }
  });

  it("treats a 200 saying ok:false as terminal for this property", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(200, { ok: false, stage: "geocode", error_code: "geocode_failed", error: "nope" })
    );
    const out = await runLeadAnalysis(REQ);
    expect(out.kind).toBe("row_failed");
    if (out.kind === "row_failed") expect(out.errorCode).toBe("geocode_failed");
  });

  it("treats 5xx and network trouble as retryable", async () => {
    vi.stubGlobal("fetch", async () => respond(503, {}));
    expect((await runLeadAnalysis(REQ)).kind).toBe("retryable");

    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    expect((await runLeadAnalysis(REQ)).kind).toBe("retryable");
  });

  it("treats a timeout as retryable, not as a failure", async () => {
    // The analyser may well have finished the run — and paid for the report —
    // after we stopped listening. Its 24h cache means a retry does not buy it
    // a second time.
    vi.stubGlobal("fetch", async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    });
    const out = await runLeadAnalysis(REQ);
    expect(out.kind).toBe("retryable");
    if (out.kind === "retryable") expect(out.errorCode).toBe("timeout");
  });

  it("retries unreadable JSON rather than treating it as an answer", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>502</html>", { status: 200 }));
    expect((await runLeadAnalysis(REQ)).kind).toBe("retryable");
  });
});

// ─── The seam ─────────────────────────────────────────────────────
//
// base64 -> bytes -> a storage bucket is the shape that fails quietly: a
// truncated payload decodes to *something*, and a something-shaped file is
// exactly what gets stored as a report an operator can open. 159 zero-byte
// PDFs once shipped that way.

describe("runLeadAnalysis: the PDF must survive the trip intact", () => {
  it("decodes the document byte for byte", async () => {
    vi.stubGlobal("fetch", async () => respond(200, body()));
    const out = await runLeadAnalysis(REQ);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.pdfBytes).not.toBeNull();
    expect(Buffer.from(out.pdfBytes!).equals(PDF)).toBe(true);
  });

  it("refuses a document whose declared length disagrees with what arrived", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(200, body({ pdf: { base64: PDF.toString("base64"), bytes: 999999 } }))
    );
    const out = await runLeadAnalysis(REQ);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.pdfBytes).toBeNull();
  });

  it("refuses something that decodes but is not a PDF", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(200, body({ pdf: { base64: Buffer.from("<html>oops</html>").toString("base64") } }))
    );
    const out = await runLeadAnalysis(REQ);
    if (out.kind === "ok") expect(out.pdfBytes).toBeNull();
  });

  it("refuses an empty document", async () => {
    vi.stubGlobal("fetch", async () => respond(200, body({ pdf: { base64: "", bytes: 0 } })));
    const out = await runLeadAnalysis(REQ);
    if (out.kind === "ok") expect(out.pdfBytes).toBeNull();
  });

  it("still returns the figures when the analyser sent no document at all", async () => {
    // The caller refuses to store a figureless report, but that decision
    // belongs to buildOutcomeFromAnalyserResponse, not here.
    vi.stubGlobal("fetch", async () => respond(200, body({ pdf: null })));
    const out = await runLeadAnalysis(REQ);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.pdfBytes).toBeNull();
      expect(out.payload.figures.gross_annual_income).toBe(40000);
    }
  });
});
