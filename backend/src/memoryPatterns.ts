/**
 * Cross-conversation memory (ROADMAP.md Track C, C4).
 *
 * Memory today is strictly per contact: notes about Maya only ever inform a
 * reply to Maya. But the corpus of notes and strategy reads, taken together,
 * says things neither one says alone — which topics keep coming up across
 * different people, and how far along each relationship actually is.
 *
 * This module derives both. It is PURE — no db, no LLM, no fs, matching
 * `contextRetrieval.ts`. The caller reads the rows and decides what to do with
 * the proposals; nothing here writes anything.
 *
 * THE TRUST RULE THIS MODULE EXISTS UNDER: `prompt.ts` treats memory notes and
 * ABOUT ME items as trusted instructions, and that is sound ONLY because a user
 * confirmed each one. Everything produced here is machine-derived, so it must
 * enter through the same confirmation gates as anything else — proposed
 * unconfirmed, injected only after the user says yes. See the callers in
 * server.ts. Do not shortcut that: an auto-confirmed pattern would be a second,
 * ungated path into the trusted half of the prompt.
 */

import { tokenize } from "./contextRetrieval.js";
import { sanitizeContactName } from "./contactName.js";

export interface PatternNote {
  contact_name: string;
  body: string;
}

export interface PatternStrategy {
  contact_name: string;
  text: string;
}

export interface PatternInput {
  /** Confirmed notes only — an unconfirmed note is not yet a fact about anything. */
  notes: PatternNote[];
  strategies: PatternStrategy[];
}

/**
 * Conversation-meta vocabulary. These pass `tokenize`'s general stopword filter
 * (they're ordinary content words) but say nothing about what the user actually
 * talks about — every thread contains them. Without this, the top "recurring
 * theme" is reliably "reply" or "message".
 */
const META_TERMS = new Set([
  // Talking-about-talking.
  "reply", "replied", "message", "messages", "note", "notes", "thread", "conversation",
  "asked", "asking", "said", "says", "told", "mentioned", "mention", "discussed",
  "thanks", "thank", "hello", "email", "linkedin", "contact", "connect", "connected",
  "follow", "followed", "followup", "sent", "send", "wrote", "write", "call", "meeting",
  "wants", "want", "interested", "interest", "next", "week", "time", "one", "two",
  // Networking boilerplate. These name the SHAPE of professional outreach
  // rather than its subject — they'd recur across every contact of every user,
  // which is precisely what makes them look like a pattern and precisely why
  // they aren't one.
  "collaboration", "collaborate", "collaborating", "opportunity", "opportunities",
  "potential", "explore", "exploring", "discuss", "discussion", "outline", "gauge",
  "reach", "share", "shared", "sharing", "provide", "request", "requested", "proposed",
  // Hyphen fragments. `tokenize` splits on non-alphanumerics, so "post-quantum"
  // yields a bare "post" that outranks the real term by riding on it.
  "post", "pre", "non", "sub", "multi",
]);

/** A term must recur across at least this many DISTINCT contacts to be a pattern. */
const MIN_CONTACTS = 2;

/** Terms shorter than this are too generic to name a theme. */
const MIN_TERM_LEN = 4;

const DEFAULT_MAX_TOPICS = 5;

export interface TopicPattern {
  /** The recurring term itself, lowercased. */
  term: string;
  /** Distinct contacts it appeared with, in first-seen order. */
  contacts: string[];
  /** Total mentions across all sources. */
  occurrences: number;
  /** Proposal title, ready for a context item. */
  title: string;
  /** Proposal body, ready for a context item. */
  body: string;
}

export interface TopicOptions {
  maxTopics?: number;
  minContacts?: number;
}

/**
 * Terms that recur across MULTIPLE contacts.
 *
 * Cross-contact recurrence is the whole signal: a term used ten times with one
 * person is that person's topic, while a term used once each with four people
 * is a theme of the user's. So terms are ranked by distinct-contact count
 * first, total mentions only as a tie-break.
 */
export function findRecurringTopics(input: PatternInput, opts: TopicOptions = {}): TopicPattern[] {
  const maxTopics = opts.maxTopics ?? DEFAULT_MAX_TOPICS;
  const minContacts = opts.minContacts ?? MIN_CONTACTS;

  // term → { contacts (insertion-ordered), total mentions, seen in a note }
  const seen = new Map<string, { contacts: string[]; occurrences: number; inNotes: boolean }>();

  const ingest = (contact: string, text: string, isNote: boolean) => {
    if (!contact) return;
    for (const term of tokenize(text)) {
      if (term.length < MIN_TERM_LEN || META_TERMS.has(term)) continue;
      let entry = seen.get(term);
      if (!entry) {
        entry = { contacts: [], occurrences: 0, inNotes: false };
        seen.set(term, entry);
      }
      entry.occurrences += 1;
      if (isNote) entry.inNotes = true;
      if (!entry.contacts.includes(contact)) entry.contacts.push(contact);
    }
  };

  for (const n of input.notes) ingest(n.contact_name, n.body, true);
  for (const s of input.strategies) ingest(s.contact_name, s.text, false);

  return Array.from(seen.entries())
    // A theme must be grounded in at least one CONFIRMED NOTE. Strategy entries
    // are the model's own prose about a conversation, and it writes the same
    // advice shape every time — run against real data, the top "themes" from
    // strategies alone were "potential", "collaboration", "opportunities" and
    // "explore", which recur because the generator repeats itself, not because
    // the user talks about them. Strategies still reinforce a term's count and
    // contact spread; they just can't introduce one on their own.
    .filter(([, v]) => v.inNotes && v.contacts.length >= minContacts)
    .sort(
      (a, b) =>
        b[1].contacts.length - a[1].contacts.length ||
        b[1].occurrences - a[1].occurrences ||
        a[0].localeCompare(b[0]),
    )
    .slice(0, maxTopics)
    .map(([term, v]) => ({
      term,
      contacts: v.contacts,
      occurrences: v.occurrences,
      title: `Recurring theme: ${term}`,
      body:
        `"${term}" comes up across ${v.contacts.length} conversations ` +
        `(${namesForProse(v.contacts)}). It's a recurring thread in my work.`,
    }));
}

/** Longest run of contact names to spell out before summarising the remainder. */
const NAMES_IN_PROSE = 4;

/**
 * Contact names, cleaned up for a sentence.
 *
 * Names are sanitized at the write boundary now (`memory.ts`), and the stored
 * rows were cleaned by the migration in `db.ts`. This stays as defence in depth
 * — a proposal body becomes a trusted ABOUT ME item once adopted, so it is the
 * last place a malformed name could ride into a prompt — and additionally
 * summarises a long tail rather than listing a dozen people.
 */
function namesForProse(contacts: string[]): string {
  const clean = contacts.map(sanitizeContactName).filter(Boolean);
  if (clean.length <= NAMES_IN_PROSE) return clean.join(", ");
  const rest = clean.length - NAMES_IN_PROSE;
  return `${clean.slice(0, NAMES_IN_PROSE).join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
}

export type Stage = "new" | "warming" | "established";

export interface RelationshipStage {
  contact: string;
  /** Analysed exchanges — one strategy entry is written per drafted reply. */
  exchanges: number;
  stage: Stage;
  /** Proposal body, ready for a per-contact note. */
  hint: string;
}

/** Exchange counts at which the relationship reads as further along. */
const WARMING_AT = 2;
const ESTABLISHED_AT = 4;

/**
 * How far along each relationship is, from how many exchanges have been drafted.
 *
 * The count comes from `strategy_log` because one row is written per drafted
 * reply on a real conversation — it's the closest thing to a true exchange
 * count the schema holds. It is a floor, not a total: replies sent outside the
 * tool are invisible here, so the hint is phrased as what was drafted rather
 * than as an absolute claim about the relationship.
 */
export function findRelationshipStages(input: PatternInput): RelationshipStage[] {
  const counts = new Map<string, number>();
  for (const s of input.strategies) {
    if (!s.contact_name) continue;
    counts.set(s.contact_name, (counts.get(s.contact_name) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([contact, exchanges]) => {
      const stage: Stage =
        exchanges >= ESTABLISHED_AT ? "established" : exchanges >= WARMING_AT ? "warming" : "new";
      return { contact, exchanges, stage, hint: describeStage(stage, exchanges) };
    });
}

function describeStage(stage: Stage, exchanges: number): string {
  const n = `${exchanges} drafted exchange${exchanges === 1 ? "" : "s"}`;
  switch (stage) {
    case "new":
      return `First contact — ${n} so far. Still introducing myself.`;
    case "warming":
      return `${n} so far — still warming up; not yet a familiar back-and-forth.`;
    case "established":
      return `${n} — an established back-and-forth. I can skip the reintroduction.`;
  }
}
