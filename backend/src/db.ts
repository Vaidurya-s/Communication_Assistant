import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

// SQLite file lives in backend/data/ (gitignored). Schema is applied
// idempotently on every boot — fine for a single-user local server.
const DB_PATH = resolve(process.cwd(), "data", "memory.sqlite");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      name TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      last_thread_url TEXT,
      suggested_followup_at TEXT,
      profile_url TEXT,
      headline TEXT,
      role TEXT,
      company TEXT,
      location TEXT,
      about TEXT,
      experience_json TEXT,
      education_json TEXT,
      skills_json TEXT,
      profile_fetched_at TEXT
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_name TEXT NOT NULL REFERENCES contacts(name) ON DELETE CASCADE,
      body TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_name);

    CREATE TABLE IF NOT EXISTS strategy_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_name TEXT NOT NULL,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      text TEXT NOT NULL,
      suggested_followup_at TEXT
    );
  `);

  // Forward-compatible column additions (no-op if column already exists).
  // These keep an old memory.sqlite from a prior phase usable after upgrade.
  ensureColumn(db, "contacts", "suggested_followup_at", "TEXT");
  ensureColumn(db, "contacts", "profile_url", "TEXT");
  ensureColumn(db, "contacts", "headline", "TEXT");
  ensureColumn(db, "contacts", "role", "TEXT");
  ensureColumn(db, "contacts", "company", "TEXT");
  ensureColumn(db, "contacts", "location", "TEXT");
  ensureColumn(db, "contacts", "about", "TEXT");
  ensureColumn(db, "contacts", "experience_json", "TEXT");
  ensureColumn(db, "contacts", "education_json", "TEXT");
  ensureColumn(db, "contacts", "skills_json", "TEXT");
  ensureColumn(db, "contacts", "profile_fetched_at", "TEXT");

  return db;
}

function ensureColumn(d: Database.Database, table: string, column: string, type: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
