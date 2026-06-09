import type { ConversationContext, Message, Participant } from "../shared/types";
import { getSelfNameSetting } from "../shared/storage";
import { LINKEDIN_SELECTORS as S } from "./selectors";

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").trim();
}

function readMeMenuName(): string {
  const me = document.querySelector(S.selfNameMeMenu);
  if (!me) return "";
  const img = me.querySelector("img");
  const fromAlt = img?.getAttribute("alt")?.trim();
  if (fromAlt) return fromAlt;
  const ariaLabel = me.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel.replace(/^Me,?\s*/i, "").trim();
  return "";
}

async function resolveSelfName(): Promise<string> {
  // Settings-backed name wins; the Me-menu read is a fragile fallback.
  const configured = await getSelfNameSetting();
  if (configured) return configured;
  return readMeMenuName();
}

function getConversationTitle(): string {
  return text(document.querySelector(S.conversationTitle));
}

function getDraft(): string {
  const el = document.querySelector(S.draftEditable) as HTMLElement | null;
  if (!el) return "";
  return (el.innerText ?? "").trim();
}

function getMessageListContainer(): HTMLElement | null {
  return document.querySelector(S.messageListContainer) as HTMLElement | null;
}

interface EventGroupInfo {
  sender: string;
  timestamp?: string;
}

// For a given .msg-s-message-list__event, return the group header info.
function readGroupHeader(eventEl: Element): EventGroupInfo {
  const nameEl = eventEl.querySelector(S.messageGroupName);
  const tsEl = eventEl.querySelector(S.messageGroupTimestamp);
  return {
    sender: text(nameEl),
    timestamp: tsEl ? text(tsEl) : undefined,
  };
}

function extractMessages(selfName: string): Message[] {
  // LinkedIn renders messages bottom-up in DOM order: oldest first → newest last.
  // We iterate every event group, carry the most recent known sender forward
  // (LinkedIn only renders the header on the first message of a run), and emit
  // one Message per .msg-s-event-listitem inside each group.

  const events = Array.from(document.querySelectorAll(S.messageEvent));
  const out: Message[] = [];

  let currentSender = "";
  let currentGroupTs: string | undefined;

  for (const ev of events) {
    const header = readGroupHeader(ev);
    if (header.sender) {
      currentSender = header.sender;
      currentGroupTs = header.timestamp;
    }

    // Inner messages from this group.
    const items = Array.from(ev.querySelectorAll(S.eventListitem));
    if (items.length === 0) {
      // Older LinkedIn variants embed the body directly on the event.
      const bodyEl = ev.querySelector(S.messageBody);
      if (bodyEl) {
        const body = text(bodyEl);
        if (body) {
          out.push(makeMessage(currentSender, selfName, body, currentGroupTs));
        }
      }
      continue;
    }

    for (const item of items) {
      const bodyEl = item.querySelector(S.messageBody);
      if (!bodyEl) continue;
      const body = text(bodyEl);
      if (!body) continue;

      const perItemTs = item.querySelector(S.messageTimestamp);
      const ts = perItemTs ? text(perItemTs) : currentGroupTs;

      out.push(makeMessage(currentSender, selfName, body, ts));
    }
  }

  return out;
}

function makeMessage(
  rawSender: string,
  selfName: string,
  body: string,
  ts: string | undefined,
): Message {
  const sender = rawSender || "Unknown";
  const isSelf = !!selfName && sender.toLowerCase() === selfName.toLowerCase();
  return {
    sender: isSelf ? "Me" : sender,
    isSelf,
    timestamp: ts,
    text: body,
  };
}

export async function extractLinkedInContext(): Promise<ConversationContext> {
  const selfName = await resolveSelfName();
  const title = getConversationTitle();
  const messages = extractMessages(selfName);

  const participants: Participant[] = title ? [{ name: title }] : [];

  return {
    platform: "linkedin",
    conversation_title: title,
    participants,
    messages,
    current_draft: getDraft(),
    page_metadata: {
      url: window.location.href,
      title: document.title,
      extracted_at: new Date().toISOString(),
    },
  };
}

// --- Auto-scroll backfill ---------------------------------------------------

const SCROLL_STEP_MS = 400;
const SCROLL_MAX_ITERATIONS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function backfillMessages(): Promise<void> {
  const container = getMessageListContainer();
  if (!container) return;

  let prevHeight = -1;
  let stagnant = 0;

  for (let i = 0; i < SCROLL_MAX_ITERATIONS; i++) {
    container.scrollTop = 0;
    await sleep(SCROLL_STEP_MS + Math.floor(Math.random() * 150));

    const h = container.scrollHeight;
    if (h === prevHeight) {
      stagnant++;
      if (stagnant >= 2) break;
    } else {
      stagnant = 0;
      prevHeight = h;
    }
  }
}

// --- Observer ---------------------------------------------------------------

export function installMessageObserver(onChange: () => void): MutationObserver | null {
  const container = getMessageListContainer();
  if (!container) return null;

  let pending: number | null = null;
  const obs = new MutationObserver(() => {
    if (pending !== null) return;
    pending = window.setTimeout(() => {
      pending = null;
      onChange();
    }, 250);
  });

  obs.observe(container, { childList: true, subtree: true });
  return obs;
}
