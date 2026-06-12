import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, resetDb } from "./db.js";
import {
  createTenant,
  resolveTenantByToken,
  listTenants,
  deleteTenantToken,
  hashToken,
} from "./auth.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comms-auth-"));
  process.env.COMMS_DB_PATH = join(dir, "test.sqlite");
  resetDb();
});
afterEach(() => {
  resetDb();
  delete process.env.COMMS_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("auth (bearer tokens)", () => {
  it("creates a tenant and resolves its token back to the id", () => {
    const { id, token } = createTenant("acme", "Acme Inc");
    expect(id).toBe("acme");
    expect(token).toMatch(/^cmst_/);
    expect(resolveTenantByToken(token)).toBe("acme");
  });

  it("stores only the token hash, never the plaintext", () => {
    const { token } = createTenant("acme");
    const row = getDb().prepare(`SELECT token_hash FROM tenants WHERE id = 'acme'`).get() as {
      token_hash: string;
    };
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toBe(hashToken(token));
  });

  it("returns null for an unknown or blank token", () => {
    createTenant("acme");
    expect(resolveTenantByToken("cmst_not-a-real-token")).toBeNull();
    expect(resolveTenantByToken("")).toBeNull();
  });

  it("keeps tenants isolated — one token never resolves to another tenant", () => {
    const a = createTenant("a");
    const b = createTenant("b");
    expect(resolveTenantByToken(a.token)).toBe("a");
    expect(resolveTenantByToken(b.token)).toBe("b");
    expect(a.token).not.toBe(b.token);
  });

  it("rejects a duplicate tenant id", () => {
    createTenant("acme");
    expect(() => createTenant("acme")).toThrow(/already exists/);
  });

  it("updates last_seen_at on a successful resolve", () => {
    const { token } = createTenant("acme");
    expect(listTenants()[0].last_seen_at).toBeNull();
    expect(resolveTenantByToken(token)).toBe("acme");
    expect(listTenants()[0].last_seen_at).not.toBeNull();
  });

  it("revokes a token so it no longer resolves", () => {
    const { token } = createTenant("acme");
    expect(deleteTenantToken("acme")).toBe(true);
    expect(resolveTenantByToken(token)).toBeNull();
    expect(deleteTenantToken("acme")).toBe(false); // already gone
  });
});
