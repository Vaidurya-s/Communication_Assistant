import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { appendEdit, editsAsCorrections, readEditEntries, readEdits } from "./editMining.js";

// Non-default tenant → writes under backend/data/tenants/<id>/voice_profile,
// cleaned up after each test (mirrors feedback.test.ts / voiceSections.test.ts).
const TENANT = "edit-test-tenant";
const tenantRoot = resolve(process.cwd(), "data", "tenants", TENANT);

afterEach(() => {
  rmSync(tenantRoot, { recursive: true, force: true });
});

describe("edit-mining store", () => {
  it("appends and parses a before→after edit", () => {
    appendEdit(
      TENANT,
      { before: "Let's circle back next week.", after: "Let's talk Tuesday.", contact: "Dana" },
      "2026-06-17T10:00:00.000Z",
    );

    const raw = readEdits(TENANT);
    expect(raw).toContain("- suggested: Let's circle back next week.");
    expect(raw).toContain("- sent: Let's talk Tuesday.");

    const [e] = readEditEntries(TENANT);
    expect(e).toMatchObject({
      before: "Let's circle back next week.",
      after: "Let's talk Tuesday.",
      contact: "Dana",
    });
  });

  it("returns entries newest-first", () => {
    appendEdit(TENANT, { before: "a1", after: "b1" }, "2026-06-17T09:00:00.000Z");
    appendEdit(TENANT, { before: "a2", after: "b2" }, "2026-06-17T09:05:00.000Z");
    expect(readEditEntries(TENANT).map((e) => e.after)).toEqual(["b2", "b1"]);
  });

  it("renders a corrections block for distill, capped at max", () => {
    appendEdit(TENANT, { before: "old", after: "new" }, "2026-06-17T09:00:00.000Z");
    const block = editsAsCorrections(TENANT);
    expect(block).toContain('I changed "old" → "new"');

    // cap respected
    for (let i = 0; i < 5; i++) {
      appendEdit(TENANT, { before: `b${i}`, after: `a${i}` }, "2026-06-17T09:10:00.000Z");
    }
    const limited = editsAsCorrections(TENANT, 3);
    const count = (limited.match(/I changed/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("returns empty string when there are no edits", () => {
    expect(editsAsCorrections(TENANT)).toBe("");
    expect(readEditEntries(TENANT)).toEqual([]);
  });
});
