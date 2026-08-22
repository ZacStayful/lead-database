import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  KEY_PREFIX_LENGTH,
  generateApiKey,
  hashApiKey,
  keysMatch,
  parseKeyPrefix,
} from "@/lib/api/keys";

describe("generateApiKey", () => {
  it("produces a key whose stored prefix is a prefix of it", () => {
    const { raw, prefix, hash } = generateApiKey();
    expect(raw.startsWith(prefix)).toBe(true);
    expect(prefix.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(prefix).toHaveLength(KEY_PREFIX_LENGTH);
    expect(hash).toBe(hashApiKey(raw));
  });

  it("emits only base62 after the prefix", () => {
    // base64url would emit `-` and `_`, which get mangled in URLs, shell
    // history and n8n credential fields.
    for (let i = 0; i < 50; i += 1) {
      const { raw } = generateApiKey();
      expect(raw.slice(API_KEY_PREFIX.length)).toMatch(/^[0-9A-Za-z]+$/);
    }
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateApiKey().raw));
    expect(seen.size).toBe(200);
  });
});

describe("parseKeyPrefix", () => {
  it("extracts the handle from a well-formed key", () => {
    const { raw, prefix } = generateApiKey();
    expect(parseKeyPrefix(raw)).toBe(prefix);
  });

  it("rejects anything that is not one of ours", () => {
    const { raw } = generateApiKey();
    expect(parseKeyPrefix("")).toBeNull();
    expect(parseKeyPrefix("sk_live_whatever")).toBeNull();
    // A truncated paste is rejected here rather than failing a hash comparison
    // later for a reason the customer cannot see.
    expect(parseKeyPrefix(raw.slice(0, -1))).toBeNull();
    expect(parseKeyPrefix(`${raw}x`)).toBeNull();
    // Non-alphabet characters must never reach the database as a filter value.
    expect(parseKeyPrefix(API_KEY_PREFIX + "*".repeat(48))).toBeNull();
    expect(parseKeyPrefix(undefined as unknown as string)).toBeNull();
  });
});

describe("keysMatch", () => {
  it("accepts the right key and rejects a near miss", () => {
    const { raw, hash } = generateApiKey();
    expect(keysMatch(raw, hash)).toBe(true);
    expect(keysMatch(generateApiKey().raw, hash)).toBe(false);
  });

  it("returns false rather than throwing on a malformed stored hash", () => {
    const { raw } = generateApiKey();
    expect(() => keysMatch(raw, "")).not.toThrow();
    expect(keysMatch(raw, "")).toBe(false);
    expect(keysMatch(raw, "short")).toBe(false);
    expect(keysMatch(raw, undefined as unknown as string)).toBe(false);
  });
});
