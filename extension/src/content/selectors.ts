// Single source of truth for LinkedIn DOM selectors.
// LinkedIn rebrands class names without warning — when extraction breaks, start here.
//
// LinkedIn message DOM (approximate):
//   .msg-s-message-list-container
//     .msg-s-message-list
//       .msg-s-message-list__event                  ← one group of consecutive messages
//         .msg-s-message-group__meta
//           .msg-s-message-group__name              ← sender name (only on first msg of run)
//           .msg-s-message-group__timestamp         ← group timestamp
//         .msg-s-event-listitem                     ← one rendered message
//           .msg-s-event-listitem__body             ← message text
//           time                                    ← per-message timestamp (sometimes)
//         .msg-s-event-listitem                     ← next message from same sender...

export const LINKEDIN_SELECTORS = {
  conversationTitle: ".msg-entity-lockup__entity-title, .msg-thread__link-to-profile",

  messageListContainer: ".msg-s-message-list-container, .msg-s-message-list",

  // One "event" = a run of consecutive messages from the same sender.
  messageEvent: ".msg-s-message-list__event",
  // One individual rendered message inside an event.
  eventListitem: ".msg-s-event-listitem",

  messageGroupName: ".msg-s-message-group__name",
  messageGroupTimestamp: ".msg-s-message-group__timestamp",
  messageBody: ".msg-s-event-listitem__body",
  messageTimestamp: "time",

  draftEditable: 'div.msg-form__contenteditable[contenteditable="true"]',

  // Top-nav "Me" menu — fallback path to detect logged-in user's name.
  selfNameMeMenu: ".global-nav__me-photo, .global-nav__me",
} as const;

export const LINKEDIN_MESSAGING_PATH = "/messaging/";
