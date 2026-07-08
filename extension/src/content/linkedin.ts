import type { ConversationContext, ExtractionResult, Message, Participant } from "../shared/types";
import { getSelfNameSetting } from "../shared/storage";
import { LINKEDIN_SELECTORS as S, queryChain, queryFirstChain, type SelectorChain } from "./selectors";
import {
  createEmptyDiagnostics,
  type ExtractionDiagnostics,
  type SelfDetectionPath,
} from "./diagnostics";
import { getThreadContactProfileUrl } from "./profile";

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

// 10s, not 4s: when you arrive at a thread by navigating in from another
// LinkedIn surface (e.g. clicking "Message" on My Network), the messaging
// bundle is cold and the SPA can keep the *previous* page mounted in `main`
// for several seconds before the thread paints. A 4s ceiling expired against
// that stale DOM and extracted zeros from the wrong page (the captured
// "My Network" snapshot behind the extraction-render-race bug). Give the cold
// load real headroom; we return the instant the thread is ready, so a warm
// thread still resolves immediately and only a genuine never-loads waits long.
const MESSAGE_LIST_WAIT_MS = 10000;
const MESSAGE_LIST_POLL_MS = 100;
// Once the container exists, give messages a brief window to hydrate before we
// read. LinkedIn paints the empty list shell first, then fills it; reading in
// between yields a container with zero events. If no event shows up within this
// settle window we proceed anyway — a genuinely empty thread is a valid state.
const MESSAGE_CONTENT_SETTLE_MS = 1500;
// A cold messaging bundle may not have painted the list container yet, but its
// scaffold (hundreds of `msg-*`-classed elements) shows up quickly. If NOTHING
// messaging-classed exists after this grace, the SPA isn't loading messaging in
// this document at all — the URL is a thread but a different surface (feed / My
// Network, which carries zero `msg-*` classes) is mounted. Bail then instead of
// blocking the full budget against a page that will never yield a thread.
const WRONG_SURFACE_GRACE_MS = 3000;

/**
 * Is LinkedIn's messaging app mounted (or actively mounting) in this document?
 * True whenever any messaging-classed element is present — the whole messaging
 * surface carries `msg-*` classes; the feed / My Network surface carries none.
 * Cheap discriminator for "URL says thread but the thread isn't rendered here".
 */
function messagingSurfaceMounted(): boolean {
  return !!document.querySelector("[class*='msg-']");
}

/**
 * Wait for the message list to be READY to read — the container present AND
 * either at least one message event hydrated or a short content-settle elapsed.
 * LinkedIn's SPA paints a thread asynchronously after a navigation or
 * conversation switch, so extraction fired immediately on open used to find
 * nothing — all-null selectors and an empty snapshot. Returns the instant the
 * thread is ready; a no-op (returns fast) once it's already painted. Also
 * fast-bails when the messaging surface isn't mounting at all (wrong surface).
 */
async function waitForMessageList(timeoutMs = MESSAGE_LIST_WAIT_MS): Promise<boolean> {
  const start = performance.now();
  let containerSince: number | null = null;
  for (;;) {
    const hasContainer = !!queryFirstChain(document, S.messageListContainer).elements[0];
    if (hasContainer) {
      if (containerSince === null) containerSince = performance.now();
      // Ready as soon as a message event renders…
      if (queryChain(document, S.messageEvent).elements.length > 0) return true;
      // …or after the settle window (covers a legitimately empty thread).
      if (performance.now() - containerSince >= MESSAGE_CONTENT_SETTLE_MS) return true;
    }
    const elapsed = performance.now() - start;
    // Wrong surface: no messaging scaffold at all after the grace → waiting the
    // full budget is pointless. (A genuine slow load shows msg-* scaffold well
    // within the grace, so this never trips on a real messaging page.)
    if (!hasContainer && elapsed >= WRONG_SURFACE_GRACE_MS && !messagingSurfaceMounted()) {
      return false;
    }
    if (elapsed >= timeoutMs) return false;
    await sleep(MESSAGE_LIST_POLL_MS);
  }
}

export async function extractLinkedInContext(): Promise<ExtractionResult> {
  const startedAt = performance.now();
  const diag = createEmptyDiagnostics();

  const self = await resolveSelfName();
  diag.selfDetectionPath = self.path;

  // On a thread route, give the SPA a moment to render the message list before
  // reading the DOM (extracting too early is the #1 cause of a "couldn't read
  // this page" with every selector null).
  if (window.location.pathname.includes("/messaging/thread/")) {
    await waitForMessageList();

    // URL is a thread, but the messaging app never mounted here — LinkedIn kept a
    // different surface (feed / My Network) in place after a soft navigation.
    // This is NOT a selector break, so don't emit the "layout changed" anomalies
    // or parse a foreign page (that produced the misleading 120k My-Network debug
    // snapshots). Report one honest, actionable state and stop.
    if (!messagingSurfaceMounted()) {
      diag.anomalies.push("messaging-thread-not-mounted");
      diag.extractedAt = new Date().toISOString();
      return {
        context: {
          platform: "linkedin",
          conversation_title: "",
          participants: [],
          messages: [],
          current_draft: "",
          page_metadata: {
            url: window.location.href,
            title: document.title,
            extracted_at: diag.extractedAt,
          },
          contact_profile_url: null,
        },
        diagnostics: diag,
      };
    }
  }

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
    contact_profile_url: getThreadContactProfileUrl(),
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
  // The list may not have rendered yet (SPA). Wait for it so backfill can
  // actually scroll history instead of no-opping on a missing container.
  await waitForMessageList();
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
 * Helper for snapshot: return the message-list container's HTML. Used by the
 * snapshot exporter only.
 *
 * When the container is MISSING — which is exactly the case a snapshot is saved
 * to debug — we must not return "" (that's a blank, useless snapshot). Fall back
 * to a broader region (messaging shell → main → body) so the captured DOM
 * actually shows what rendered instead. Size-capped so a snapshot can't balloon.
 */
const SNAPSHOT_MAX_CHARS = 120_000;

export function getMessageListSubtreeHtml(): string {
  const m = queryFirstChain(document, S.messageListContainer);
  const container = m.elements[0] as HTMLElement | undefined;
  if (container) return container.outerHTML;

  const fallback =
    document.querySelector(
      ".msg-overlay-container, .scaffold-layout__content, .msg-overlay-list-bubble, main",
    ) ?? document.body;
  const html = fallback?.outerHTML ?? "";
  return html.length > SNAPSHOT_MAX_CHARS
    ? html.slice(0, SNAPSHOT_MAX_CHARS) + "\n<!-- …truncated for snapshot size -->"
    : html;
}
