import type { ConversationContext, ExtractionResult, Message, Participant } from "../shared/types";
import { getSelfNameSetting } from "../shared/storage";
import { LINKEDIN_SELECTORS as S, queryChain, queryFirstChain, type SelectorChain } from "./selectors";
import {
  createEmptyDiagnostics,
  type ExtractionDiagnostics,
  type SelfDetectionPath,
} from "./diagnostics";

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").trim();
}

interface ResolvedSelf {
  name: string;
  path: SelfDetectionPath;
}

async function resolveSelfName(): Promise<ResolvedSelf> {
  const configured = (await getSelfNameSetting()).trim();
  if (configured) return { name: configured, path: "configured-name" };

  const meChain = queryFirstChain(document, S.selfNameMeMenu);
  const meEl = meChain.elements[0];
  if (!meEl) return { name: "", path: "none" };

  const img = meEl.querySelector("img");
  const fromAlt = img?.getAttribute("alt")?.trim();
  if (fromAlt) return { name: fromAlt, path: "me-menu-alt" };

  const ariaLabel = meEl.getAttribute("aria-label")?.trim();
  if (ariaLabel) {
    const cleaned = ariaLabel.replace(/^Me,?\s*/i, "").trim();
    if (cleaned) return { name: cleaned, path: "me-menu-aria" };
  }
  return { name: "", path: "none" };
}

interface FirstMatchResult {
  text: string;
  selectorHit: string | null;
}

function firstMatchText(chain: SelectorChain): FirstMatchResult {
  const m = queryFirstChain(document, chain);
  return { text: text(m.elements[0]), selectorHit: m.selector };
}

function getDraft(diag: ExtractionDiagnostics): string {
  const m = queryFirstChain(document, S.draftEditable);
  diag.selectorHits.draftEditable = m.selector;
  const el = m.elements[0] as HTMLElement | undefined;
  if (!el) return "";
  return (el.innerText ?? "").trim();
}

function extractMessages(
  selfName: string,
  diag: ExtractionDiagnostics,
): Message[] {
  const eventsMatch = queryChain(document, S.messageEvent);
  diag.selectorHits.messageEvent = eventsMatch.selector;
  if (!eventsMatch.selector || eventsMatch.elements.length === 0) {
    diag.anomalies.push("no-message-events-matched");
    return [];
  }

  const out: Message[] = [];
  let currentSender = "";
  let currentGroupTs: string | undefined;
  let anyNameHit = false;
  let anyBodyHit = false;
  let anyListitemHit = false;

  for (const ev of eventsMatch.elements) {
    // Group header — sender + timestamp run.
    const nameMatch = queryFirstChain(ev, S.messageGroupName);
    if (nameMatch.selector) anyNameHit = true;
    const nameEl = nameMatch.elements[0];
    if (nameEl) {
      currentSender = text(nameEl);
      const tsMatch = queryFirstChain(ev, S.messageGroupTimestamp);
      currentGroupTs = tsMatch.elements[0] ? text(tsMatch.elements[0]) : undefined;
    }

    const itemsMatch = queryChain(ev, S.eventListitem);
    if (itemsMatch.selector) anyListitemHit = true;
    const items = itemsMatch.elements;

    if (items.length === 0) {
      // Older LinkedIn variants embed the body directly on the event.
      const bodyMatch = queryFirstChain(ev, S.messageBody);
      if (bodyMatch.selector) anyBodyHit = true;
      const bodyEl = bodyMatch.elements[0];
      if (bodyEl) {
        const body = text(bodyEl);
        if (body) out.push(makeMessage(currentSender, selfName, body, currentGroupTs));
      }
      continue;
    }

    for (const item of items) {
      const bodyMatch = queryFirstChain(item, S.messageBody);
      if (bodyMatch.selector) anyBodyHit = true;
      const bodyEl = bodyMatch.elements[0];
      if (!bodyEl) continue;
      const body = text(bodyEl);
      if (!body) continue;

      const perItemTsMatch = queryFirstChain(item, S.messageTimestamp);
      const ts = perItemTsMatch.elements[0] ? text(perItemTsMatch.elements[0]) : currentGroupTs;
      out.push(makeMessage(currentSender, selfName, body, ts));
    }
  }

  diag.selectorHits.messageGroupName = anyNameHit ? "matched" : null;
  diag.selectorHits.messageBody = anyBodyHit ? "matched" : null;
  diag.selectorHits.eventListitem = anyListitemHit ? "matched" : null;

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

export async function extractLinkedInContext(): Promise<ExtractionResult> {
  const startedAt = performance.now();
  const diag = createEmptyDiagnostics();

  const self = await resolveSelfName();
  diag.selfDetectionPath = self.path;

  const titleMatch = firstMatchText(S.conversationTitle);
  diag.selectorHits.conversationTitle = titleMatch.selectorHit;
  if (!titleMatch.selectorHit) diag.anomalies.push("conversation-title-missing");

  const containerMatch = queryFirstChain(document, S.messageListContainer);
  diag.selectorHits.messageListContainer = containerMatch.selector;
  if (!containerMatch.selector) diag.anomalies.push("message-list-container-missing");

  const messages = extractMessages(self.name, diag);
  diag.messagesFound = messages.length;

  const draft = getDraft(diag);
  diag.draftLen = draft.length;

  // Did self-detection have an actual match against any message sender?
  if (self.name && messages.length > 0 && !messages.some((m) => m.isSelf)) {
    diag.anomalies.push("self-name-configured-but-unmatched");
  }

  if (window.location.pathname.includes("/messaging/thread/") && messages.length === 0) {
    diag.anomalies.push("zero-messages-on-thread-route");
  }

  diag.extractedAt = new Date().toISOString();
  // We don't measure backfill here — that's set by backfillMessages() before extraction.

  const participants: Participant[] = titleMatch.text ? [{ name: titleMatch.text }] : [];
  const context: ConversationContext = {
    platform: "linkedin",
    conversation_title: titleMatch.text,
    participants,
    messages,
    current_draft: draft,
    page_metadata: {
      url: window.location.href,
      title: document.title,
      extracted_at: diag.extractedAt,
    },
  };

  // Touch startedAt so the linter doesn't complain in case future work adds
  // pure-extract timing distinct from backfillMs.
  void startedAt;

  return { context, diagnostics: diag };
}

// --- Auto-scroll backfill ---------------------------------------------------

const SCROLL_STEP_MS = 400;
const SCROLL_MAX_ITERATIONS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Returns the wall-clock ms spent scrolling. */
export async function backfillMessages(): Promise<number> {
  const start = performance.now();
  const m = queryFirstChain(document, S.messageListContainer);
  const container = m.elements[0] as HTMLElement | undefined;
  if (!container) return performance.now() - start;

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
  return performance.now() - start;
}

// --- Observer ---------------------------------------------------------------

export function installMessageObserver(onChange: () => void): MutationObserver | null {
  const m = queryFirstChain(document, S.messageListContainer);
  const container = m.elements[0] as HTMLElement | undefined;
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

/**
 * Helper for snapshot: return the innerHTML of the message list container,
 * or empty string if not present. Used by the snapshot exporter only.
 */
export function getMessageListSubtreeHtml(): string {
  const m = queryFirstChain(document, S.messageListContainer);
  const container = m.elements[0] as HTMLElement | undefined;
  return container?.outerHTML ?? "";
}
