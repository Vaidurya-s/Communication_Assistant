/**
 * Per-tenant LLM configuration store (H3).
 *
 * Each tenant may bring their own provider + API key; the key is encrypted at
 * rest (see secretBox.ts). A tenant with no row here falls back to the
 * process-global provider built from .env (see llm/getProviderFor).
 */
import { getDb } from "./db.js";
import { encryptSecret, decryptSecret, secretsEnabled } from "./secretBox.js";
import type { ProviderName } from "./config.js";

export interface TenantLLMConfig {
  provider: ProviderName;
  baseUrl: string;
  model: string;
  temperature: number | undefined;
  /** Decrypted API key, or "" if none stored. */
  apiKey: string;
  updatedAt?: string;
}

export interface TenantLLMInput {
  provider: ProviderName;
  baseUrl: string;
  model: string;
  temperature: number | undefined;
  /** New plaintext key. Blank → keep the tenant's existing stored key. */
  apiKey: string;
}

interface SecretRow {
  tenant_id: string;
  provider: string;
  base_url: string | null;
  model: string | null;
  temperature: number | null;
  api_key_enc: string | null;
  updated_at: string;
}

/** Read a tenant's LLM config (key decrypted), or null if none is stored. */
export function getTenantLLM(tenantId: string): TenantLLMConfig | null {
  const row = getDb()
    .prepare(`SELECT * FROM tenant_secrets WHERE tenant_id = ?`)
    .get(tenantId) as SecretRow | undefined;
  if (!row) return null;
  let apiKey = "";
  if (row.api_key_enc) {
    try {
      apiKey = decryptSecret(row.api_key_enc);
    } catch (err) {
      // A bad/rotated master key shouldn't crash a request — degrade to "no key".
      console.warn(`[secrets] decrypt failed for tenant '${tenantId}':`, (err as Error).message);
    }
  }
  return {
    provider: row.provider === "openai-compat" ? "openai-compat" : "gemini-cli",
    baseUrl: row.base_url ?? "",
    model: row.model ?? "",
    temperature: row.temperature ?? undefined,
    apiKey,
    updatedAt: row.updated_at,
  };
}

/** True if the tenant has a stored LLM config row. */
export function hasTenantLLM(tenantId: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM tenant_secrets WHERE tenant_id = ?`).get(tenantId);
}

/**
 * Upsert a tenant's LLM config. A non-empty apiKey is encrypted and stored; a
 * blank apiKey keeps whatever key was already stored (so you can change the
 * model without re-entering the key). Storing a key requires COMMS_SECRET_KEY.
 */
export function setTenantLLM(tenantId: string, cfg: TenantLLMInput): void {
  let enc: string | null;
  if (cfg.apiKey) {
    if (!secretsEnabled()) {
      throw new Error("COMMS_SECRET_KEY is not set — cannot store an API key for a tenant");
    }
    enc = encryptSecret(cfg.apiKey);
  } else {
    const existing = getDb()
      .prepare(`SELECT api_key_enc FROM tenant_secrets WHERE tenant_id = ?`)
      .get(tenantId) as { api_key_enc: string | null } | undefined;
    enc = existing?.api_key_enc ?? null;
  }
  getDb()
    .prepare(
      `
      INSERT INTO tenant_secrets (tenant_id, provider, base_url, model, temperature, api_key_enc, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(tenant_id) DO UPDATE SET
        provider    = excluded.provider,
        base_url    = excluded.base_url,
        model       = excluded.model,
        temperature = excluded.temperature,
        api_key_enc = excluded.api_key_enc,
        updated_at  = excluded.updated_at
      `,
    )
    .run(
      tenantId,
      cfg.provider,
      cfg.baseUrl || null,
      cfg.model || null,
      cfg.temperature ?? null,
      enc,
    );
}

/** Remove a tenant's LLM config (revert it to the global provider). */
export function deleteTenantLLM(tenantId: string): boolean {
  return getDb().prepare(`DELETE FROM tenant_secrets WHERE tenant_id = ?`).run(tenantId).changes > 0;
}
