import { describe, it, expect } from "vitest";
import { DEFAULT_TENANT, tenantOf } from "./tenant.js";

/** Build a minimal fake request whose x-comms-tenant header returns `value`. */
function fakeReq(value: string | undefined) {
  return {
    header: (n: string): string | undefined =>
      n === "x-comms-tenant" ? value : undefined,
  };
}

describe("tenantOf", () => {
  it("returns the trimmed header value when x-comms-tenant is present", () => {
    expect(tenantOf(fakeReq("  acme  "))).toBe("acme");
  });

  it("returns DEFAULT_TENANT when the header is absent", () => {
    expect(tenantOf(fakeReq(undefined))).toBe(DEFAULT_TENANT);
    expect(tenantOf(fakeReq(undefined))).toBe("local");
  });

  it("returns DEFAULT_TENANT when the header is blank/whitespace", () => {
    expect(tenantOf(fakeReq(""))).toBe(DEFAULT_TENANT);
    expect(tenantOf(fakeReq("   "))).toBe(DEFAULT_TENANT);
  });
});
