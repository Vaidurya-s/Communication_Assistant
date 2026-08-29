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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_TENANT } from "./tenant.js";
import { voiceDirFor } from "./voiceProfile.js";
import type { RetrievableItem } from "./contextRetrieval.js";

/**
 * The default corpus filename. Deliberately the SAME file the gemini sandbox
 * exposes (`workspace.ts`) — one corpus, two delivery mechanisms, so the user
 * maintains a single file and every provider benefits from it.
 */
const DEFAULT_CORPUS_FILE = "linkedin_successful_messages.md";

/**
 * Per-platform corpus files. A LinkedIn DM and an email are different registers
 * (see PLATFORM_REGISTER in prompt.ts), so showing email examples when drafting
 * an email beats showing DM examples.
 *
 * The fallback is the LinkedIn file rather than nothing: a user who has only
 * ever curated the original corpus should still get grounded examples on Gmail —
 * imperfect-register examples beat none — until they build a Gmail corpus. The
 * default install therefore behaves exactly as before.
 */
function corpusFileFor(platform?: string): string[] {
  const p = (platform ?? "").toLowerCase();
  if (!p || p === "linkedin") return [DEFAULT_CORPUS_FILE];
  return [`${p}_successful_messages.md`, DEFAULT_CORPUS_FILE];
}

/** `type` stamped on every parsed item, so callers can tell these apart from context items. */
const EXCHANGE_TYPE = "exchange";

export interface CorpusExchange extends RetrievableItem {
  type: typeof EXCHANGE_TYPE;
}

/** Cached parse, keyed by resolved file path. Invalidated on mtime+size change. */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  items: CorpusExchange[];
}
const cache = new Map<string, CacheEntry>();

/**
 * Absolute path to the corpus a tenant should use for this platform: the
 * platform-specific file if it exists, else the default LinkedIn one. Returns
 * the default path even when nothing exists, so callers get a stable path to
 * report or write to.
 */
export function corpusPath(tenantId: string = DEFAULT_TENANT, platform?: string): string {
  const dir = voiceDirFor(tenantId);
  const candidates = corpusFileFor(platform);
  for (const name of candidates) {
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  return join(dir, candidates[candidates.length - 1]);
}

/**
 * Where a NEW exchange for this platform should be written.
 *
 * Deliberately different from `corpusPath`: reading falls back to the LinkedIn
 * corpus so a user with only that file still gets examples everywhere, but
 * writing must never follow that fallback — a Gmail exchange appended into
 * `linkedin_successful_messages.md` would pollute the LinkedIn corpus with the
 * wrong register and could never be separated out again.
 */
export function corpusWritePath(tenantId: string = DEFAULT_TENANT, platform?: string): string {
  return join(voiceDirFor(tenantId), corpusFileFor(platform)[0]);
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
    // Section separators and HTML comments are formatting, not content. The
    // comment case matters: the managed reply-rate block below is delimited by
    // them, and without this its opening marker would land in the body of
    // whatever section precedes it.
    if (title !== null && !/^---+\s*$/.test(line) && !/^\s*<!--.*-->\s*$/.test(line)) {
      body.push(line);
    }
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
export function loadCorpusExchanges(
  tenantId: string = DEFAULT_TENANT,
  platform?: string,
): CorpusExchange[] {
  const path = corpusPath(tenantId, platform);
  if (!existsSync(path)) return [];

  try {
    const { mtimeMs, size } = statSync(path);
    // Keyed by resolved PATH, not tenant: one tenant can now have a LinkedIn and
    // a Gmail corpus, and keying by tenant alone would serve one for the other.
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.items;

    const items = parseCorpus(readFileSync(path, "utf-8"));
    cache.set(path, { mtimeMs, size, items });
    return items;
  } catch {
    // Unreadable corpus (permissions, mid-write truncation) — same as absent.
    return [];
  }
}

/**
 * Drop cached parses. Pass a resolved path (from `corpusPath`) to drop one file;
 * pass nothing to clear everything. Called after a corpus is written, and when a
 * tenant's voice directory is rewritten.
 */
export function resetCorpusCache(path?: string): void {
  if (path) cache.delete(path);
  else cache.clear();
}

// ---------------------------------------------------------------------------
// Writing: closing the loop
// ---------------------------------------------------------------------------
//
// Until now this corpus was read by four subsystems (the few-shot injection
// here, voiceDistill, initVoice, voiceEval) and written by none — a hand-typed
// file that shaped every draft and quietly went stale.
//
// TRUST: appends are USER-REVIEWED, never automatic. `prompt.ts` injects these
// exchanges outside the untrusted boundary, and that is defensible only because
// a human looked at the text before it was written. The overlay shows the
// exchange in an editable box and the user presses Add — the same gate shape as
// the memory card's Save. Do not add a code path that appends without it.

/** One exchange turn, as reviewed by the user. */
export interface ExchangeTurn {
  isSelf: boolean;
  text: string;
}

export interface NewExchange {
  /** The other party's display name. */
  contact: string;
  /** Short parenthetical for the heading, e.g. "cold outreach about PQC". */
  context?: string;
  turns: ExchangeTurn[];
  /** Optional grouping label, used for the per-tag reply rates. */
  tag?: string;
}

const CORPUS_HEADER = [
  "# Successful messages",
  "",
  "Real exchanges of mine that got replies. `corpus.ts` retrieves the most",
  "on-topic few of these into each draft, and `init-voice` distills them.",
  "Entries added from the overlay are reviewed before they land here.",
  "",
].join("\n");

const STATS_OPEN = "<!-- comms:auto-stats -->";
const STATS_CLOSE = "<!-- /comms:auto-stats -->";

/** Render one exchange in exactly the shape `parseCorpus` reads back. */
function renderExchange(entry: NewExchange, nowIso: string): string {
  const contact = entry.contact.replace(/\s+/g, " ").trim() || "Unknown";
  const context = (entry.context ?? "").replace(/\s+/g, " ").trim();
  const day = nowIso.slice(0, 10);

  const lines: string[] = ["", `## ${contact} (${context ? `${context}, ` : ""}added ${day})`, ""];
  if (entry.tag) lines.push(`- tags: ${entry.tag.replace(/\s+/g, " ").trim()}`, "");

  for (const turn of entry.turns) {
    const body = turn.text.replace(/\r/g, "").trim();
    if (!body) continue;
    lines.push(turn.isSelf ? `**Me → ${contact}:**` : `**${contact} → Me:**`);
    // Blockquote every line so a multi-paragraph turn stays inside that turn,
    // and so the section satisfies isTranscribedExchange on the quotes alone.
    for (const l of body.split("\n")) lines.push(`> ${l}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Did both parties speak in this section? That is the reply test.
 *
 * Deliberately name-agnostic: it counts DISTINCT senders on the attribution
 * lines rather than looking for the user's own name. The hand-written half of
 * the corpus attributes turns as "Vaidurya → Chitra" while appended entries use
 * "Me → Chitra", and a rule keyed to either would silently miscount the other.
 */
function gotReply(body: string): boolean {
  const senders = new Set<string>();
  for (const line of body.split("\n")) {
    const m = /^\s*\*\*\s*([^→*]+?)\s*→/.exec(line);
    if (m) senders.add(m[1].trim().toLowerCase());
  }
  return senders.size >= 2;
}

function tagOf(body: string): string | null {
  const m = /^\s*-\s*tags:\s*(.+)$/im.exec(body);
  return m ? m[1].trim() : null;
}

/** Strip the managed block, leaving the user's own prose untouched. */
function stripStats(markdown: string): string {
  const open = markdown.indexOf(STATS_OPEN);
  if (open === -1) return markdown;
  const close = markdown.indexOf(STATS_CLOSE, open);
  if (close === -1) return markdown;
  return markdown.slice(0, open) + markdown.slice(close + STATS_CLOSE.length);
}

/**
 * Recompute the reply-rate block from the corpus itself.
 *
 * These numbers used to be tallied by hand in the file and read by nothing, so
 * they drifted the moment anything was added. The block is delimited by HTML
 * comments and rewritten wholesale; everything outside the markers is the
 * user's and is never touched.
 */
export function renderStats(markdown: string): string {
  const items = parseCorpus(markdown);
  const total = items.length;
  const replied = items.filter((i) => gotReply(i.body)).length;

  const byTag = new Map<string, { n: number; replied: number }>();
  for (const item of items) {
    const tag = tagOf(item.body);
    if (!tag) continue;
    const e = byTag.get(tag) ?? { n: 0, replied: 0 };
    e.n += 1;
    if (gotReply(item.body)) e.replied += 1;
    byTag.set(tag, e);
  }

  const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((a / b) * 100)}%`);
  const lines = [
    STATS_OPEN,
    "",
    "## Reply rates (computed)",
    "",
    `- overall: ${replied}/${total} exchanges got a reply (${pct(replied, total)})`,
  ];
  for (const [tag, e] of Array.from(byTag.entries()).sort((a, b) => b[1].n - a[1].n)) {
    lines.push(`- \`${tag}\`: ${e.replied}/${e.n} (${pct(e.replied, e.n)})`);
  }
  lines.push(
    "",
    "_Generated by Comms Assistant. Edits inside this block are overwritten;_",
    "_anything outside the markers is yours and is never touched._",
    "",
    STATS_CLOSE,
  );
  return lines.join("\n");
}

/**
 * Append a user-reviewed exchange and refresh the computed stats.
 *
 * Returns the path written, so the caller can report it.
 */
export function appendExchange(
  tenantId: string = DEFAULT_TENANT,
  entry: NewExchange,
  nowIso: string = new Date().toISOString(),
  platform?: string,
): string {
  if (!entry.contact?.trim()) throw new Error("contact is required");
  if (!entry.turns?.some((t) => t.text?.trim())) {
    throw new Error("at least one non-empty turn is required");
  }

  const path = corpusWritePath(tenantId, platform);
  mkdirSync(dirname(path), { recursive: true });

  const existing = existsSync(path) ? readFileSync(path, "utf-8") : CORPUS_HEADER;
  const body = stripStats(existing).replace(/\s+$/, "");
  const next = `${body}\n${renderExchange(entry, nowIso)}`;
  writeFileSync(path, `${next}\n${renderStats(next)}\n`, "utf-8");

  resetCorpusCache(path);
  return path;
}
