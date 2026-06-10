import { getConfig } from "../config.js";
import { createGeminiCliProvider } from "./gemini-cli.js";
import { createOpenAiCompatProvider } from "./openai-compat.js";
import type { LLMProvider, LLMResult } from "./types.js";

let provider: LLMProvider | null = null;

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

export function runLLM(instruction: string, context: string): Promise<LLMResult> {
  return getProvider().run(instruction, context);
}

/**
 * Drop the cached provider so the next runLLM/getProviderName rebuilds it from
 * a freshly reloaded config. Paired with config.reloadConfig() by the settings
 * endpoint to switch provider live.
 */
export function resetProvider(): void {
  provider = null;
}

export function getProviderName(): string {
  return getProvider().name;
}

export type { LLMResult };
