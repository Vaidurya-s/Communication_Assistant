import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resetDb } from "./db.js";
import { getContextItems } from "./context.js";
import { loadSections } from "./voiceSections.js";
import { applyInterview, INTERVIEW_QUESTIONS } from "./interview.js";

// A NON-default tenant id, so voiceSections writes under
// backend/data/tenants/<id>/voice_profile/ (not the repo-root voice_profile/).
const T = "interview-test-tenant";
const tenantDir = resolve(process.cwd(), "data", "tenants", T);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comms-db-"));
  process.env.COMMS_DB_PATH = join(dir, "test.sqlite");
  resetDb();
});
afterEach(() => {
  resetDb();
  delete process.env.COMMS_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
  // Clean up the on-disk voice dir created by saveSection for this tenant.
  rmSync(tenantDir, { recursive: true, force: true });
});

describe("applyInterview", () => {
  it("maps a full set of answers to sections + proposed context items", () => {
    const result = applyInterview(T, {
      registers: "Formal greeting for execs; first-name for peers.",
      vocabulary: "circle back, synergy",
      closings: "Best, Arun",
      disagreeing: "I name the concern directly and propose an alternative.",
      projects: "Comms Assistant\nVoice eval harness",
      achievement: "Shipped multi-tenant data model.",
      bio: "Backend engineer who likes clean trust boundaries.",
      looking_for: "Staff backend roles and collaborators.",
    });

    // Four section questions → four section writes, in question order.
    expect(result.sectionsWritten).toEqual([
      "registers",
      "vocabulary",
      "closings",
      "disagreeing",
    ]);

    // Context: 2 projects + achievement + bio + looking_for = 5 proposed items.
    expect(result.contextCreated).toBe(5);

    const doc = loadSections(T);
    expect(doc?.sections.registers.body).toBe(
      "Formal greeting for execs; first-name for peers.",
    );
    expect(doc?.sections.registers.source).toBe("interview");
    // vocabulary stored with the "Avoid: " prefix.
    expect(doc?.sections.vocabulary.body).toBe("Avoid: circle back, synergy");

    // All context items land as proposed (confirmed=0).
    const proposed = getContextItems(T, { includeUnconfirmed: true });
    expect(proposed).toHaveLength(5);
    expect(proposed.every((i) => i.confirmed === 0)).toBe(true);
    // None visible until confirmed.
    expect(getContextItems(T)).toHaveLength(0);
  });

  it("splits a multiline project answer into one item per non-empty line", () => {
    const result = applyInterview(T, {
      projects: "  Comms Assistant  \n\n  Voice eval harness \n   \nThird project",
    });

    expect(result.contextCreated).toBe(3);
    const projects = getContextItems(T, { type: "project", includeUnconfirmed: true });
    expect(projects.map((p) => p.body).sort()).toEqual(
      ["Comms Assistant", "Third project", "Voice eval harness"].sort(),
    );
    // Title is derived (first ~6 words) and non-empty.
    expect(projects.every((p) => p.title.length > 0)).toBe(true);
  });

  it("skips empty / whitespace-only answers and ignores unknown ids", () => {
    const result = applyInterview(T, {
      registers: "   ",
      closings: "",
      bio: "Real bio.",
      unknown_question: "should be ignored",
    });

    expect(result.sectionsWritten).toEqual([]);
    expect(result.contextCreated).toBe(1);
    expect(getContextItems(T, { type: "bio", includeUnconfirmed: true })).toHaveLength(1);
  });

  it("creates one bio and one achievement item, each with non-empty title + body", () => {
    applyInterview(T, {
      bio: "One-line bio.",
      achievement: "Recent achievement.",
    });

    const bio = getContextItems(T, { type: "bio", includeUnconfirmed: true });
    const ach = getContextItems(T, { type: "achievement", includeUnconfirmed: true });
    expect(bio).toHaveLength(1);
    expect(ach).toHaveLength(1);
    expect(bio[0].title).toBe("Bio");
    expect(bio[0].body).toBe("One-line bio.");
    expect(ach[0].title).toBe("Achievement");
    expect(ach[0].body).toBe("Recent achievement.");
    expect(bio[0].title.length).toBeGreaterThan(0);
    expect(bio[0].body.length).toBeGreaterThan(0);
  });

  it("exposes a deterministic question set covering both layers", () => {
    expect(INTERVIEW_QUESTIONS.length).toBeGreaterThanOrEqual(6);
    expect(INTERVIEW_QUESTIONS.length).toBeLessThanOrEqual(8);
    const kinds = new Set(INTERVIEW_QUESTIONS.map((q) => q.target.kind));
    expect(kinds.has("section")).toBe(true);
    expect(kinds.has("context")).toBe(true);
  });
});
