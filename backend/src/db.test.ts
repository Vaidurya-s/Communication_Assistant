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
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_LATEST);

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
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_LATEST);
  });
});

// The version migrateToCompositePk stamps. Kept local to the test so a future
// bump is a deliberate, visible change here too.
// The composite-PK migration stamps 1; a booted database then also runs the v2
// contact-name cleanup, so it ends at the latest schema version, not at 1.
const SCHEMA_LATEST = 2;

/**
 * v2 — contact-name cleanup.
 *
 * Seeds a v1 database (composite PK already in place, user_version = 1) holding
 * names polluted the way the live database was, then boots and checks what the
 * migration did with them.
 */
function seedV1WithNames(file: string, names: string[]): void {
  const d = new Database(file);
  d.exec(`
    CREATE TABLE contacts (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      last_thread_url TEXT,
      suggested_followup_at TEXT,
      profile_url TEXT, headline TEXT, role TEXT, company TEXT,
      location TEXT, about TEXT, experience_json TEXT, education_json TEXT,
      skills_json TEXT, profile_fetched_at TEXT,
      PRIMARY KEY (tenant_id, name)
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      contact_name TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'auto',
      proposed_by TEXT NOT NULL DEFAULT 'llm',
      confirmed_by_user INTEGER NOT NULL DEFAULT 1,
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id, contact_name) REFERENCES contacts(tenant_id, name) ON DELETE CASCADE
    );
    CREATE TABLE strategy_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      contact_name TEXT NOT NULL,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      text TEXT NOT NULL,
      suggested_followup_at TEXT
    );
  `);
  for (const [i, n] of names.entries()) {
    d.prepare(
      `INSERT INTO contacts (tenant_id, name, first_seen, last_seen, headline)
       VALUES ('local', ?, ?, ?, ?)`,
    ).run(n, `2026-0${i + 1}-01`, `2026-0${i + 2}-01`, i === 0 ? null : `headline ${i}`);
    d.prepare(`INSERT INTO notes (tenant_id, contact_name, body) VALUES ('local', ?, ?)`).run(
      n,
      `note for ${n}`,
    );
    d.prepare(`INSERT INTO strategy_log (tenant_id, contact_name, text) VALUES ('local', ?, ?)`).run(
      n,
      `strategy for ${n}`,
    );
  }
  d.pragma("user_version = 1");
  d.close();
}

describe("v2 contact-name cleanup", () => {
  const POLLUTED = "Divyanshu Gupta Status is reachable Mobile • 10h";

  it("renames a polluted contact and carries its notes and strategies across", () => {
    const file = join(dir, "v2-rename.sqlite");
    seedV1WithNames(file, [POLLUTED]);
    process.env.COMMS_DB_PATH = file;

    const d = getDb();
    const names = d.prepare(`SELECT name FROM contacts`).all() as Array<{ name: string }>;
    expect(names.map((r) => r.name)).toEqual(["Divyanshu Gupta"]);
    // The FK is ON DELETE CASCADE, not ON UPDATE CASCADE, so children have to
    // be carried by hand — if that were missed the notes would be orphaned.
    expect(
      (d.prepare(`SELECT COUNT(*) n FROM notes WHERE contact_name = 'Divyanshu Gupta'`).get() as { n: number }).n,
    ).toBe(1);
    expect(
      (d.prepare(`SELECT COUNT(*) n FROM strategy_log WHERE contact_name = 'Divyanshu Gupta'`).get() as { n: number }).n,
    ).toBe(1);
  });

  it("MERGES rather than clobbers when cleaning collides with an existing row", () => {
    // The same person forked into two contacts by a bad scrape. This is the
    // case worth getting right — a half-migrated primary key is nasty.
    const file = join(dir, "v2-merge.sqlite");
    seedV1WithNames(file, [POLLUTED, "Divyanshu Gupta"]);
    process.env.COMMS_DB_PATH = file;

    const d = getDb();
    const rows = d.prepare(`SELECT name, first_seen, headline FROM contacts`).all() as Array<{
      name: string;
      first_seen: string;
      headline: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Divyanshu Gupta");
    // Earliest first_seen survives (the polluted row was seeded first)...
    expect(rows[0].first_seen).toBe("2026-01-01");
    // ...and a column the survivor was missing is filled from the duplicate.
    expect(rows[0].headline).toBe("headline 1");
    // Both rows' notes end up on the survivor — nothing is stranded.
    expect(
      (d.prepare(`SELECT COUNT(*) n FROM notes WHERE contact_name = 'Divyanshu Gupta'`).get() as { n: number }).n,
    ).toBe(2);
  });

  it("leaves clean names untouched and is idempotent across boots", () => {
    const file = join(dir, "v2-idem.sqlite");
    seedV1WithNames(file, ["Michal Krelina", POLLUTED]);
    process.env.COMMS_DB_PATH = file;

    getDb();
    resetDb();
    const d = getDb(); // second boot must find nothing to do
    const names = (d.prepare(`SELECT name FROM contacts ORDER BY name`).all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(names).toEqual(["Divyanshu Gupta", "Michal Krelina"]);
    expect(d.pragma("user_version", { simple: true })).toBe(2);
  });

  it("still runs the cleanup on a database left at v1 by the earlier migration", () => {
    // Regression guard: gating both migrations on one shared "latest" constant
    // made the v1 migration re-run and stamp 2, silently skipping v2 on exactly
    // the databases that needed it.
    const file = join(dir, "v2-from-v1.sqlite");
    seedV1WithNames(file, [POLLUTED]);
    process.env.COMMS_DB_PATH = file;
    const d = getDb();
    expect((d.prepare(`SELECT name FROM contacts`).get() as { name: string }).name).toBe(
      "Divyanshu Gupta",
    );
  });
});
