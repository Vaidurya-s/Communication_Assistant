/**
 * The successful-messages corpus, as retrievable few-shot examples
 * (ROADMAP.md Track C, C2 — "few-shot grounding for every provider").
 *
 * `voice_profile/linkedin_successful_messages.md` holds the user's real past
 * LinkedIn exchanges. Until now only the `gemini-cli` provider could reach it:
 * the sandbox workspace (`workspace.ts`) copies the file in and the prompt tells
 * the model to Grep it. Every other provider — including the `anthropic` and
 * `openai-compat` ones that are now the default — is a plain HTTP endpoint with
 * no tools, so it got the distilled voice profile and nothing else. That's a
 * real quality gap: the profile describes how the user writes, the corpus SHOWS
 * it, and showing beats telling for voice-matching.
 *
 * This module turns the corpus into `RetrievableItem`s so the caller can rank
 * them with the existing `contextRetrieval.selectRelevantContext` and inject the
 * top few. No new ranker, no embeddings, no new dependency.
 *
 * Like `contextRetrieval.ts` this stays free of db and LLM concerns — it only
 * reads the file and parses it.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TENANT } from "./tenant.js";
import { voiceDirFor } from "./voiceProfile.js";
import type { RetrievableItem } from "./contextRetrieval.js";

/**
 * The corpus filename. Deliberately the SAME file the gemini sandbox exposes
 * (`workspace.ts`) — one corpus, two delivery mechanisms, so the user maintains
 * a single file and every provider benefits from it.
 */
const CORPUS_FILE = "linkedin_successful_messages.md";

/** `type` stamped on every parsed item, so callers can tell these apart from context items. */
const EXCHANGE_TYPE = "exchange";

export interface CorpusExchange extends RetrievableItem {
  type: typeof EXCHANGE_TYPE;
}

/** Cached parse, keyed by tenant. Invalidated on mtime+size change. */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  items: CorpusExchange[];
}
const cache = new Map<string, CacheEntry>();

/** Absolute path to a tenant's corpus file. */
export function corpusPath(tenantId: string = DEFAULT_TENANT): string {
  return join(voiceDirFor(tenantId), CORPUS_FILE);
}

/**
 * Does this section actually contain a transcribed message?
 *
 * The corpus interleaves two kinds of `##` section: real exchanges
 * (`## 3. Yogeshwar Nath Mishra (Professor…)`) and the user's own distilled
 * ANALYSIS of them (`## Punctuation quirks`, `## Openers by audience`,
 * `## Reply rates by template`). Only the first kind is a writing sample.
 *
 * Injecting an analysis section under a header that promises "genuine exchanges
 * I sent" would be false — and worse, redundant: those observations are already
 * compiled into `strategy_analysis.md`, which occupies the prompt's static
 * prefix. So we keep only sections that transcribe an actual message.
 *
 * The discriminator is structural, matching how the file is written: a
 * transcribed exchange carries an attribution arrow (`**Vaidurya → Chitra:**`)
 * or a `>` blockquote of the message text. Analysis sections are plain bullet
 * lists. If a future corpus drops both conventions this filter yields nothing
 * rather than garbage — the section is simply skipped, which is the safe way to
 * be wrong here.
 */
function isTranscribedExchange(body: string): boolean {
  if (body.includes("→")) return true;
  return body.split("\n").some((line) => /^\s*>/.test(line));
}

/**
 * Split the corpus markdown into one item per `## ` section that transcribes a
 * real exchange.
 *
 * The file's real shape is a preamble (title + capture notes) followed by
 * `## 1. <Name> (<context>)` sections, each holding one exchange as blockquotes
 * and inline quotes. We key on the `##` heading level only: `###` (if it ever
 * appears) is detail *within* an exchange and must not start a new item. A `#`
 * heading (the document title, or a `# Part 2 — Deeper Dive` divider partway
 * through) closes the current section without opening one, so its text can't
 * bleed into the previous exchange's body. Content before the first `##` is
 * preamble — provenance metadata, not an example of the user's writing.
 *
 * Exported for tests; `loadCorpusExchanges` is the caching entry point.
 */
export function parseCorpus(markdown: string): CorpusExchange[] {
  const items: CorpusExchange[] = [];
  let title: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (title === null) return;
    const text = body.join("\n").trim();
    // Skip headings with nothing under them, and analysis sections that hold no
    // transcribed message.
    if (text && isTranscribedExchange(text)) {
      items.push({ type: EXCHANGE_TYPE, title, body: text });
    }
    title = null;
    body = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(?!#)(.*)$/.exec(line);
    if (heading) {
      flush();
      // Strip the leading ordinal ("1. ") — it's positional bookkeeping, not
      // signal, and leaving it in only adds a junk token to the ranker.
      title = heading[1].trim().replace(/^\d+\.\s*/, "");
      continue;
    }
    // A top-level heading ends the current section but starts no new one.
    if (/^#\s+(?!#)/.test(line)) {
      flush();
      continue;
    }
    // Section separators are formatting, not content.
    if (title !== null && !/^---+\s*$/.test(line)) body.push(line);
  }
  flush();

  return items;
}

/**
 * Load a tenant's corpus as rankable exchanges.
 *
 * Returns `[]` — never throws — when the file is missing, empty, or unreadable.
 * That case is NORMAL, not exceptional: a fresh clone has no `voice_profile/`
 * (it's gitignored), and a hosted tenant may never upload a corpus at all. The
 * few-shot section is an enhancement, so its absence must degrade the prompt
 * silently rather than fail the draft.
 */
export function loadCorpusExchanges(tenantId: string = DEFAULT_TENANT): CorpusExchange[] {
  const path = corpusPath(tenantId);
  if (!existsSync(path)) return [];

  try {
    const { mtimeMs, size } = statSync(path);
    const hit = cache.get(tenantId);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.items;

    const items = parseCorpus(readFileSync(path, "utf-8"));
    cache.set(tenantId, { mtimeMs, size, items });
    return items;
  } catch {
    // Unreadable corpus (permissions, mid-write truncation) — same as absent.
    return [];
  }
}

/** Drop the cached parse. Called when a tenant's voice directory is rewritten. */
export function resetCorpusCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}
