import { getDb } from "./db.js";
import type { IncomingContactProfile } from "./prompt.js";

export interface Note {
  id: number;
  contact_name: string;
  body: string;
  source: "auto" | "manual";
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

export function upsertContact(name: string, threadUrl: string | null): void {
  if (!name) return;
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `
    INSERT INTO contacts (name, first_seen, last_seen, last_thread_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      last_seen = excluded.last_seen,
      last_thread_url = COALESCE(excluded.last_thread_url, last_thread_url)
    `,
  ).run(name, now, now, threadUrl);
}

export function getContact(name: string): Contact | null {
  if (!name) return null;
  const row = getDb()
    .prepare(`SELECT * FROM contacts WHERE name = ?`)
    .get(name) as ContactRow | undefined;
  return row ? rowToContact(row) : null;
}

export function getNotesFor(name: string, limit = MAX_NOTES_INJECTED): Note[] {
  if (!name) return [];
  return getDb()
    .prepare(`SELECT * FROM notes WHERE contact_name = ? ORDER BY created_at DESC LIMIT ?`)
    .all(name, limit) as Note[];
}

export function addNote(contactName: string, body: string, source: "auto" | "manual"): number {
  if (!contactName || !body.trim()) {
    throw new Error("contactName and non-empty body required");
  }
  upsertContact(contactName, null);
  const info = getDb()
    .prepare(`INSERT INTO notes (contact_name, body, source) VALUES (?, ?, ?)`)
    .run(contactName, body.trim(), source);
  return Number(info.lastInsertRowid);
}

export function setFollowupAt(contactName: string, iso: string | null): void {
  if (!contactName) return;
  upsertContact(contactName, null);
  getDb()
    .prepare(`UPDATE contacts SET suggested_followup_at = ? WHERE name = ?`)
    .run(iso, contactName);
}

export function recordStrategy(contactName: string, text: string, followupAt: string | null): void {
  if (!contactName || !text.trim()) return;
  getDb()
    .prepare(
      `INSERT INTO strategy_log (contact_name, text, suggested_followup_at) VALUES (?, ?, ?)`,
    )
    .run(contactName, text.trim(), followupAt);
}

/**
 * Persist a fetched LinkedIn profile against a contact. The contact row is
 * created if missing. List-ish fields (experience/education/skills) are
 * stored as JSON; they're attacker-controlled and short, so a JSON blob
 * beats normalized tables for this scale.
 *
 * Idempotent: re-running with the same input overwrites the previous values.
 */
export function upsertProfile(contactName: string, profile: IncomingContactProfile): void {
  if (!contactName) return;
  upsertContact(contactName, null);

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
      WHERE name = ?
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
      contactName,
    );
}
