import type { LLMProvider, LLMResult } from "./types.js";

interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number | undefined;
  timeoutMs: number;
}

/**
 * Talk to any OpenAI-compatible Chat Completions endpoint.
 * Verified shape: OpenAI, OpenRouter, Ollama (with /v1 path), LM Studio.
 *
 * The instruction goes in a `system` message and the context (which already
 * contains the UNTRUSTED_CONVERSATION block and voice profile) goes as the
 * `user` message. Putting instruction in `system` gives the model a stronger
 * authority gradient than the data — useful for prompt-injection resistance.
 */
export function createOpenAiCompatProvider(cfg: OpenAICompatConfig): LLMProvider {
  return {
    name: "openai-compat",
    async run(instruction: string, context: string): Promise<LLMResult> {
      const start = Date.now();
      const url = `${cfg.baseUrl}/chat/completions`;

      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: context },
        ],
        stream: false,
      };
      if (cfg.temperature !== undefined) body.temperature = cfg.temperature;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey || "none"}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if ((err as Error).name === "AbortError") {
          throw new Error(`openai-compat timed out after ${cfg.timeoutMs}ms`);
        }
        throw new Error(`openai-compat fetch failed: ${(err as Error).message}`);
      }
      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`openai-compat ${res.status}: ${errText.slice(0, 500)}`);
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = json.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) {
        throw new Error(`openai-compat returned empty content: ${JSON.stringify(json).slice(0, 300)}`);
      }

      return {
        text,
        stderr: "",
        durationMs: Date.now() - start,
      };
    },
  };
}
