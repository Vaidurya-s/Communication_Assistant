import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, resetDb } from "./db.js";
import { getTenantLLM, setTenantLLM, hasTenantLLM, deleteTenantLLM } from "./secrets.js";

let dir: string;
const SAVED_KEY = process.env.COMMS_SECRET_KEY;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comms-secrets-"));
  process.env.COMMS_DB_PATH = join(dir, "test.sqlite");
  process.env.COMMS_SECRET_KEY = "test-master-secret";
  resetDb();
});
afterEach(() => {
  resetDb();
  delete process.env.COMMS_DB_PATH;
  if (SAVED_KEY === undefined) delete process.env.COMMS_SECRET_KEY;
  else process.env.COMMS_SECRET_KEY = SAVED_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("per-tenant LLM secrets", () => {
  it("returns null when a tenant has no stored config", () => {
    expect(getTenantLLM("acme")).toBeNull();
    expect(hasTenantLLM("acme")).toBe(false);
  });

  it("stores and reads back a tenant's config with a decrypted key", () => {
    setTenantLLM("acme", {
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.4,
      apiKey: "sk-acme-123",
    });
    const cfg = getTenantLLM("acme");
    expect(cfg).toMatchObject({
      provider: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.4,
      apiKey: "sk-acme-123",
    });
  });

  it("stores the key ENCRYPTED at rest (not plaintext)", () => {
    setTenantLLM("acme", {
      provider: "openai-compat",
      baseUrl: "",
      model: "gpt-4o-mini",
      temperature: undefined,
      apiKey: "sk-acme-123",
    });
    const row = getDb()
      .prepare(`SELECT api_key_enc FROM tenant_secrets WHERE tenant_id = 'acme'`)
      .get() as { api_key_enc: string };
    expect(row.api_key_enc).not.toContain("sk-acme-123");
    expect(row.api_key_enc.startsWith("v1.")).toBe(true);
  });

  it("a blank apiKey keeps the previously stored key", () => {
    setTenantLLM("acme", {
      provider: "openai-compat",
      baseUrl: "",
      model: "gpt-4o-mini",
      temperature: undefined,
      apiKey: "sk-first",
    });
    // Update only the model; leave the key blank.
    setTenantLLM("acme", {
      provider: "openai-compat",
      baseUrl: "",
      model: "gpt-4o",
      temperature: undefined,
      apiKey: "",
    });
    const cfg = getTenantLLM("acme");
    expect(cfg?.model).toBe("gpt-4o");
    expect(cfg?.apiKey).toBe("sk-first");
  });

  it("keeps tenants' keys isolated", () => {
    setTenantLLM("a", { provider: "openai-compat", baseUrl: "", model: "m", temperature: undefined, apiKey: "key-a" });
    setTenantLLM("b", { provider: "openai-compat", baseUrl: "", model: "m", temperature: undefined, apiKey: "key-b" });
    expect(getTenantLLM("a")?.apiKey).toBe("key-a");
    expect(getTenantLLM("b")?.apiKey).toBe("key-b");
  });

  it("refuses to store a key without a master secret", () => {
    delete process.env.COMMS_SECRET_KEY;
    expect(() =>
      setTenantLLM("acme", {
        provider: "openai-compat",
        baseUrl: "",
        model: "m",
        temperature: undefined,
        apiKey: "sk-x",
      }),
    ).toThrow(/COMMS_SECRET_KEY/);
  });

  it("allows a keyless config (e.g. gemini-cli) without a master secret", () => {
    delete process.env.COMMS_SECRET_KEY;
    expect(() =>
      setTenantLLM("acme", {
        provider: "gemini-cli",
        baseUrl: "",
        model: "",
        temperature: undefined,
        apiKey: "",
      }),
    ).not.toThrow();
    expect(getTenantLLM("acme")?.provider).toBe("gemini-cli");
  });

  it("deletes a tenant's config", () => {
    setTenantLLM("acme", { provider: "gemini-cli", baseUrl: "", model: "", temperature: undefined, apiKey: "" });
    expect(hasTenantLLM("acme")).toBe(true);
    expect(deleteTenantLLM("acme")).toBe(true);
    expect(getTenantLLM("acme")).toBeNull();
    expect(deleteTenantLLM("acme")).toBe(false);
  });
});
