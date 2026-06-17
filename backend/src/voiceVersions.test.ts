import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voiceProfilePath, voiceDirFor } from "./voiceProfile.js";
import {
  listVersions,
  pruneVersions,
  restoreVersion,
  snapshotProfile,
} from "./voiceVersions.js";

// Non-default tenant → everything under backend/data/tenants/<id>/, cleaned up.
const TENANT = "ver-test-tenant";
const tenantRoot = resolve(process.cwd(), "data", "tenants", TENANT);

function writeProfile(text: string): void {
  mkdirSync(voiceDirFor(TENANT), { recursive: true });
  writeFileSync(voiceProfilePath(TENANT), text, "utf-8");
}

afterEach(() => {
  rmSync(tenantRoot, { recursive: true, force: true });
});

describe("voice versioning", () => {
  it("snapshots the current profile and lists it", () => {
    writeProfile("# voice v1\nopeners: short.");
    const id = snapshotProfile(TENANT, "distill", "2026-06-17T10:00:00.000Z");
    expect(id).toMatch(/^v_.*__distill\.md$/);

    const versions = listVersions(TENANT);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ id, reason: "distill" });
    expect(versions[0].chars).toBeGreaterThan(0);
  });

  it("returns null when there's no profile to snapshot", () => {
    expect(snapshotProfile(TENANT, "compile")).toBeNull();
    writeProfile("   ");
    expect(snapshotProfile(TENANT, "compile")).toBeNull(); // empty content
  });

  it("restores a snapshot over the current profile", () => {
    writeProfile("ORIGINAL");
    const id = snapshotProfile(TENANT, "apply", "2026-06-17T10:00:00.000Z")!;
    writeProfile("CHANGED"); // simulate a regenerate

    expect(restoreVersion(TENANT, id)).toBe(true);
    expect(readFileSync(voiceProfilePath(TENANT), "utf-8")).toBe("ORIGINAL");
  });

  it("rejects an invalid / traversal id", () => {
    writeProfile("x");
    snapshotProfile(TENANT, "edit", "2026-06-17T10:00:00.000Z");
    expect(restoreVersion(TENANT, "../../etc/passwd")).toBe(false);
    expect(restoreVersion(TENANT, "not-a-version.md")).toBe(false);
  });

  it("lists newest first and prunes to the keep limit", () => {
    for (let i = 0; i < 5; i++) {
      writeProfile(`v${i}`);
      snapshotProfile(TENANT, `r${i}`, `2026-06-17T10:0${i}:00.000Z`);
    }
    const versions = listVersions(TENANT);
    expect(versions[0].reason).toBe("r4"); // newest first

    pruneVersions(TENANT, 2);
    const kept = listVersions(TENANT);
    expect(kept).toHaveLength(2);
    expect(kept.map((v) => v.reason)).toEqual(["r4", "r3"]);
  });
});
