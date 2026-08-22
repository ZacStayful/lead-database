import { describe, expect, it, vi } from "vitest";
import { STATUS_BY_CODE, internal, notFound } from "@/lib/api/errors";

describe("notFound", () => {
  it("is byte-identical for every reason a caller may not see something", () => {
    // A foreign id, an unknown id and a lead with no stored report all produce
    // this. Distinguishing them would turn the endpoint into an oracle for
    // which ids exist.
    const a = JSON.stringify(notFound());
    const b = JSON.stringify(notFound());
    expect(a).toBe(b);
    expect(notFound().message).toBe("Not found.");
    expect(STATUS_BY_CODE[notFound().code]).toBe(404);
  });
});

describe("internal", () => {
  it("never returns database detail to the caller", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbError = {
      message:
        'new row for relation "lead_assignments" violates check constraint "lead_assignments_status_check"',
      code: "23514",
    };
    const result = internal("listAssignments", dbError);

    expect(result.message).not.toContain("lead_assignments");
    expect(result.message).not.toContain("23514");
    expect(result.message).not.toContain("constraint");
    expect(result.code).toBe("internal_error");
    // The detail still has to go somewhere, or this is a downgrade rather than
    // a containment measure.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("points the caller at the request id so support can find it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(internal("x", new Error("boom")).message).toContain("X-Request-Id");
    spy.mockRestore();
  });
});

describe("STATUS_BY_CODE", () => {
  it("maps each code to the status the docs promise", () => {
    expect(STATUS_BY_CODE.unauthorized).toBe(401);
    expect(STATUS_BY_CODE.invalid_api_key).toBe(401);
    expect(STATUS_BY_CODE.revoked_api_key).toBe(401);
    expect(STATUS_BY_CODE.expired_api_key).toBe(401);
    expect(STATUS_BY_CODE.insufficient_scope).toBe(403);
    expect(STATUS_BY_CODE.not_found).toBe(404);
    expect(STATUS_BY_CODE.invalid_request).toBe(400);
    expect(STATUS_BY_CODE.rate_limited).toBe(429);
    expect(STATUS_BY_CODE.service_unavailable).toBe(503);
  });
});
