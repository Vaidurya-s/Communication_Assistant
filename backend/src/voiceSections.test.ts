import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SECTION_KEYS,
  SECTION_LABELS,
  loadSections,
  saveSection,
  compileSections,
  adoptExisting,
} from "./voiceSections.js";
import { voiceProfilePath } from "./voiceProfile.js";

// Use a NON-default tenant so voiceDirFor resolves under
// backend/data/tenants/<id>/voice_profile (not the repo-root voice_profile that
// the local tenant owns). Tests run with cwd = backend/, so this stays inside
// the throwaway tenant tree, which we delete after each test.
const TENANT = "vs-test-tenant";
const tenantRoot = resolve(process.cwd(), "data", "tenants", TENANT);

afterEach(() => {
  rmSync(tenantRoot, { recursive: true, force: true });
});

describe("voiceSections", () => {
  it("roundtrips a saved section through loadSections", () => {
    expect(loadSections(TENANT)).toBeNull(); // nothing yet

    saveSection(TENANT, "openers", "Opens with a one-line ack, no greeting.");

    const doc = loadSections(TENANT);
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(1);
    expect(doc!.sections.openers.body).toBe("Opens with a one-line ack, no greeting.");
    expect(doc!.sections.openers.source).toBe("manual");
    expect(typeof doc!.updatedAt).toBe("string");
    // every canonical key is present (others empty)
    for (const key of SECTION_KEYS) {
      expect(doc!.sections[key]).toBeDefined();
    }
  });

  it("records the provided source", () => {
    saveSection(TENANT, "closings", "Signs off with just a first name.", "distilled");
    expect(loadSections(TENANT)!.sections.closings.source).toBe("distilled");
  });

  it("compiles sections to markdown with labels and writes the runtime file", () => {
    saveSection(TENANT, "openers", "Opens with a one-line ack.");
    saveSection(TENANT, "closings", "Signs off with a first name.");

    const compiled = compileSections(TENANT);

    expect(compiled).toContain("# Strategy analysis — voice profile");
    expect(compiled).toContain(`## ${SECTION_LABELS.openers}`);
    expect(compiled).toContain("Opens with a one-line ack.");
    expect(compiled).toContain(`## ${SECTION_LABELS.closings}`);
    expect(compiled).toContain("Signs off with a first name.");

    // it actually wrote strategy_analysis.md (via voiceProfilePath)
    const outPath = voiceProfilePath(TENANT);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, "utf-8")).toBe(compiled);
  });

  it("skips empty sections when compiling", () => {
    saveSection(TENANT, "openers", "Has content.");
    // rhythm/disagreeing/etc. remain empty

    const compiled = compileSections(TENANT);

    expect(compiled).toContain(`## ${SECTION_LABELS.openers}`);
    expect(compiled).not.toContain(`## ${SECTION_LABELS.rhythm}`);
    expect(compiled).not.toContain(`## ${SECTION_LABELS.disagreeing}`);
  });

  it("adoptExisting preserves an existing profile under the first section", () => {
    // Seed an existing runtime artifact, then adopt it (no sections.json yet).
    const existing =
      "# Strategy analysis — voice profile\n\nWhole hand-written profile body.\n";
    compileSections(TENANT); // creates the dir + an (empty) strategy_analysis.md
    // overwrite with real existing content, and clear the sections.json that
    // compileSections did NOT create (it only writes the runtime file) — so we
    // exercise the "profile exists, no sections.json" adoption path.
    const outPath = voiceProfilePath(TENANT);
    writeFileSync(outPath, existing, "utf-8");

    const doc = adoptExisting(TENANT);

    expect(doc.sections.openers.source).toBe("imported");
    expect(doc.sections.openers.body).toBe(existing.trim());
    // nothing lost: re-compile reproduces the original text
    const recompiled = compileSections(TENANT);
    expect(recompiled).toContain("Whole hand-written profile body.");
    // and adoptExisting persisted sections.json
    expect(loadSections(TENANT)).not.toBeNull();
  });
});
