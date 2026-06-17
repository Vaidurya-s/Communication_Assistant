/**
 * Contact-matched context retrieval (voice-onboarding-plan §6, §16 unlock #1).
 *
 * When the user has accumulated many "ABOUT ME" context items
 * (projects/achievements/bio/looking_for), dumping all of them into the prompt
 * makes every reply read like a humble-brag and dilutes signal. Instead we pick
 * only the few items MOST RELEVANT to the current contact/conversation. This is
 * the highest quality-per-effort lever, especially for cold-open first messages.
 *
 * This module is intentionally PURE: no db, no LLM, no fs. The caller builds a
 * `signalText` (the contact's profile fields + recent conversation) and passes
 * the confirmed context items through `selectRelevantContext`. The ranking is a
 * lightweight lexical term-overlap score — cheap, deterministic, dependency-free,
 * and good enough to keep the on-topic items and drop the off-topic ones. A
 * smarter embedding-based pass can replace the internals later without changing
 * the signature.
 */

/**
 * The structural subset of `ContextItem` (see context.ts) that ranking needs.
 * Declared as a subset so callers can pass `ContextItem[]` directly without any
 * mapping — extra fields (id, confirmed, timestamps) just ride along via the
 * generic `T`.
 */
export interface RetrievableItem {
  type: string;
  title: string;
  body: string;
  tags?: string[];
}

/**
 * A small, deliberately conservative stopword set. We only strip the most common
 * function words so that genuine signal terms (even fairly generic ones) survive.
 * Kept short on purpose — over-aggressive stopwords hurt recall more than a few
 * noise words hurt precision here.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "yours", "with",
  "this", "that", "these", "those", "from", "have", "has", "had", "was", "were",
  "will", "would", "can", "could", "should", "into", "out", "our", "their",
  "they", "them", "his", "her", "its", "who", "what", "when", "where", "which",
  "how", "why", "all", "any", "more", "most", "some", "such", "than", "then",
  "about", "also", "been", "being", "over", "very", "just", "like", "get",
]);

/** Minimum token length kept — drops 1- and 2-char fragments ("a", "to", "go"…). */
const MIN_TOKEN_LEN = 3;

/**
 * Tokenize a string into lowercased word terms: split on any non-alphanumeric
 * run, lowercase, drop tokens shorter than `MIN_TOKEN_LEN`, and drop stopwords.
 * Exported because tests (and callers) find it handy to inspect the term set.
 * Note: tokens may repeat — callers that want a term *set* should wrap in `Set`.
 */
export function tokenize(s: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
}

/** A distinct-term set for an arbitrary piece of text. */
function termSet(s: string): Set<string> {
  return new Set(tokenize(s));
}

/**
 * Light boost applied to overlap found in an item's title/tags vs. its body.
 * Title and tags are curated, high-signal fields, so a match there is a stronger
 * relevance indicator than an incidental body match. Kept small so body matches
 * still meaningfully contribute.
 */
const TITLE_TAG_WEIGHT = 1.5;
const BODY_WEIGHT = 1;

/**
 * Score one item against the signal's term set.
 *
 * We split the item into a high-signal field set (title + tags) and a body set,
 * then count DISTINCT item-terms that appear in the signal — i.e. a set
 * intersection size — weighting the high-signal fields above the body. A term
 * present in both title and body is counted once at the higher weight (the
 * body contribution for an already-matched term is skipped) so the boost is a
 * true "where did it match" weighting rather than double-counting.
 */
function scoreItem(item: RetrievableItem, signalTerms: Set<string>): number {
  const tagText = item.tags && item.tags.length ? item.tags.join(" ") : "";
  const titleTagTerms = termSet(`${item.title} ${tagText}`);
  const bodyTerms = termSet(item.body);

  let score = 0;
  for (const term of titleTagTerms) {
    if (signalTerms.has(term)) score += TITLE_TAG_WEIGHT;
  }
  for (const term of bodyTerms) {
    // Skip terms already credited via title/tags so a repeated term isn't
    // counted twice; it keeps the higher weight from the loop above.
    if (titleTagTerms.has(term)) continue;
    if (signalTerms.has(term)) score += BODY_WEIGHT;
  }
  return score;
}

export interface SelectOptions {
  /** Max items to return. Default 4. */
  max?: number;
}

const DEFAULT_MAX = 4;

/**
 * Select the items MOST RELEVANT to `signalText`, capped at `opts.max` (default 4).
 *
 * Behavior:
 *  - If `items.length <= max`, return them all in input order (no point ranking).
 *  - Otherwise score each item by weighted term overlap with the signal (see
 *    `scoreItem`) and return the top `max` by score DESCENDING. Ties are stable:
 *    items with equal score keep their original relative order.
 *  - Zero-overlap items can still fill the result up to `max`, but only after all
 *    positive-score items — sorting by (score desc, original index) then slicing
 *    `max` achieves exactly this.
 *
 * Always returns a subset of `items` (never synthesizes items) and never returns
 * more than `max`. Generic over `T` so the caller's full `ContextItem` fields
 * pass through untouched.
 */
export function selectRelevantContext<T extends RetrievableItem>(
  items: T[],
  signalText: string,
  opts: SelectOptions = {},
): T[] {
  const max = opts.max ?? DEFAULT_MAX;

  // Nothing to trim — return a fresh array in original order.
  if (max <= 0) return [];
  if (items.length <= max) return items.slice();

  const signalTerms = termSet(signalText);

  // Decorate with score + original index, sort by (score desc, index asc) for a
  // stable top-k, then strip the decoration.
  const ranked = items
    .map((item, index) => ({ item, index, score: scoreItem(item, signalTerms) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  return ranked.slice(0, max).map((r) => r.item);
}
