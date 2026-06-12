import { getDb } from "./db.js";
import type { IncomingContactProfile } from "./prompt.js";

/**
 * Provenance model for notes.
 *
 *   proposed_by       — who suggested the note
 *     'llm'    : LLM emitted a MEMORY: line (insight pipeline)
 *     'user'   : user typed it directly in the overlay
 *     'system' : reserved for future automated extractors
 *
 *   confirmed_by_user — has the user explicitly affirmed this note?
 *     1 (true)  : the note is trusted; safe to inject back into prompts
 *     0 (false) : the note exists but the user has not signed off on it
 *
 * Today every code path that writes a note sets confirmed_by_user=1
 * (the overlay "Save" click is the trust gate). The column is here so that
 * a future automated extractor — which would propose notes without explicit
 * user approval — can be added without re-plumbing the schema, and so the
 * prompt-injection read path can filter to user-confirmed only with a
 * single WHERE clause.
 *
 * Tenancy (H1): every function takes a `tenantId` as its first argument and
 * every statement is scoped by `tenant_id`, so one tenant can never read or
 * mutate another's data. Single-user installs use the implicit "local" tenant.
 */
export type ProposedBy = "llm" | "user" | "system";

export interface Note {
  id: number;
  contact_name: string;
  body: string;
  source: "auto" | "manual";
  proposed_by: ProposedBy;
  confirmed_by_user: 0 | 1;
  confirmed_at: string | null;
  created_at: string;
}

export interface ContactExperience {
  title: string;
  company: string;
  duration?: string;
}

export interface ContactEducation {
  school: string;
  degree?: string;
}

export interface Contact {
  name: string;
  first_seen: string;
  last_seen: string;
  last_thread_url: string | null;
  suggested_followup_at: string | null;
  profile_url: string | null;
  headline: string | null;
  role: string | null;
  company: string | null;
  location: string | null;
  about: string | null;
  experience: ContactExperience[];
  education: ContactEducation[];
  skills: string[];
  profile_fetched_at: string | null;
}

interface ContactRow {
  name: string;
  first_seen: string;
  last_seen: string;
  last_thread_url: string | null;
  suggested_followup_at: string | null;
  profile_url: string | null;
  headline: string | null;
  role: string | null;
  company: string | null;
  location: string | null;
  about: string | null;
  experience_json: string | null;
  education_json: string | null;
  skills_json: string | null;
  profile_fetched_at: string | null;
}

const MAX_NOTES_INJECTED = 10;

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v as T;
  } catch {
    return fallback;
  }
}

function rowToContact(row: ContactRow): Contact {
  return {
    name: row.name,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    last_thread_url: row.last_thread_url,
    suggested_followup_at: row.suggested_followup_at,
    profile_url: row.profile_url,
    headline: row.headline,
    role: row.role,
    company: row.company,
    location: row.location,
    about: row.about,
    experience: safeJsonParse<ContactExperience[]>(row.experience_json, []),
    education: safeJsonParse<ContactEducation[]>(row.education_json, []),
    skills: safeJsonParse<string[]>(row.skills_json, []),
    profile_fetched_at: row.profile_fetched_at,
  };
}

export function upsertContact(tenantId: string, name: string, threadUrl: string | null): void {
  if (!name) return;
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `
    INSERT INTO contacts (tenant_id, name, first_seen, last_seen, last_thread_url)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, name) DO UPDATE SET
      last_seen = excluded.last_seen,
      last_thread_url = COALESCE(excluded.last_thread_url, last_thread_url)
    `,
  ).run(tenantId, name, now, now, threadUrl);
}

export function getContact(tenantId: string, name: string): Contact | null {
  if (!name) return null;
  const row = getDb()
    .prepare(`SELECT * FROM contacts WHERE tenant_id = ? AND name = ?`)
    .get(tenantId, name) as ContactRow | undefined;
  return row ? rowToContact(row) : null;
}

export interface ContactSummary extends Contact {
  note_count: number;
  unconfirmed_count: number;
}

interface ContactSummaryRow extends ContactRow {
  note_count: number;
  unconfirmed_count: number;
}

/**
 * Every contact for this tenant, newest activity first, with per-contact note
 * counts. Powers the management console's list view. The LEFT JOIN keeps
 * contacts that have no notes yet, and is itself tenant-scoped.
 */
export function getAllContacts(tenantId: string): ContactSummary[] {
  const rows = getDb()
    .prepare(
      `
      SELECT
        c.*,
        COUNT(n.id) AS note_count,
        COALESCE(SUM(CASE WHEN n.confirmed_by_user = 0 THEN 1 ELSE 0 END), 0) AS unconfirmed_count
      FROM contacts c
      LEFT JOIN notes n ON n.contact_name = c.name AND n.tenant_id = c.tenant_id
      WHERE c.tenant_id = ?
      GROUP BY c.name
      ORDER BY c.last_seen DESC
      `,
    )
    .all(tenantId) as ContactSummaryRow[];
  return rows.map((row) => ({
    ...rowToContact(row),
    note_count: Number(row.note_count) || 0,
    unconfirmed_count: Number(row.unconfirmed_count) || 0,
  }));
}

/** Delete a contact and (via ON DELETE CASCADE) all of its notes. */
export function deleteContact(tenantId: string, name: string): boolean {
  if (!name) return false;
  const info = getDb()
    .prepare(`DELETE FROM contacts WHERE tenant_id = ? AND name = ?`)
    .run(tenantId, name);
  return info.changes > 0;
}

/** Delete a single note by id (scoped to the tenant — a foreign id no-ops). */
export function deleteNote(tenantId: string, id: number): boolean {
  if (!Number.isInteger(id)) return false;
  const info = getDb().prepare(`DELETE FROM notes WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
  return info.changes > 0;
}

/** Edit a note's body in place. Rejects an empty body. */
export function updateNote(tenantId: string, id: number, body: string): boolean {
  if (!Number.isInteger(id)) return false;
  const trimmed = body.trim();
  if (!trimmed) throw new Error("note body must be non-empty");
  const info = getDb()
    .prepare(`UPDATE notes SET body = ? WHERE id = ? AND tenant_id = ?`)
    .run(trimmed, id, tenantId);
  return info.changes > 0;
}

interface GetNotesOptions {
  limit?: number;
  /** Default false — only user-confirmed notes are returned. */
  includeUnconfirmed?: boolean;
}

export function getNotesFor(
  tenantId: string,
  name: string,
  opts: GetNotesOptions | number = {},
): Note[] {
  if (!name) return [];
  const options: GetNotesOptions = typeof opts === "number" ? { limit: opts } : opts;
  const limit = options.limit ?? MAX_NOTES_INJECTED;
  const where = options.includeUnconfirmed
    ? `tenant_id = ? AND contact_name = ?`
    : `tenant_id = ? AND contact_name = ? AND confirmed_by_user = 1`;
  return getDb()
    .prepare(`SELECT * FROM notes WHERE ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(tenantId, name, limit) as Note[];
}

/**
 * Write a user-confirmed note. Two flavours:
 *   source='auto'   → originally proposed by the LLM, user clicked Save
 *   source='manual' → user typed and submitted it themselves
 * In both cases confirmed_by_user=1 because the user took a deliberate
 * action. To write an unconfirmed/pending note (future automated path),
 * use proposeNote() instead.
 */
export function addNote(
  tenantId: string,
  contactName: string,
  body: string,
  source: "auto" | "manual",
): number {
  if (!contactName || !body.trim()) {
    throw new Error("contactName and non-empty body required");
  }
  upsertContact(tenantId, contactName, null);
  const proposedBy: ProposedBy = source === "auto" ? "llm" : "user";
  const info = getDb()
    .prepare(
      `INSERT INTO notes (tenant_id, contact_name, body, source, proposed_by, confirmed_by_user, confirmed_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`,
    )
    .run(tenantId, contactName, body.trim(), source, proposedBy);
  return Number(info.lastInsertRowid);
}

/**
 * Write an unconfirmed note — proposed by an automated path (e.g. a future
 * background extractor) and waiting for the user to confirm via the overlay.
 * Returns the new row id; the row will NOT be injected into prompts until
 * confirmNote() is called.
 */
export function proposeNote(
  tenantId: string,
  contactName: string,
  body: string,
  proposedBy: Exclude<ProposedBy, "user"> = "llm",
): number {
  if (!contactName || !body.trim()) {
    throw new Error("contactName and non-empty body required");
  }
  upsertContact(tenantId, contactName, null);
  const info = getDb()
    .prepare(
      `INSERT INTO notes (tenant_id, contact_name, body, source, proposed_by, confirmed_by_user, confirmed_at)
       VALUES (?, ?, ?, 'auto', ?, 0, NULL)`,
    )
    .run(tenantId, contactName, body.trim(), proposedBy);
  return Number(info.lastInsertRowid);
}

/** Promote a previously-proposed note to user-confirmed (tenant-scoped). */
export function confirmNote(tenantId: string, id: number): void {
  getDb()
    .prepare(
      `UPDATE notes SET confirmed_by_user = 1, confirmed_at = datetime('now')
       WHERE id = ? AND tenant_id = ? AND confirmed_by_user = 0`,
    )
    .run(id, tenantId);
}

export function setFollowupAt(tenantId: string, contactName: string, iso: string | null): void {
  if (!contactName) return;
  upsertContact(tenantId, contactName, null);
  getDb()
    .prepare(`UPDATE contacts SET suggested_followup_at = ? WHERE tenant_id = ? AND name = ?`)
    .run(iso, tenantId, contactName);
}

export function recordStrategy(
  tenantId: string,
  contactName: string,
  text: string,
  followupAt: string | null,
): void {
  if (!contactName || !text.trim()) return;
  getDb()
    .prepare(
      `INSERT INTO strategy_log (tenant_id, contact_name, text, suggested_followup_at) VALUES (?, ?, ?, ?)`,
    )
    .run(tenantId, contactName, text.trim(), followupAt);
}

export interface StrategyEntry {
  id: number;
  contact_name: string;
  read_at: string;
  text: string;
  suggested_followup_at: string | null;
}

/** Recent strategic reads for this tenant, newest first. Powers the Activity timeline. */
export function getRecentStrategies(tenantId: string, limit = 50): StrategyEntry[] {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  return getDb()
    .prepare(
      `SELECT id, contact_name, read_at, text, suggested_followup_at
       FROM strategy_log WHERE tenant_id = ? ORDER BY read_at DESC, id DESC LIMIT ?`,
    )
    .all(tenantId, n) as StrategyEntry[];
}

export interface MemoryStats {
  contacts: number;
  notes: number;
  pending_notes: number;
  enriched_profiles: number;
  followups_due: number;
  followups_total: number;
  strategies: number;
}

/** Aggregate counts for the Overview cards, scoped to the tenant. `nowIso` defines "due". */
export function getStats(tenantId: string, nowIso: string): MemoryStats {
  const db = getDb();
  const one = (sql: string, ...args: unknown[]): number => {
    const row = db.prepare(sql).get(...args) as { n: number } | undefined;
    return row ? Number(row.n) || 0 : 0;
  };
  return {
    contacts: one(`SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ?`, tenantId),
    notes: one(`SELECT COUNT(*) AS n FROM notes WHERE tenant_id = ?`, tenantId),
    pending_notes: one(
      `SELECT COUNT(*) AS n FROM notes WHERE tenant_id = ? AND confirmed_by_user = 0`,
      tenantId,
    ),
    enriched_profiles: one(
      `SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ? AND profile_fetched_at IS NOT NULL`,
      tenantId,
    ),
    followups_due: one(
      `SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ? AND suggested_followup_at IS NOT NULL AND suggested_followup_at <= ?`,
      tenantId,
      nowIso,
    ),
    followups_total: one(
      `SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ? AND suggested_followup_at IS NOT NULL`,
      tenantId,
    ),
    strategies: one(`SELECT COUNT(*) AS n FROM strategy_log WHERE tenant_id = ?`, tenantId),
  };
}

/**
 * Persist a fetched LinkedIn profile against a contact. The contact row is
 * created if missing. List-ish fields (experience/education/skills) are
 * stored as JSON; they're attacker-controlled and short, so a JSON blob
 * beats normalized tables for this scale.
 *
 * Idempotent: re-running with the same input overwrites the previous values.
 */
export function upsertProfile(
  tenantId: string,
  contactName: string,
  profile: IncomingContactProfile,
): void {
  if (!contactName) return;
  upsertContact(tenantId, contactName, null);

  const experience = JSON.stringify(profile.experience ?? []);
  const education = JSON.stringify(profile.education ?? []);
  const skills = JSON.stringify(profile.skills ?? []);

  getDb()
    .prepare(
      `
      UPDATE contacts SET
        profile_url        = COALESCE(?, profile_url),
        headline           = COALESCE(NULLIF(?, ''), headline),
        role               = COALESCE(NULLIF(?, ''), role),
        company            = COALESCE(NULLIF(?, ''), company),
        location           = COALESCE(NULLIF(?, ''), location),
        about              = COALESCE(NULLIF(?, ''), about),
        experience_json    = ?,
        education_json     = ?,
        skills_json        = ?,
        profile_fetched_at = COALESCE(?, profile_fetched_at)
      WHERE tenant_id = ? AND name = ?
      `,
    )
    .run(
      profile.profileUrl ?? null,
      profile.headline ?? "",
      profile.role ?? "",
      profile.company ?? "",
      profile.location ?? "",
      profile.about ?? "",
      experience,
      education,
      skills,
      profile.fetchedAt ?? new Date().toISOString(),
      tenantId,
      contactName,
    );
}
