import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

// SQLite file lives in backend/data/ (gitignored). Schema is applied
// idempotently on every boot — fine for a single-user local server.
// The path is read lazily (here, not at module load) so a test can point
// COMMS_DB_PATH at a throwaway DB before the first getDb() call.
function dbPath(): string {
  return process.env.COMMS_DB_PATH ?? resolve(process.cwd(), "data", "memory.sqlite");
}

// Bumped whenever a structural (table-rebuild) migration ships. Tracked via
// PRAGMA user_version so each rebuild runs exactly once. v1 = H1b composite PK.
const SCHEMA_VERSION = 1;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const path = dbPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Fresh databases are born with the final (composite-PK / composite-FK)
  // schema below. Databases predating a structural change keep their old
  // tables here (CREATE IF NOT EXISTS no-ops) and are rebuilt by the gated
  // migrations further down.
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
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
      profile_fetched_at TEXT,
      PRIMARY KEY (tenant_id, name)
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      contact_name TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
      proposed_by TEXT NOT NULL DEFAULT 'llm' CHECK (proposed_by IN ('llm', 'user', 'system')),
      confirmed_by_user INTEGER NOT NULL DEFAULT 1 CHECK (confirmed_by_user IN (0, 1)),
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id, contact_name) REFERENCES contacts(tenant_id, name) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_name);

    CREATE TABLE IF NOT EXISTS strategy_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'local',
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

  // Provenance columns. ALTER TABLE with NOT NULL + DEFAULT applies the
  // default to existing rows in SQLite, so this is safe to add late.
  ensureColumn(db, "notes", "proposed_by", "TEXT NOT NULL DEFAULT 'llm'");
  ensureColumn(db, "notes", "confirmed_by_user", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "notes", "confirmed_at", "TEXT");

  // Multi-tenancy (H1): scope every row by tenant. On a pre-H1 DB these add the
  // column to existing rows with the 'local' default; on a fresh DB the CREATE
  // above already declares them, so these no-op. The (tenant_id, name) PRIMARY
  // KEY and matching notes FOREIGN KEY are established by migrateToCompositePk
  // (H1b) for legacy DBs that still carry the old single-column PK.
  ensureColumn(db, "contacts", "tenant_id", "TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, "notes", "tenant_id", "TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, "strategy_log", "tenant_id", "TEXT NOT NULL DEFAULT 'local'");

  // Index on confirmed_by_user is created AFTER the column migration above.
  // On a pre-Phase-7 DB the column doesn't exist until ensureColumn adds it,
  // so creating this index inside the initial CREATE block would crash with
  // "no such column: confirmed_by_user".
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_confirmed ON notes(confirmed_by_user)`);
  // Secondary tenant indexes. Uniqueness of (tenant_id, name) for contacts is
  // provided by the composite PRIMARY KEY, so no separate unique index here.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_tenant ON notes(tenant_id, contact_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_strategy_tenant ON strategy_log(tenant_id)`);

  // H1b: rebuild a legacy single-column-PK contacts table into the composite
  // (tenant_id, name) model. Gated by PRAGMA user_version so it runs once.
  migrateToCompositePk(db);

  return db;
}

/**
 * Test seam: close and drop the cached singleton so the next getDb()
 * reconnects (against a freshly set COMMS_DB_PATH). No-op in production.
 */
export function resetDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function ensureColumn(d: Database.Database, table: string, column: string, type: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * H1b — composite primary key migration.
 *
 * H1 added `tenant_id` as a column but kept `contacts.name` as the single-column
 * PRIMARY KEY, so two tenants could not yet share a contact name. This rebuilds
 * `contacts` with PRIMARY KEY (tenant_id, name) and `notes` with a matching
 * composite FOREIGN KEY (tenant_id, contact_name) → contacts(tenant_id, name)
 * ON DELETE CASCADE. The old FK referenced contacts(name), which stops being a
 * valid FK target the moment `name` alone is no longer unique — so both tables
 * must be rebuilt together. `strategy_log` has no FK and is left as-is.
 *
 * Gated by PRAGMA user_version so it runs once. SQLite can't change a table's
 * primary key in place, so we use the canonical recipe: create *_new tables,
 * copy rows, drop the originals, rename. FK enforcement must be off during the
 * swap, and the foreign_keys pragma is a no-op inside a transaction, so we
 * toggle it outside and wrap the DDL/DML in one atomic transaction.
 */
function migrateToCompositePk(d: Database.Database): void {
  const version = d.pragma("user_version", { simple: true }) as number;
  if (version >= SCHEMA_VERSION) return;

  const pkCols = (
    d.prepare(`PRAGMA table_info(contacts)`).all() as Array<{ name: string; pk: number }>
  )
    .filter((c) => c.pk > 0)
    .map((c) => c.name);
  const isLegacySingleColPk = pkCols.length === 1 && pkCols[0] === "name";

  if (isLegacySingleColPk) {
    d.pragma("foreign_keys = OFF");
    try {
      d.transaction(() => {
        d.exec(`
          CREATE TABLE contacts_new (
            tenant_id TEXT NOT NULL DEFAULT 'local',
            name TEXT NOT NULL,
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
            profile_fetched_at TEXT,
            PRIMARY KEY (tenant_id, name)
          );
          INSERT INTO contacts_new
            (tenant_id, name, first_seen, last_seen, last_thread_url, suggested_followup_at,
             profile_url, headline, role, company, location, about, experience_json,
             education_json, skills_json, profile_fetched_at)
          SELECT
            tenant_id, name, first_seen, last_seen, last_thread_url, suggested_followup_at,
            profile_url, headline, role, company, location, about, experience_json,
            education_json, skills_json, profile_fetched_at
          FROM contacts;
          DROP TABLE contacts;
          ALTER TABLE contacts_new RENAME TO contacts;

          CREATE TABLE notes_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            contact_name TEXT NOT NULL,
            body TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
            proposed_by TEXT NOT NULL DEFAULT 'llm' CHECK (proposed_by IN ('llm', 'user', 'system')),
            confirmed_by_user INTEGER NOT NULL DEFAULT 1 CHECK (confirmed_by_user IN (0, 1)),
            confirmed_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (tenant_id, contact_name) REFERENCES contacts(tenant_id, name) ON DELETE CASCADE
          );
          INSERT INTO notes_new
            (id, tenant_id, contact_name, body, source, proposed_by, confirmed_by_user, confirmed_at, created_at)
          SELECT
            id, tenant_id, contact_name, body, source, proposed_by, confirmed_by_user, confirmed_at, created_at
          FROM notes;
          DROP TABLE notes;
          ALTER TABLE notes_new RENAME TO notes;

          CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_name);
          CREATE INDEX IF NOT EXISTS idx_notes_confirmed ON notes(confirmed_by_user);
          CREATE INDEX IF NOT EXISTS idx_notes_tenant ON notes(tenant_id, contact_name);
        `);
        // Verify referential integrity before committing — runs regardless of
        // the foreign_keys enforcement pragma. A violation rolls the txn back.
        const violations = d.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error(`H1b migration left ${violations.length} FK violation(s)`);
        }
      })();
    } finally {
      d.pragma("foreign_keys = ON");
    }
  }

  d.pragma(`user_version = ${SCHEMA_VERSION}`);
}
