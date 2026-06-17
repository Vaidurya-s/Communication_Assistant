import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { appendFeedback, readFeedback, readFeedbackEntries } from "./feedback.js";

// Use a NON-default tenant so voiceDirFor resolves under
// backend/data/tenants/<id>/voice_profile (not the repo-root voice_profile the
// local tenant owns). cwd = backend/ during tests, so this stays in a throwaway
// tenant tree we delete after each test. Mirrors voiceSections.test.ts.
const TENANT = "fb-test-tenant";
const tenantRoot = resolve(process.cwd(), "data", "tenants", TENANT);

afterEach(() => {
  rmSync(tenantRoot, { recursive: true, force: true });
});

describe("feedback section round-trip", () => {
  it("writes and parses the structured section a 👎 is about", () => {
    appendFeedback(
      TENANT,
      { rating: "down", section: "registers", note: "too formal", contact: "Dana", suggestion: "Hi Dana, ..." },
      "2026-06-17T10:00:00.000Z",
    );

    const raw = readFeedback(TENANT);
    expect(raw).toContain("- section: registers");

    const [entry] = readFeedbackEntries(TENANT);
    expect(entry).toMatchObject({
      rating: "down",
      section: "registers",
      note: "too formal",
      contact: "Dana",
    });
  });

  it("omits the section line when none is given (👍 path)", () => {
    appendFeedback(TENANT, { rating: "up", suggestion: "looks great" }, "2026-06-17T11:00:00.000Z");

    const raw = readFeedback(TENANT);
    expect(raw).not.toContain("- section:");

    const [entry] = readFeedbackEntries(TENANT);
    expect(entry.rating).toBe("up");
    expect(entry.section).toBeUndefined();
  });

  it("keeps each section attached to its own entry across multiple feedbacks", () => {
    appendFeedback(TENANT, { rating: "down", section: "openers" }, "2026-06-17T09:00:00.000Z");
    appendFeedback(TENANT, { rating: "down", section: "closings" }, "2026-06-17T09:05:00.000Z");

    // readFeedbackEntries returns newest-first.
    const entries = readFeedbackEntries(TENANT);
    expect(entries.map((e) => e.section)).toEqual(["closings", "openers"]);
  });
});
