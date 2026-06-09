import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader. We don't want a dotenv dependency for a single-file
 * single-purpose use case. Loads KEY=VALUE lines, supports `#` comments,
 * trims whitespace, and strips matched surrounding quotes. ENV vars already
 * set in the shell take precedence — we only fill in missing keys.
 */
function loadDotenv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotenv();

export type ProviderName = "gemini-cli" | "openai-compat";

function parseProvider(raw: string | undefined): ProviderName {
  if (raw === "openai-compat") return "openai-compat";
  return "gemini-cli";
}

function parseInt0(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseFloat0(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

export interface Config {
  provider: ProviderName;
  timeoutMs: number;
  openai: {
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number | undefined;
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  cached = {
    provider: parseProvider(process.env.LLM_PROVIDER),
    timeoutMs: parseInt0(process.env.LLM_TIMEOUT_MS, 180_000),
    openai: {
      baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      apiKey: process.env.OPENAI_API_KEY ?? "",
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: parseFloat0(process.env.OPENAI_TEMPERATURE),
    },
  };
  return cached;
}
