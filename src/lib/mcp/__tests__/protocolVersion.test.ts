/**
 * The protocol-version header must NEGOTIATE, never refuse.
 *
 * The route used to hard-400 anything outside SUPPORTED_PROTOCOL_VERSIONS, and
 * it did so before authenticating — so the first time a client shipped a newer
 * spec revision, every connection would have died with a 400 that reads as an
 * auth failure. These cases pin the leniency so it cannot be tightened back by
 * somebody reading the transport spec's "SHOULD return 400" in isolation.
 */
import { describe, expect, it } from "vitest";
import {
  ASSUMED_PROTOCOL_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  protocolVersionForHeader,
} from "@/lib/mcp/dispatch";

describe("protocolVersionForHeader", () => {
  it("assumes the pre-negotiation default when no header is sent", () => {
    expect(protocolVersionForHeader(null)).toBe(ASSUMED_PROTOCOL_VERSION);
  });

  it("echoes every version we actually support", () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(protocolVersionForHeader(v)).toBe(v);
    }
  });

  it("answers with our latest for a version newer than anything we know", () => {
    // The case that would have taken the whole connection down with a 400.
    expect(protocolVersionForHeader("2099-01-01")).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("answers with our latest for junk rather than refusing", () => {
    expect(protocolVersionForHeader("not-a-version")).toBe(LATEST_PROTOCOL_VERSION);
    expect(protocolVersionForHeader("")).toBe(ASSUMED_PROTOCOL_VERSION);
  });

  it("never returns something outside the supported list", () => {
    for (const input of [null, "2099-01-01", "junk", "2025-03-26"]) {
      expect(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).toContain(
        protocolVersionForHeader(input)
      );
    }
  });
});
