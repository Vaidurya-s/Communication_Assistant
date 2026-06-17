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
  };
}

// A message's content is a block array; concatenate the text blocks. Drafts are
// text-only (no tools/thinking), so this is the whole reply.
function textOf(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
