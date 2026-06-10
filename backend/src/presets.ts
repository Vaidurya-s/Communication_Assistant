import type { ProviderName } from "./config.js";

/**
 * Provider presets surfaced in the dashboard's Settings panel. Every hosted or
 * local HTTP option routes through the existing `openai-compat` provider — the
 * only thing that varies is the base URL, the model list, and whether a key is
 * required. `gemini-cli` is the one outlier: a local CLI subprocess, no key,
 * no base URL.
 *
 * Anthropic and Google Gemini are reachable here because both expose an
 * OpenAI-compatible Chat Completions endpoint; we point at those.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  /** Empty for gemini-cli (no HTTP endpoint). */
  baseUrl: string;
  /** Suggested models — the UI lets the user pick or type their own. */
  models: string[];
  keyRequired: boolean;
  provider: ProviderName;
  /** Short hint shown under the picker. */
  note?: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: "gemini-cli",
    label: "Gemini CLI (local, no key)",
    baseUrl: "",
    models: [],
    keyRequired: false,
    provider: "gemini-cli",
    note: "Uses the signed-in `gemini` CLI on this machine. Nothing leaves your computer.",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o4-mini"],
    keyRequired: true,
    provider: "openai-compat",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-3-5-haiku-latest"],
    keyRequired: true,
    provider: "openai-compat",
    note: "Anthropic's OpenAI-compatible endpoint.",
  },
  {
    id: "gemini-api",
    label: "Google Gemini (API)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-pro"],
    keyRequired: true,
    provider: "openai-compat",
    note: "Gemini's OpenAI-compatible endpoint (needs an API key, unlike the CLI).",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "meta-llama/llama-3.1-70b-instruct"],
    keyRequired: true,
    provider: "openai-compat",
    note: "One key, hundreds of models from many providers.",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "mistral-small-latest"],
    keyRequired: true,
    provider: "openai-compat",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    keyRequired: true,
    provider: "openai-compat",
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "mistralai/Mixtral-8x7B-Instruct-v0.1"],
    keyRequired: true,
    provider: "openai-compat",
  },
  {
    id: "ollama",
    label: "Ollama (local, no key)",
    baseUrl: "http://localhost:11434/v1",
    models: ["llama3.1", "qwen2.5", "mistral"],
    keyRequired: false,
    provider: "openai-compat",
    note: "Runs models locally. Start Ollama first.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local, no key)",
    baseUrl: "http://localhost:1234/v1",
    models: [],
    keyRequired: false,
    provider: "openai-compat",
    note: "Runs models locally. Start the LM Studio server first.",
  },
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
