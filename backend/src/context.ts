import { getDb } from "./db.js";

/**
 * Personal-context layer ("ABOUT ME").
 *
 * Trusted facts about the *user* — projects, achievements, bio, and what they're
 * looking for — that later feed a trusted "ABOUT ME" block in the prompt (parallel
 * to the confirmed-memory block). Unlike contact notes, these describe the user
 * themselves, but the trust model is identical:
 *
 *   confirmed — has the user signed off on this item?
 *     1 (true)  : trusted; safe to inject into prompts.
 *     0 (false) : proposed (e.g. auto-inferred from the user's LinkedIn) and
 *                 waiting on confirmation. Stays out of prompts until confirmed.
 *
 * Today the manual create path defaults confirmed=1 (the user typed it). The
 * column is here so a future auto-import path can land items as proposed without
 * re-plumbing, and so the prompt read path (`getConfirmedContext`) filters to
 * trusted-only with a single WHERE clause.
 *
 * Tenancy (H1): every function takes a `tenantId` as its first argument and every
 * statement is scoped by `tenant_id`, so one tenant can never read or mutate
 * another's data. Single-user installs use the implicit "local" tenant.
 */
export type ContextType = "project" | "achievement" | "bio" | "looking_for";

const VALID_TYPES: readonly ContextType[] = ["project", "achievement", "bio", "looking_for"];

export interface ContextItem {
  id: number;
  type: ContextType;
  title: string;
  body: string;
  /** Parsed from the comma-separated `tags` column; [] when absent. */
  tags: string[];
  confirmed: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface ContextRow {
  id: number;
  type: ContextType;
  title: string;
  body: string;
  tags: string | null;
  confirmed: 0 | 1;
  created_at: string;
  updated_at: string;
}

/** Split the stored comma-separated `tags` column into a trimmed, non-empty list. */
function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Normalize a caller-supplied tag list back into the comma-separated storage form. */
function serializeTags(tags: string[] | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  const cleaned = tags.map((t) => t.trim()).filter((t) => t.length > 0);
  return cleaned.length ? cleaned.join(",") : null;
}

function rowToContextItem(row: ContextRow): ContextItem {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    tags: parseTags(row.tags),
    confirmed: row.confirmed,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface NewContextItem {
  type: ContextType;
  title: string;
  body: string;
  tags?: string[];
  /** Default 1 (user-authored, trusted). Pass 0 for an auto-proposed item. */
  confirmed?: 0 | 1;
}

/**
 * Create a context item. Manual callers leave `confirmed` unset (defaults to 1,
 * trusted); an auto-import path passes confirmed=0 to land it as proposed.
 * Rejects an invalid type or an empty title/body. Returns the new row id.
 */
export function addContextItem(tenantId: string, item: NewContextItem): number {
  if (!VALID_TYPES.includes(item.type)) {
    throw new Error(`invalid context type: ${String(item.type)}`);
  }
  const title = item.title.trim();
  const body = item.body.trim();
  if (!title || !body) {
    throw new Error("context item requires a non-empty title and body");
  }
  const confirmed: 0 | 1 = item.confirmed === 0 ? 0 : 1;
  const info = getDb()
    .prepare(
      `INSERT INTO context_items (tenant_id, type, title, body, tags, confirmed)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(tenantId, item.type, title, body, serializeTags(item.tags), confirmed);
  return Number(info.lastInsertRowid);
}

interface GetContextOptions {
  type?: ContextType;
  /** Default false — only confirmed items are returned. */
  includeUnconfirmed?: boolean;
}

/**
 * Context items for this tenant, newest first. By default returns confirmed
 * items only; pass `includeUnconfirmed` to include proposed ones, and `type`
 * to restrict to a single category.
 */
export function getContextItems(tenantId: string, opts: GetContextOptions = {}): ContextItem[] {
  const clauses = ["tenant_id = ?"];
  const args: unknown[] = [tenantId];
  if (opts.type) {
    clauses.push("type = ?");
    args.push(opts.type);
  }
  if (!opts.includeUnconfirmed) {
    clauses.push("confirmed = 1");
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM context_items WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC`,
    )
    .all(...args) as ContextRow[];
  return rows.map(rowToContextItem);
}

/**
 * Confirmed-only context for this tenant — what the prompt's ABOUT ME block
 * injects. Proposed items are excluded until `confirmContextItem` promotes them.
 */
export function getConfirmedContext(tenantId: string): ContextItem[] {
  return getContextItems(tenantId, { includeUnconfirmed: false });
}

export interface ContextUpdate {
  title?: string;
  body?: string;
  tags?: string[];
}

/**
 * Edit an item's title/body/tags in place, bumping `updated_at`. Only the
 * provided fields change. Rejects an empty title/body when one is supplied.
 * Tenant-scoped — a foreign id no-ops and returns false.
 */
export function updateContextItem(tenantId: string, id: number, patch: ContextUpdate): boolean {
  if (!Number.isInteger(id)) return false;

  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error("context item title must be non-empty");
    sets.push("title = ?");
    args.push(title);
  }
  if (patch.body !== undefined) {
    const body = patch.body.trim();
    if (!body) throw new Error("context item body must be non-empty");
    sets.push("body = ?");
    args.push(body);
  }
  if (patch.tags !== undefined) {
    sets.push("tags = ?");
    args.push(serializeTags(patch.tags));
  }
  if (sets.length === 0) return false;

  sets.push("updated_at = datetime('now')");
  args.push(id, tenantId);
  const info = getDb()
    .prepare(`UPDATE context_items SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`)
    .run(...args);
  return info.changes > 0;
}

/** Delete a single context item by id (scoped to the tenant — a foreign id no-ops). */
export function deleteContextItem(tenantId: string, id: number): boolean {
  if (!Number.isInteger(id)) return false;
  const info = getDb()
    .prepare(`DELETE FROM context_items WHERE id = ? AND tenant_id = ?`)
    .run(id, tenantId);
  return info.changes > 0;
}

/**
 * Promote a previously-proposed item to confirmed (and bump `updated_at`).
 * Tenant-scoped and a no-op on an already-confirmed item; returns true only
 * when a proposed row was actually promoted.
 */
export function confirmContextItem(tenantId: string, id: number): boolean {
  if (!Number.isInteger(id)) return false;
  const info = getDb()
    .prepare(
      `UPDATE context_items SET confirmed = 1, updated_at = datetime('now')
       WHERE id = ? AND tenant_id = ? AND confirmed = 0`,
    )
    .run(id, tenantId);
  return info.changes > 0;
}
