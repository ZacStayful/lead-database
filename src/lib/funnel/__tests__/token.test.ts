/**
 * The funnel link token (batch 02, C6).
 *
 * WHAT BREAKS IF THESE FAIL
 * -------------------------
 * The token is the only thing between a stranger and an enquirer's funnel.
 * If it stops being deterministic, n8n asking twice sends two links and the
 * first stops working. If it stops being domain-separated, a batch-review
 * token for the same id would open a funnel. If the stored hash stops
 * matching 0165's CHECK, every session insert fails.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveReviewToken } from "@/lib/batchReview/review";
import {
  alreadySetUpLoginUrl,
  ALREADY_SET_UP_LOGIN_PATH,
  deriveFunnelSummaryToken,
  deriveFunnelToken,
  funnelSummaryPath,
  funnelUrl,
  hashFunnelToken,
  looksLikeFunnelToken,
  verifyFunnelSummaryToken,
} from "@/lib/funnel/token";

const ID = "6f1c7a52-3f7e-4c4e-9a0e-7a1b2c3d4e5f";

describe("deriveFunnelToken", () => {
  it("is the same for the same session, so n8n asking twice gets one link", () => {
    expect(deriveFunnelToken(ID, "s3cret")).toBe(deriveFunnelToken(ID, "s3cret"));
  });

  it("differs by session and by secret", () => {
    const a = deriveFunnelToken(ID, "s3cret");
    expect(deriveFunnelToken("6f1c7a52-3f7e-4c4e-9a0e-7a1b2c3d4e60", "s3cret")).not.toBe(a);
    expect(deriveFunnelToken(ID, "other")).not.toBe(a);
  });

  it("is domain-separated: not the review token, and not an HMAC of the bare id", () => {
    const review = deriveReviewToken(ID, "2026-11-01T00:00:00Z", "s3cret");
    expect(deriveFunnelToken(ID, "s3cret")).not.toBe(review);
    // MESSAGING_TOKEN_SECRET is shared with other links; without the
    // `funnel:` prefix a token minted for another purpose over the same id
    // could open a funnel.
    const bare = createHmac("sha256", "s3cret").update(ID).digest("base64url");
    expect(deriveFunnelToken(ID, "s3cret")).not.toBe(bare);
    const prefixed = createHmac("sha256", "s3cret").update(`funnel:${ID}`).digest("base64url");
    expect(deriveFunnelToken(ID, "s3cret")).toBe(prefixed);
  });

  it("fails closed with no secret", () => {
    expect(deriveFunnelToken(ID, null)).toBeNull();
    expect(deriveFunnelToken(ID, "")).toBeNull();
    expect(deriveFunnelToken("", "s3cret")).toBeNull();
  });

  it("looks like one of ours, and nothing else does", () => {
    const t = deriveFunnelToken(ID, "s3cret")!;
    expect(t).toHaveLength(43);
    expect(looksLikeFunnelToken(t)).toBe(true);
    expect(looksLikeFunnelToken(t.slice(1))).toBe(false);
    expect(looksLikeFunnelToken(`${t.slice(1)}/`)).toBe(false);
    expect(looksLikeFunnelToken("")).toBe(false);
  });
});

describe("hashFunnelToken", () => {
  it("is 64 hex characters, which is what 0165's token_hash CHECK admits", () => {
    const check = readFileSync("supabase/migrations/0165_funnel.sql", "utf8").match(
      /funnel_sessions_token_hash_format check \(token_hash ~ '([^']+)'\)/
    );
    expect(check).not.toBeNull();
    const hash = hashFunnelToken(deriveFunnelToken(ID, "s3cret")!);
    expect(hash).toMatch(new RegExp(check![1]));
  });

  it("is never the token itself", () => {
    const t = deriveFunnelToken(ID, "s3cret")!;
    expect(hashFunnelToken(t)).not.toContain(t);
  });
});

describe("links", () => {
  it("the funnel link is /start/<token>", () => {
    expect(funnelUrl("abc")).toMatch(/\/start\/abc$/);
  });

  it("an existing customer is sent to log in with the notice", () => {
    expect(ALREADY_SET_UP_LOGIN_PATH).toBe("/login?notice=already_set_up");
    expect(alreadySetUpLoginUrl()).toMatch(/\/login\?notice=already_set_up$/);
  });
});

describe("the partner summary token", () => {
  const SECRET = "s3cret";

  it("opens the session it was made for, and only with our secret", () => {
    const t = deriveFunnelSummaryToken(ID, SECRET)!;
    expect(t.startsWith(`${ID}.`)).toBe(true);
    expect(verifyFunnelSummaryToken(t, SECRET)).toBe(ID);
    expect(verifyFunnelSummaryToken(t, "other")).toBeNull();
    expect(verifyFunnelSummaryToken(t, null)).toBeNull();
  });

  it("is domain-separated from the funnel token, so neither becomes the other", () => {
    const funnel = deriveFunnelToken(ID, SECRET)!;
    const summary = deriveFunnelSummaryToken(ID, SECRET)!;
    expect(summary.split(".")[1]).not.toBe(funnel);
    expect(summary.split(".")[1]).toBe(
      createHmac("sha256", SECRET).update(`funnel-summary:${ID}`).digest("base64url")
    );
    // A funnel token is never a summary token, and a summary token never opens the funnel.
    expect(verifyFunnelSummaryToken(funnel, SECRET)).toBeNull();
    expect(looksLikeFunnelToken(summary)).toBe(false);
  });

  it("refuses a token for another session, a tampered one and junk", () => {
    const t = deriveFunnelSummaryToken(ID, SECRET)!;
    const other = "6f1c7a52-3f7e-4c4e-9a0e-7a1b2c3d4e60";
    expect(verifyFunnelSummaryToken(`${other}.${t.split(".")[1]}`, SECRET)).toBeNull();
    expect(verifyFunnelSummaryToken(`${t.slice(0, -1)}${t.endsWith("A") ? "B" : "A"}`, SECRET)).toBeNull();
    for (const junk of ["", ".", ID, `${ID}.`, "x.y", `${ID}.${"a".repeat(44)}`]) {
      expect(verifyFunnelSummaryToken(junk, SECRET)).toBeNull();
    }
    expect(deriveFunnelSummaryToken("not-a-uuid", SECRET)).toBeNull();
    expect(deriveFunnelSummaryToken(ID, null)).toBeNull();
  });

  it("the path is the doc's /start/[token]/summary", () => {
    expect(funnelSummaryPath("abc.def")).toBe("/start/abc.def/summary");
  });
});
