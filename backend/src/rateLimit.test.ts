import { describe, it, expect, beforeEach } from "vitest";
import { checkRate, resetRateLimits } from "./rateLimit.js";

beforeEach(() => resetRateLimits());

describe("rate limiter", () => {
  it("is disabled when the limit is 0 or negative", () => {
    for (let i = 0; i < 100; i++) {
      expect(checkRate("t1", 0, 1000).ok).toBe(true);
    }
  });

  it("allows up to the limit within the window, then blocks", () => {
    const now = 10_000;
    for (let i = 0; i < 3; i++) {
      expect(checkRate("t1", 3, now).ok).toBe(true);
    }
    const blocked = checkRate("t1", 3, now);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("frees up capacity once the window slides past old hits", () => {
    const start = 10_000;
    for (let i = 0; i < 3; i++) checkRate("t1", 3, start);
    expect(checkRate("t1", 3, start).ok).toBe(false);
    // 61s later the earlier hits have aged out of the 60s window.
    expect(checkRate("t1", 3, start + 61_000).ok).toBe(true);
  });

  it("tracks tenants independently", () => {
    const now = 10_000;
    for (let i = 0; i < 3; i++) checkRate("t1", 3, now);
    expect(checkRate("t1", 3, now).ok).toBe(false);
    // a different tenant has its own budget
    expect(checkRate("t2", 3, now).ok).toBe(true);
  });

  it("does not count a blocked request against the retry window", () => {
    const now = 10_000;
    for (let i = 0; i < 2; i++) checkRate("t1", 2, now);
    const first = checkRate("t1", 2, now); // blocked
    const second = checkRate("t1", 2, now + 1000); // still blocked, window from first 2 hits
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    // retry should reference the original hits (~60s), not keep growing
    expect(second.retryAfterSec).toBeLessThanOrEqual(60);
  });
});
