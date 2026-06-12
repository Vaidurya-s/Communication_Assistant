import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, resetDb } from "./db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comms-db-mig-"));
});
afterEach(() => {
  resetDb();
  delete process.env.COMMS_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a pre-H1b database exactly as H1 would have left it: tenant_id columns
 * present (added by ensureColumn) but contacts still keyed by `name` alone and
 * notes' FK still referencing contacts(name). user_version is 0.
 */
function seedLegacyDb(file: string): void {
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.exec(`
    CREATE TABLE contacts (
      name TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      last_thread_url TEXT,
      suggested_followup_at TEXT,
      profile_url TEXT, headline TEXT, role TEXT, company TEXT, location TEXT,
      about TEXT, experience_json TEXT, education_json TEXT, skills_json TEXT,
      profile_fetched_at TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_name TEXT NOT NULL REFERENCES contacts(name) ON DELETE CASCADE,
      body TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
      proposed_by TEXT NOT NULL DEFAULT 'llm',
      confirmed_by_user INTEGER NOT NULL DEFAULT 1,
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      tenant_id TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE strategy_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_name TEXT NOT NULL,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      text TEXT NOT NULL,
      suggested_followup_at TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'local'
    );
  `);
  d.prepare(
    `INSERT INTO contacts (name, first_seen, last_seen, role, tenant_id) VALUES (?, ?, ?, ?, 'local')`,
  ).run("Legacy Larry", "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z", "Engineer");
  d.prepare(`INSERT INTO notes (contact_name, body, source, tenant_id) VALUES (?, ?, ?, 'local')`).run(
    "Legacy Larry",
    "old note",
    "manual",
  );
  d.pragma("user_version = 0");
  d.close();
}

function pkColumns(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(contacts)`).all() as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0)
    .map((c) => c.name)
    .sort();
}

describe("db H1b composite-PK migration", () => {
  it("rebuilds a legacy single-column-PK DB and preserves all data", () => {
    const file = join(dir, "legacy.sqlite");
    seedLegacyDb(file);
    process.env.COMMS_DB_PATH = file;
    resetDb();

    const db = getDb(); // triggers migrateToCompositePk

    expect(pkColumns(db)).toEqual(["name", "tenant_id"]);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_V1);

    const contact = db.prepare(`SELECT name, tenant_id, role FROM contacts`).get() as {
      name: string;
      tenant_id: string;
      role: string;
    };
    expect(contact).toMatchObject({ name: "Legacy Larry", tenant_id: "local", role: "Engineer" });

    const note = db.prepare(`SELECT contact_name, body, tenant_id FROM notes`).get() as {
      contact_name: string;
      body: string;
      tenant_id: string;
    };
    expect(note).toMatchObject({ contact_name: "Legacy Larry", body: "old note", tenant_id: "local" });
  });

  it("allows the same contact name under two tenants after migration", () => {
    const file = join(dir, "legacy.sqlite");
    seedLegacyDb(file);
    process.env.COMMS_DB_PATH = file;
    resetDb();
    const db = getDb();

    // 'local' already has Legacy Larry; a different tenant can now reuse the name.
    expect(() =>
      db
        .prepare(`INSERT INTO contacts (tenant_id, name, first_seen, last_seen) VALUES ('t2','Legacy Larry','x','y')`)
        .run(),
    ).not.toThrow();

    const tenants = (
      db
        .prepare(`SELECT tenant_id FROM contacts WHERE name = 'Legacy Larry' ORDER BY tenant_id`)
        .all() as Array<{ tenant_id: string }>
    ).map((r) => r.tenant_id);
    expect(tenants).toEqual(["local", "t2"]);
  });

  it("cascades note deletion through the composite FK, scoped to the tenant", () => {
    const file = join(dir, "legacy.sqlite");
    seedLegacyDb(file);
    process.env.COMMS_DB_PATH = file;
    resetDb();
    const db = getDb();

    // A second tenant with the SAME contact name and its own note.
    db.prepare(`INSERT INTO contacts (tenant_id, name, first_seen, last_seen) VALUES ('t2','Legacy Larry','x','y')`).run();
    db.prepare(`INSERT INTO notes (tenant_id, contact_name, body, source) VALUES ('t2','Legacy Larry','t2 note','manual')`).run();

    // Deleting local's contact cascades only local's note; t2's note survives.
    db.prepare(`DELETE FROM contacts WHERE tenant_id = 'local' AND name = 'Legacy Larry'`).run();
    const remaining = db.prepare(`SELECT tenant_id, body FROM notes`).all() as Array<{
      tenant_id: string;
      body: string;
    }>;
    expect(remaining).toEqual([{ tenant_id: "t2", body: "t2 note" }]);
  });

  it("stamps a fresh DB as composite without rebuilding", () => {
    process.env.COMMS_DB_PATH = join(dir, "fresh.sqlite");
    resetDb();
    const db = getDb();
    expect(pkColumns(db)).toEqual(["name", "tenant_id"]);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_V1);
  });
});

// The version migrateToCompositePk stamps. Kept local to the test so a future
// bump is a deliberate, visible change here too.
const SCHEMA_V1 = 1;
