import { getConfig } from "../config.js";
import { createGeminiCliProvider } from "./gemini-cli.js";
import { createOpenAiCompatProvider } from "./openai-compat.js";
import { DEFAULT_TENANT } from "../tenant.js";
import { getTenantLLM } from "../secrets.js";
import type { LLMProvider, LLMResult, LLMRunOptions } from "./types.js";

let provider: LLMProvider | null = null;
// Providers built from a tenant's own stored config (H3), cached per tenant.
const tenantProviders = new Map<string, LLMProvider>();

function getProvider(): LLMProvider {
  if (provider) return provider;
  const cfg = getConfig();
  if (cfg.provider === "openai-compat") {
    if (!cfg.openai.apiKey) {
      console.warn(
        "[llm] OPENAI_API_KEY is empty — local servers (Ollama/LM Studio) accept this; hosted APIs will reject.",
      );
    }
    provider = createOpenAiCompatProvider({
      baseUrl: cfg.openai.baseUrl,
      apiKey: cfg.openai.apiKey,
      model: cfg.openai.model,
      temperature: cfg.openai.temperature,
      timeoutMs: cfg.timeoutMs,
    });
    console.log(`[llm] provider=openai-compat base=${cfg.openai.baseUrl} model=${cfg.openai.model}`);
  } else {
    provider = createGeminiCliProvider(cfg.timeoutMs);
    console.log("[llm] provider=gemini-cli");
  }
  return provider;
}

/**
 * The provider for a tenant's call. The local tenant — and any tenant with no
 * stored config — uses the process-global provider built from .env. A tenant
 * with its own stored config (encrypted key) gets a provider built from that,
 * cached until its secrets change (resetProviderFor).
 */
export function getProviderFor(tenantId: string): LLMProvider {
  if (tenantId === DEFAULT_TENANT) return getProvider();
  const cached = tenantProviders.get(tenantId);
  if (cached) return cached;
  const sec = getTenantLLM(tenantId);
  if (!sec) return getProvider();
  const timeoutMs = getConfig().timeoutMs;
  const built =
    sec.provider === "openai-compat"
      ? createOpenAiCompatProvider({
          baseUrl: sec.baseUrl,
          apiKey: sec.apiKey,
          model: sec.model,
          temperature: sec.temperature,
          timeoutMs,
        })
      : createGeminiCliProvider(timeoutMs);
  tenantProviders.set(tenantId, built);
  return built;
}

export function runLLM(
  instruction: string,
  context: string,
  opts?: LLMRunOptions,
): Promise<LLMResult> {
  return getProviderFor(opts?.tenantId ?? DEFAULT_TENANT).run(instruction, context, opts);
}

/**
 * Drop ALL cached providers (global + per-tenant) so the next call rebuilds
 * from freshly reloaded config/secrets. Paired with config.reloadConfig() by
 * the global settings endpoint.
 */
export function resetProvider(): void {
  provider = null;
  tenantProviders.clear();
}

/** Drop one tenant's cached provider after its stored config changes. */
export function resetProviderFor(tenantId: string): void {
  if (tenantId === DEFAULT_TENANT) provider = null;
  else tenantProviders.delete(tenantId);
}

export function getProviderName(): string {
  return getProvider().name;
}

/** Provider name for a specific tenant (reflects its own config if any). */
export function getProviderNameFor(tenantId: string): string {
  return getProviderFor(tenantId).name;
}

export type { LLMResult, LLMRunOptions };
