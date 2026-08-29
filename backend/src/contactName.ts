/**
 * Contact-name hygiene.
 *
 * Contact names come from scraped DOM — a thread title, a message-group header —
 * and extraction sometimes swallows the interface around them. A real row in the
 * live database reads:
 *
 *     "Divyanshu Gupta Status is reachable Mobile • 10h"
 *
 * That name is the composite primary key for `contacts`, the foreign key on
 * every note, the label in the dashboard, and — once cross-conversation patterns
 * turn it into a proposal body — text that can end up inside a prompt. Nothing
 * validated it on the way in, so it had been wrong for months.
 *
 * Pure: no db, no fs. The db layer applies it at the write boundary
 * (`memory.ts`), the migration in `db.ts` applies it to rows already stored, and
 * `memoryPatterns.ts` applies it again on the way out as defence in depth.
 */

/** Nobody's display name is longer than this; past it we're into scraped chrome. */
export const MAX_NAME_LEN = 60;

/**
 * Trailing interface text that thread-title extraction sometimes swallows.
 * The bullet separator and the presence wording never occur inside a person's
 * name, which makes them a safe place to cut.
 *
 * Kept deliberately narrow. Over-matching here would corrupt legitimate names
 * (people really are called "Active", and titles really do contain "is"), and a
 * mangled name is worse than a slightly untidy one — it becomes a duplicate
 * contact whose notes are stranded on the wrong row.
 */
const TRAILING_CHROME =
  /\s*(?:[•·]|\bstatus is\b|\bis reachable\b|\bactive now\b|\bonline now\b).*$/i;

/**
 * Normalise a scraped contact name.
 *
 * Collapses whitespace (including the newlines an inline scrape leaves behind),
 * strips trailing UI chrome, and caps the length. Returns "" for input that is
 * empty or entirely chrome — callers treat that as "no name", which is already
 * their existing no-op path (`upsertContact` returns early on a falsy name).
 */
export function sanitizeContactName(raw: string | null | undefined): string {
  if (!raw) return "";
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const stripped = collapsed.replace(TRAILING_CHROME, "").trim();
  // If stripping removed everything, the "chrome" was the whole string and our
  // pattern was wrong about it — keep the collapsed original rather than
  // silently dropping the contact.
  const kept = stripped || collapsed;
  return kept.slice(0, MAX_NAME_LEN).trim();
}

/** Does this stored name differ from its normalised form? */
export function isPollutedName(raw: string): boolean {
  return sanitizeContactName(raw) !== raw;
}
