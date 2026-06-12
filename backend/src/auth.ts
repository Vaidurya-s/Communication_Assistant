/**
 * Bearer-token tenant authentication (H2).
 *
 * Each non-local tenant has a long random API token. We persist ONLY the
 * SHA-256 hash of the token (never the token itself), so a database leak does
 * not expose usable credentials. The plaintext token is shown exactly once, at
 * creation time (by the `tenant` CLI), and is unrecoverable thereafter.
 *
 * A request authenticates by sending `Authorization: Bearer <token>`; the
 * server hashes it and looks up the matching tenant. The implicit 'local'
 * tenant has no token and is used by unauthenticated requests in local mode
 * (see Config.requireAuth).
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db.js";

const TOKEN_PREFIX = "cmst_";

/** SHA-256 hex of a token. Deterministic, so we can look up by hash. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A fresh, high-entropy token (prefix + 32 random bytes, URL-safe). */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export interface TenantRecord {
  id: string;
  label: string | null;
  created_at: string;
  last_seen_at: string | null;
}

/**
 * Create a tenant and return its one-time plaintext token. Throws if the id is
 * blank or already taken. The token is NOT stored — only its hash is — so the
 * returned value is the only chance to capture it.
 */
export function createTenant(id: string, label?: string): { id: string; token: string } {
  const tid = id.trim();
  if (!tid) throw new Error("tenant id required");
  if (getDb().prepare(`SELECT 1 FROM tenants WHERE id = ?`).get(tid)) {
    throw new Error(`tenant '${tid}' already exists`);
  }
  const token = generateToken();
  getDb()
    .prepare(
      `INSERT INTO tenants (id, token_hash, label, created_at) VALUES (?, ?, ?, datetime('now'))`,
    )
    .run(tid, hashToken(token), label?.trim() || null);
  return { id: tid, token };
}

/**
 * Resolve a presented bearer token to a tenant id, or null if it matches no
 * tenant. Touches last_seen_at on a hit (cheap audit trail / liveness signal).
 */
export function resolveTenantByToken(token: string): string | null {
  if (!token) return null;
  const row = getDb()
    .prepare(`SELECT id FROM tenants WHERE token_hash = ?`)
    .get(hashToken(token)) as { id: string } | undefined;
  if (!row) return null;
  getDb().prepare(`UPDATE tenants SET last_seen_at = datetime('now') WHERE id = ?`).run(row.id);
  return row.id;
}

/** All tenants (without token material), oldest first. For the CLI / admin view. */
export function listTenants(): TenantRecord[] {
  return getDb()
    .prepare(`SELECT id, label, created_at, last_seen_at FROM tenants ORDER BY created_at, id`)
    .all() as TenantRecord[];
}

/** Revoke a tenant's token by deleting its auth row. Returns false if unknown. */
export function deleteTenantToken(id: string): boolean {
  const info = getDb().prepare(`DELETE FROM tenants WHERE id = ?`).run(id);
  return info.changes > 0;
}
