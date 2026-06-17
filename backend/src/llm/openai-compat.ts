import type { LLMProvider, LLMResult, LLMRunOptions } from "./types.js";

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

    /**
     * Streaming variant. Same Chat Completions body as run() but with
     * `stream: true`, consuming the SSE response. openai-compat has no prompt
     * caching, so we ignore opts.staticPrefix and send the full `context` as
     * the user message — identical to run().
     */
    async runStream(
      instruction: string,
      context: string,
      opts?: LLMRunOptions & { onToken?: (t: string) => void },
    ): Promise<LLMResult> {
      const start = Date.now();
      const url = `${cfg.baseUrl}/chat/completions`;

      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: context },
        ],
        stream: true,
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

      if (!res.ok) {
        clearTimeout(timer);
        const errText = await res.text().catch(() => "");
        throw new Error(`openai-compat ${res.status}: ${errText.slice(0, 500)}`);
      }
      if (!res.body) {
        clearTimeout(timer);
        throw new Error(`openai-compat returned no response body`);
      }

      // Read the SSE stream off res.body (a Web Streams ReadableStream under
      // Node 18+ fetch). Each SSE event is a `data: <json>` line; events can
      // split across chunk boundaries, so we buffer partial lines and only
      // process complete ones (up to the last newline) per chunk.
      let text = "";
      try {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        readLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("data:")) continue; // comments / blank lines
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") break readLoop;
            let parsed: { choices?: Array<{ delta?: { content?: string } }> };
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue; // ignore unparseable keep-alive fragments
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              opts?.onToken?.(delta);
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          throw new Error(`openai-compat timed out after ${cfg.timeoutMs}ms`);
        }
        throw new Error(`openai-compat stream failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }

      text = text.trim();
      if (!text) {
        throw new Error(`openai-compat stream returned empty content`);
      }

      return {
        text,
        stderr: "",
        durationMs: Date.now() - start,
      };
    },
  };
}
