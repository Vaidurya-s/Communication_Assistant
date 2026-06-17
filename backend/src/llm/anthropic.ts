import Anthropic from "@anthropic-ai/sdk";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { LLMProvider, LLMResult, LLMRunOptions } from "./types.js";

interface AnthropicConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

// Short drafts only — replies are a paragraph or two, never a long document.
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Native Anthropic provider over `@anthropic-ai/sdk`.
 *
 * The point of going native (vs. the openai-compat shim) is prompt caching:
 * `cache_control` is a Messages-API feature that the OpenAI `/chat/completions`
 * shape can't carry. We put the static voice prefix in a `system` block marked
 * `cache_control: {type: "ephemeral"}` so it's cached across drafts on the same
 * thread, and the variable conversation goes in the `user` message after the
 * breakpoint. The mode `instruction` sits in a SECOND system block placed AFTER
 * the cached one, so the breakpoint stays between the stable voice and the
 * variable instruction — changing the mode never invalidates the voice cache.
 *
 * No temperature/top_p/top_k/thinking/effort: the 4.x models reject several of
 * these (Haiku rejects `effort`), and short drafts don't need thinking.
 *
 * Caching caveat (per the model's minimum cacheable prefix): the cached block
 * only actually caches if it clears the model's floor — 4096 tokens on Haiku 4.5
 * / Opus, 2048 on Sonnet 4.6. A short voice profile (~3.7K tokens) may therefore
 * SILENTLY not cache on the default `claude-haiku-4-5`; use `claude-sonnet-4-6`
 * for a guaranteed cache, or let the prefix grow (ABOUT ME context helps). We log
 * `usage.cache_read_input_tokens` after every call so this is verifiable.
 */
export function createAnthropicProvider(cfg: AnthropicConfig): LLMProvider {
  const client = new Anthropic({ apiKey: cfg.apiKey });

  // Build the system/messages payload shared by run() and runStream(). The
  // cacheable prefix is opts.staticPrefix when the caller split the prompt;
  // otherwise we cache the whole `context` as a best-effort fallback and leave
  // the user message empty-but-present (the API requires a user turn).
  function buildPayload(instruction: string, context: string, opts?: LLMRunOptions) {
    const prefix = opts?.staticPrefix ?? context;
    // buildPrompt sets context = staticPrefix + "\n\n" + variable, so when a
    // prefix is supplied we strip it off the user message — otherwise the voice
    // profile would be sent twice (once cached, once uncached, defeating the
    // cache). Fall back to the full context if it doesn't start with the prefix.
    let userText = "";
    if (opts?.staticPrefix) {
      userText = context.startsWith(prefix) ? context.slice(prefix.length).replace(/^\s+/, "") : context;
    }

    const system: TextBlockParam[] = [
      { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
      { type: "text", text: instruction },
    ];

    return {
      model: cfg.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system,
      messages: [{ role: "user" as const, content: userText }],
    };
  }

  function mapError(err: unknown): Error {
    if ((err as Error).name === "AbortError" || err instanceof Anthropic.APIUserAbortError) {
      return new Error(`anthropic timed out after ${cfg.timeoutMs}ms`);
    }
    if (err instanceof Anthropic.APIError) {
      return new Error(`anthropic ${err.status ?? "?"}: ${err.message.slice(0, 500)}`);
    }
    return new Error(`anthropic request failed: ${(err as Error).message}`);
  }

  return {
    name: "anthropic",

    async run(instruction: string, context: string, opts?: LLMRunOptions): Promise<LLMResult> {
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

      try {
        const msg = await client.messages.create(buildPayload(instruction, context, opts), {
          signal: controller.signal,
        });
        logUsage(cfg.model, msg.usage);
        const text = textOf(msg.content).trim();
        if (!text) {
          throw new Error(`anthropic returned empty content (stop_reason=${msg.stop_reason})`);
        }
        return { text, stderr: "", durationMs: Date.now() - start };
      } catch (err) {
        throw mapError(err);
      } finally {
        clearTimeout(timer);
      }
    },

    async runStream(
      instruction: string,
      context: string,
      opts?: LLMRunOptions & { onToken?: (t: string) => void },
    ): Promise<LLMResult> {
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

      try {
        const stream = client.messages.stream(buildPayload(instruction, context, opts), {
          signal: controller.signal,
        });
        if (opts?.onToken) {
          stream.on("text", (delta) => opts.onToken!(delta));
        }
        const msg = await stream.finalMessage();
        logUsage(cfg.model, msg.usage);
        const text = textOf(msg.content).trim();
        if (!text) {
          throw new Error(`anthropic returned empty content (stop_reason=${msg.stop_reason})`);
        }
        return { text, stderr: "", durationMs: Date.now() - start };
      } catch (err) {
        throw mapError(err);
      } finally {
        clearTimeout(timer);
      }
    },

    async warm(opts: LLMRunOptions): Promise<void> {
      const prefix = opts.staticPrefix;
      if (!prefix) return; // nothing stable to cache
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        // max_tokens:1 — we don't want output, only the prefill that writes the
        // prefix into the cache. The system block is byte-identical to the real
        // draft's first block (same text + cache_control), so the first real
        // draft reads this cache instead of re-writing it. The instruction block
        // is omitted: it sits AFTER the breakpoint and never affects the prefix.
        const msg = await client.messages.create(
          {
            model: cfg.model,
            max_tokens: 1,
            system: [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: "warm" }],
          },
          { signal: controller.signal },
        );
        logUsage(cfg.model, msg.usage);
      } catch (err) {
        // Best-effort: a failed warm-up must never break boot or overlay-open.
        console.warn(`[llm:anthropic] warm-up failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// Log token usage, foregrounding the cache fields. `cache_read_input_tokens > 0`
// on a repeat draft for the same thread confirms the voice prefix is being
// served from cache; a persistent 0 means a silent invalidator (or the prefix is
// below the model's minimum cacheable size — see the caching caveat above).
function logUsage(model: string, u: Anthropic.Messages.Usage): void {
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const cacheNote = read === 0 && write === 0 ? " — NOT cached (prefix below the model's min, or invalidated)" : "";
  console.log(
    `[llm:anthropic] model=${model} in=${u.input_tokens} out=${u.output_tokens} cache_write=${write} cache_read=${read}${cacheNote}`,
  );
}

// A message's content is a block array; concatenate the text blocks. Drafts are
// text-only (no tools/thinking), so this is the whole reply.
function textOf(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
