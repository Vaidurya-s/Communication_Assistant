// Single source of truth for LinkedIn DOM selectors.
// LinkedIn rebrands class names without warning. When extraction breaks, start here.
//
// Each logical target is a CHAIN of semantically diverse selectors. We try them
// in order and record which one matched in extraction diagnostics. The point
// of "semantically diverse" is to avoid a single redesign breaking every
// fallback at once — at least one strategy should be class-name-independent
// (data-* attributes, ARIA roles, structural relationships).
//
// LinkedIn message DOM (approximate at time of writing):
//   .msg-s-message-list-container
//     .msg-s-message-list
//       .msg-s-message-list__event                  ← one group of consecutive messages
//         .msg-s-message-group__meta
//           .msg-s-message-group__name              ← sender name (only on first msg of run)
//           .msg-s-message-group__timestamp         ← group timestamp
//         .msg-s-event-listitem                     ← one rendered message
//           .msg-s-event-listitem__body             ← message text
//           time                                    ← per-message timestamp (sometimes)

/** Ordered list of selectors to try; first non-empty match wins. */
export type SelectorChain = readonly string[];

export interface LinkedInSelectorMap {
  conversationTitle: SelectorChain;
  messageListContainer: SelectorChain;
  /** One "event" = a run of consecutive messages from the same sender. */
  messageEvent: SelectorChain;
  /** One individual rendered message inside an event. */
  eventListitem: SelectorChain;
  messageGroupName: SelectorChain;
  messageGroupTimestamp: SelectorChain;
  messageBody: SelectorChain;
  /** Per-event timestamp (when LinkedIn renders it inline). */
  messageTimestamp: SelectorChain;
  draftEditable: SelectorChain;
  /** Top-nav "Me" menu — fallback path to detect logged-in user's name. */
  selfNameMeMenu: SelectorChain;
}

export const LINKEDIN_SELECTORS: LinkedInSelectorMap = {
  conversationTitle: [
    // class-name-based (current)
    ".msg-entity-lockup__entity-title",
    ".msg-thread__link-to-profile",
    // structural fallback: any heading at the top of the message pane
    ".msg-overlay-conversation-bubble-header h2",
    ".msg-thread-actions h2",
  ],

  messageListContainer: [
    ".msg-s-message-list-container",
    ".msg-s-message-list",
    // structural: any element with role=log inside the messaging shell
    "[role='log']",
  ],

  messageEvent: [
    ".msg-s-message-list__event",
    // ARIA fallback: list items inside a role=log
    "[role='log'] [role='listitem']",
  ],

  eventListitem: [".msg-s-event-listitem"],

  messageGroupName: [
    ".msg-s-message-group__name",
    // structural: first link or strong-tagged name in the group meta
    ".msg-s-message-group__meta a",
    ".msg-s-message-group__meta strong",
  ],

  messageGroupTimestamp: [
    ".msg-s-message-group__timestamp",
    ".msg-s-message-group__meta time",
  ],

  messageBody: [
    ".msg-s-event-listitem__body",
    // structural fallback: the only paragraph inside a listitem
    ".msg-s-event-listitem p",
  ],

  messageTimestamp: ["time"],

  draftEditable: [
    'div.msg-form__contenteditable[contenteditable="true"]',
    // ARIA fallback: a contenteditable with aria-label hinting at "message"
    '[contenteditable="true"][aria-label*="message" i]',
    // last-ditch structural fallback
    '[contenteditable="true"][role="textbox"]',
  ],

  selfNameMeMenu: [
    ".global-nav__me-photo",
    ".global-nav__me",
    // aria-label fallback on the "Me" button itself
    "button[aria-label^='Me' i]",
  ],
};

// ---------------------------------------------------------------------------
// Profile pages (/in/<handle>/)
// ---------------------------------------------------------------------------
//
// These used to live inline in content/profile.ts, which is exactly why they
// rotted unnoticed while the messaging chains stayed current: this file is the
// documented first place to look when extraction breaks, and the profile
// selectors weren't in it. They are now.
//
// LinkedIn has moved profile pages to a SERVER-DRIVEN UI. Verified live
// (2026-08-29) against a real profile:
//   - No <h1>. The contact's name is an <h2> inside the top card.
//   - No #about / #experience / #education / #skills id anchors.
//   - No og:title / og:description meta tags and no JSON-LD on the logged-in
//     SPA view, so the old meta fallbacks are dead too.
//   - Every class is an obfuscated hash ("_02484ad3 _1f667e81 …") that changes
//     between deploys — class selectors are worthless here.
//   - BUT each section card carries a STABLE, SEMANTIC id:
//       com.linkedin.sdui.profile.card.ref<opaque>Topcard
//       com.linkedin.sdui.profile.card.ref<opaque>About
//     The `ref<opaque>` middle is per-profile; the prefix and the trailing
//     section name are stable. Anchoring on those is the most durable hook the
//     new layout offers, which is what `sduiCard` builds.
//   - span[aria-hidden="true"] duplication is GONE (0 on every card), so the
//     old "read the aria-hidden twin" trick no longer finds anything.

/** Prefix shared by every server-driven profile card id. */
const SDUI_CARD_PREFIX = "com.linkedin.sdui.profile.card.";

/**
 * Selector for a server-driven profile card by its stable trailing section
 * name, e.g. `sduiCard("About")`. Matches on prefix + suffix so the opaque
 * per-profile ref in the middle is ignored.
 */
export function sduiCard(section: string): string {
  return `[id^="${SDUI_CARD_PREFIX}"][id$="${section}"]`;
}

export interface LinkedInProfileSelectorMap {
  /** The identity card: name, headline, current company/school, location. */
  topcard: SelectorChain;
  /** The contact's display name within the top card. */
  name: SelectorChain;
  /**
   * One entry in an Experience/Education/Skills list. Legacy class hooks first
   * (they still work on the older layout some accounts still get), then a
   * structural `li` fallback that survives class obfuscation.
   */
  listItem: SelectorChain;
  /** Text carriers inside a list entry, in preference order. */
  listItemText: SelectorChain;
}

export const LINKEDIN_PROFILE_SELECTORS: LinkedInProfileSelectorMap = {
  topcard: [
    sduiCard("Topcard"),
    // Legacy layouts.
    ".pv-top-card",
    ".pv-text-details__left-panel",
    // Structural last resort: the block that holds the page's main heading.
    "main section:first-of-type",
  ],

  name: [
    // Legacy layout put the name in an h1.
    "main h1",
    "h1",
    // Server-driven layout: an h2 inside the top card.
    `${sduiCard("Topcard")} h2`,
  ],

  listItem: [
    ".pvs-list__item--line-separated",
    "li.artdeco-list__item",
    // Structural: the new cards still render entries as list items, and a
    // section root scopes this tightly enough that a bare `li` is safe.
    "li",
  ],

  listItemText: [
    // Legacy: LinkedIn duplicated every string into an aria-hidden twin.
    'span[aria-hidden="true"]',
    // Server-driven layout carries the text in plain <p>/<span> leaves.
    "p",
    "span",
  ],
};

/** Section names as they appear both as SDUI id suffixes and as heading text. */
export const PROFILE_SECTIONS = {
  about: "About",
  experience: "Experience",
  education: "Education",
  skills: "Skills",
} as const;

export type ProfileSectionKey = keyof typeof PROFILE_SECTIONS;

export const LINKEDIN_MESSAGING_PATH = "/messaging/";

/**
 * Try each selector in the chain; return the first one that matches at least
 * one element, along with the matched elements. If nothing matches, returns
 * { selector: null, elements: [] } so callers can log the failure.
 */
export interface ChainMatch {
  /** Which selector in the chain actually matched (null if none did). */
  selector: string | null;
  elements: Element[];
}

export function queryChain(root: ParentNode, chain: SelectorChain): ChainMatch {
  for (const sel of chain) {
    const els = Array.from(root.querySelectorAll(sel));
    if (els.length > 0) return { selector: sel, elements: els };
  }
  return { selector: null, elements: [] };
}

export function queryFirstChain(root: ParentNode, chain: SelectorChain): ChainMatch {
  for (const sel of chain) {
    const el = root.querySelector(sel);
    if (el) return { selector: sel, elements: [el] };
  }
  return { selector: null, elements: [] };
}
