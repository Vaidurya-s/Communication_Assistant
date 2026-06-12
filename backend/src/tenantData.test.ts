import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb } from "./db.js";
import { addNote, proposeNote, recordStrategy, getAllContacts } from "./memory.js";
import { exportTenant, purgeTenant } from "./tenantData.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comms-tdata-"));
  process.env.COMMS_DB_PATH = join(dir, "test.sqlite");
  resetDb();
});
afterEach(() => {
  resetDb();
  delete process.env.COMMS_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("tenant data export", () => {
  it("exports a tenant's contacts (with notes) and strategies", () => {
    addNote("t1", "Alice", "a confirmed note", "manual");
    proposeNote("t1", "Alice", "a pending note");
    recordStrategy("t1", "Alice", "be patient", null);
    // noise under another tenant
    addNote("t2", "Bob", "b note", "manual");

    const dump = exportTenant("t1", "2026-01-01T00:00:00Z");
    expect(dump.tenant_id).toBe("t1");
    expect(dump.contacts).toHaveLength(1);
    expect(dump.contacts[0].name).toBe("Alice");
    // includes confirmed + pending notes
    expect(dump.contacts[0].notes.map((n) => n.body).sort()).toEqual([
      "a confirmed note",
      "a pending note",
    ]);
    expect(dump.strategies.map((s) => s.text)).toEqual(["be patient"]);
  });

  it("never leaks another tenant's data into the export", () => {
    addNote("t1", "Alice", "a", "manual");
    addNote("t2", "Bob", "b", "manual");
    const dump = exportTenant("t2", "2026-01-01T00:00:00Z");
    const names = dump.contacts.map((c) => c.name);
    expect(names).toEqual(["Bob"]);
  });
});

describe("tenant data purge", () => {
  it("erases only the caller's data and reports counts", () => {
    addNote("t1", "Alice", "a1", "manual");
    addNote("t1", "Alice", "a2", "auto");
    recordStrategy("t1", "Alice", "s1", null);
    addNote("t2", "Bob", "b1", "manual");

    const result = purgeTenant("t1");
    expect(result).toMatchObject({ contacts: 1, notes: 2, strategies: 1 });

    expect(getAllContacts("t1")).toHaveLength(0);
    // t2 untouched
    expect(getAllContacts("t2").map((c) => c.name)).toEqual(["Bob"]);
  });

  it("is a no-op (zero counts) for an unknown tenant", () => {
    expect(purgeTenant("ghost")).toMatchObject({ contacts: 0, notes: 0, strategies: 0, llm_config: 0 });
  });
});
