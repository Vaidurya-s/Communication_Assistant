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
