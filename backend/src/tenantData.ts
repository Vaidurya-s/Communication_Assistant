/**
 * Per-tenant data lifecycle (H5): portability (export) and erasure (purge).
 *
 * Export returns everything we hold for a tenant in the relational store, for
 * GDPR-style data portability. Purge deletes it — contacts (notes cascade via
 * the composite FK), strategy log, and the tenant's stored LLM config. It does
 * NOT touch filesystem artefacts (voice profile, feedback log, snapshots); the
 * caller handles those, and the local tenant's repo-root voice_profile/ is
 * deliberately never auto-deleted.
 */
import { getDb } from "./db.js";
import { getAllContacts, getNotesFor, type ContactSummary, type Note } from "./memory.js";
import { hasTenantLLM } from "./secrets.js";

export interface ExportedContact extends ContactSummary {
  notes: Note[];
}

export interface StrategyRow {
  id: number;
  contact_name: string;
  read_at: string;
  text: string;
  suggested_followup_at: string | null;
}

export interface TenantExport {
  tenant_id: string;
  exported_at: string;
  contacts: ExportedContact[];
  strategies: StrategyRow[];
  has_llm_config: boolean;
}

/** A complete dump of a tenant's stored data. */
export function exportTenant(tenantId: string, nowIso: string): TenantExport {
  const contacts: ExportedContact[] = getAllContacts(tenantId).map((c) => ({
    ...c,
    // includeUnconfirmed so the export is complete; high limit to take all.
    notes: getNotesFor(tenantId, c.name, { includeUnconfirmed: true, limit: 1_000_000 }),
  }));
  const strategies = getDb()
    .prepare(
      `SELECT id, contact_name, read_at, text, suggested_followup_at
       FROM strategy_log WHERE tenant_id = ? ORDER BY read_at DESC, id DESC`,
    )
    .all(tenantId) as StrategyRow[];
  return {
    tenant_id: tenantId,
    exported_at: nowIso,
    contacts,
    strategies,
    has_llm_config: hasTenantLLM(tenantId),
  };
}

export interface PurgeResult {
  contacts: number;
  notes: number;
  strategies: number;
  llm_config: number;
}

/** Erase all of a tenant's relational data. Atomic. Returns row counts removed. */
export function purgeTenant(tenantId: string): PurgeResult {
  const db = getDb();
  return db.transaction((): PurgeResult => {
    // Count notes before deleting contacts (the FK cascade removes them).
    const notes = (
      db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE tenant_id = ?`).get(tenantId) as {
        n: number;
      }
    ).n;
    const strategies = db.prepare(`DELETE FROM strategy_log WHERE tenant_id = ?`).run(tenantId)
      .changes;
    const contacts = db.prepare(`DELETE FROM contacts WHERE tenant_id = ?`).run(tenantId).changes;
    const llm = db.prepare(`DELETE FROM tenant_secrets WHERE tenant_id = ?`).run(tenantId).changes;
    return { contacts, notes, strategies, llm_config: llm };
  })();
}
