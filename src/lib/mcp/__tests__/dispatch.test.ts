/**
 * JSON-RPC dispatch.
 *
 * The cases worth having are the protocol contract (a notification must be
 * acknowledged, not answered) and the two places a mistake would be invisible:
 * a tool running without its scope, and a tool refusal being reported as a
 * protocol error the model cannot read.
 */
import { describe, expect, it } from "vitest";
import {
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  dispatch,
} from "@/lib/mcp/dispatch";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import type { Caller } from "@/lib/api/caller";

function callerWith(scopes: string[]): Caller {
  return {
    customerId: "customer-1",
    customer: {} as never,
    via: "api_key",
    scopes: scopes as never,
    keyId: "key-1",
    minuteCount: 1,
  };
}

const FULL = callerWith(["profile:read", "leads:read"]);

describe("initialize", () => {
  it("agrees to a version it speaks", async () => {
    const out = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      FULL
    );
    expect(out.kind).toBe("response");
    if (out.kind === "response") {
      const r = out.body.result as Record<string, unknown>;
      expect(r.protocolVersion).toBe("2025-06-18");
      expect(r.capabilities).toHaveProperty("tools");
      expect(r.serverInfo).toHaveProperty("name", "stayful-leads");
    }
  });

  it("answers with its latest when asked for one it does not speak", async () => {
    const out = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      FULL
    );
    if (out.kind === "response") {
      expect((out.body.result as Record<string, unknown>).protocolVersion).toBe(
        LATEST_PROTOCOL_VERSION
      );
    }
  });

  it("tells the model the two income figures are different things", async () => {
    const out = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" }, FULL);
    if (out.kind === "response") {
      const instructions = String(
        (out.body.result as Record<string, unknown>).instructions
      );
      expect(instructions).toContain("gross_annual_income");
      expect(instructions).toContain("income_estimate");
      expect(instructions).toContain("self-reported");
    }
  });
});

describe("notifications", () => {
  it("acknowledges rather than answering", async () => {
    // A response body for a notification is a protocol violation: the client
    // has no id to match it to.
    const out = await dispatch(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      FULL
    );
    expect(out.kind).toBe("accepted");
  });
});

describe("tools/list", () => {
  it("returns every tool with a name, description and schema", async () => {
    const out = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }, FULL);
    if (out.kind !== "response") throw new Error("expected a response");
    const tools = (out.body.result as { tools: Record<string, unknown>[] }).tools;
    expect(tools).toHaveLength(MCP_TOOLS.length);
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(String(t.description).length).toBeGreaterThan(50);
      expect(t.inputSchema).toHaveProperty("type", "object");
    }
  });

  it("exposes no tool that accepts a free-form query", async () => {
    // The standing rule: every tool is a named operation with a fixed shape.
    // A query/sql/table/path parameter would undo the whole containment design.
    for (const tool of MCP_TOOLS) {
      const props = Object.keys(
        (tool.inputSchema.properties ?? {}) as Record<string, unknown>
      );
      for (const banned of ["query", "sql", "table", "columns", "select", "path", "filter", "where"]) {
        expect(props).not.toContain(banned);
      }
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe("tools/call", () => {
  it("refuses a tool the key lacks the scope for, as readable content", async () => {
    const out = await dispatch(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_leads", arguments: {} } },
      callerWith(["profile:read"])
    );
    if (out.kind !== "response") throw new Error("expected a response");
    const r = out.body.result as Record<string, unknown>;
    // isError content rather than a JSON-RPC error: the model has to be able to
    // read why it was refused and adjust.
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("leads:read");
    expect(out.body.error).toBeUndefined();
  });

  it("rejects an unknown tool at the protocol level", async () => {
    const out = await dispatch(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "drop_tables" } },
      FULL
    );
    if (out.kind !== "response") throw new Error("expected a response");
    expect((out.body.error as { code: number }).code).toBe(JSONRPC_INVALID_PARAMS);
  });
});

describe("unknown methods", () => {
  it("returns method-not-found rather than failing open", async () => {
    const out = await dispatch({ jsonrpc: "2.0", id: 5, method: "resources/read" }, FULL);
    if (out.kind !== "response") throw new Error("expected a response");
    expect((out.body.error as { code: number }).code).toBe(JSONRPC_METHOD_NOT_FOUND);
  });
});

describe("protocol versions", () => {
  it("advertises its latest first", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe(LATEST_PROTOCOL_VERSION);
  });
});
