import { getDb } from "./db.js";

export interface Note {
  id: number;
  contact_name: string;
  body: string;
  source: "auto" | "manual";
  created_at: string;
}

export interface Contact {
  name: string;
  first_seen: string;
  last_seen: string;
  last_thread_url: string | null;
  suggested_followup_at: string | null;
}

const MAX_NOTES_INJECTED = 10;

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
  const row = getDb().prepare(`SELECT * FROM contacts WHERE name = ?`).get(name) as Contact | undefined;
  return row ?? null;
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
  // Ensure the contact exists (insert a thin row if needed).
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
