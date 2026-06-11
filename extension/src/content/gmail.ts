/**
 * Gmail conversation extractor. Mirrors `content/linkedin.ts`: reads the open
 * thread (subject, messages, the reply draft) from mail.google.com and produces
 * a ConversationContext. Reuses the generic selector-chain helpers.
 *
 * Gmail's DOM is obfuscated and shifts, so selectors use fallback chains and the
 * extraction records `selectorHits` + pushes anomalies — failures surface via the
 * diagnostics / snapshot system rather than silently.
 */
import type { ExtractionResult, Message, Participant } from "../shared/types";
import { createEmptyDiagnostics } from "./diagnostics";
import type { ExtractionDiagnostics, SelfDetectionPath } from "./diagnostics";
import { queryChain, queryFirstChain } from "./selectors";
import type { SelectorChain } from "./selectors";
import { getSelfNameSetting } from "../shared/storage";

const GMAIL = {
  subject: ["h2.hP", "[data-thread-perm-id] h2"],
  message: ["[data-message-id]", "[data-legacy-message-id]", ".gs", "[role='listitem']"],
  sender: ["span.gD[email]", "span.gD", ".go span[email]"],
  body: [".a3s", ".ii.gt div[dir]", ".ii.gt"],
  timestamp: [".gH span[title]", ".g3[title]", "span[data-tooltip]"],
  draft: [
    "div[role='textbox'][aria-label='Message Body']",
    "div[aria-label='Message Body']",
    ".Am.Al.editable",
    "div[g_editable='true'][role='textbox']",
  ],
  mainContainer: ["div[role='main']"],
} satisfies Record<string, SelectorChain>;

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

interface ResolvedSelf {
  email: string;
  name: string;
  path: SelfDetectionPath;
}

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w{2,}/;

async function resolveGmailSelf(): Promise<ResolvedSelf> {
  const name = (await getSelfNameSetting()).trim();
  // Gmail puts the signed-in account email in the document title, e.g.
  // "Inbox (3) - you@gmail.com - Gmail".
  const fromTitle = document.title.match(EMAIL_RE)?.[0];
  if (fromTitle) return { email: fromTitle.toLowerCase(), name, path: "gmail-account" };
  // Fallback: the account switcher button's aria-label contains "(you@gmail.com)".
  const acct = document.querySelector("[aria-label*='Google Account']");
  const fromAria = acct?.getAttribute("aria-label")?.match(EMAIL_RE)?.[0];
  if (fromAria) return { email: fromAria.toLowerCase(), name, path: "gmail-account" };
  return { email: "", name, path: name ? "configured-name" : "none" };
}

function makeMessage(rawSender: string, isSelf: boolean, body: string, ts: string | undefined): Message {
  return { sender: isSelf ? "Me" : rawSender || "Unknown", isSelf, timestamp: ts, text: body };
}

/**
 * A message body without the quoted prior thread, so each message is just its
 * own new content. Gmail appends the quote as a trailing `.gmail_quote` block;
 * we read the live `innerText` (which has layout) and strip the quote's text
 * from the end — avoids the detached-clone `innerText` returning "".
 */
function bodyText(bodyEl: Element): string {
  const host = bodyEl as HTMLElement;
  const full = (host.innerText ?? host.textContent ?? "").trim();
  const quoteEl = bodyEl.querySelector(".gmail_quote, blockquote") as HTMLElement | null;
  const quote = (quoteEl?.innerText ?? quoteEl?.textContent ?? "").trim();
  let body = full;
  if (quote && full.endsWith(quote)) body = full.slice(0, full.length - quote.length).trim();
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

// One rendered body (`.a3s`) per expanded message. We anchor on the bodies —
// NOT on a message-wrapper attribute like [data-message-id], which doesn't
// reliably contain the body — then find the sender by walking UP to the nearest
// enclosing message wrapper. Collapsed messages have no body and are skipped.
function extractGmailMessages(self: ResolvedSelf, diag: ExtractionDiagnostics): Message[] {
  const bodyMatch = queryChain(document, GMAIL.body);
  diag.selectorHits.gmailBody = bodyMatch.selector;
  if (bodyMatch.elements.length === 0) return [];

  const wrapperSel = GMAIL.message.join(", ");
  const senderSel = GMAIL.sender.join(", ");
  const tsSel = GMAIL.timestamp.join(", ");

  const out: Message[] = [];
  let anySenderHit = false;

  for (const bodyEl of bodyMatch.elements) {
    // Skip a body that is itself part of another message's quoted history.
    if (bodyEl.parentElement?.closest(".gmail_quote")) continue;
    const body = bodyText(bodyEl);
    if (!body) continue;

    const wrapper: ParentNode = bodyEl.closest(wrapperSel) ?? document;
    const senderEl = wrapper.querySelector(senderSel) as HTMLElement | null;
    if (senderEl) anySenderHit = true;
    const name = senderEl?.getAttribute("name")?.trim() || text(senderEl) || "";
    const email = (senderEl?.getAttribute("email") || "").toLowerCase();

    const tsEl = wrapper.querySelector(tsSel);
    const ts = tsEl?.getAttribute("title")?.trim() || (tsEl ? text(tsEl) : undefined) || undefined;

    const isSelf =
      (!!self.email && !!email && email === self.email) ||
      (!!self.name && !!name && name.toLowerCase() === self.name.toLowerCase());

    out.push(makeMessage(name, isSelf, body, ts));
  }

  diag.selectorHits.gmailSender = anySenderHit ? "matched" : null;
  return out;
}

function getGmailDraft(diag: ExtractionDiagnostics): string {
  const m = queryFirstChain(document, GMAIL.draft);
  diag.selectorHits.draft = m.selector;
  const el = m.elements[0] as HTMLElement | undefined;
  if (!el) return "";
  return (el.innerText ?? "").trim();
}

export async function extractGmailContext(): Promise<ExtractionResult> {
  const diag = createEmptyDiagnostics();
  const self = await resolveGmailSelf();
  diag.selfDetectionPath = self.path;

  const subjMatch = queryFirstChain(document, GMAIL.subject);
  diag.selectorHits.subject = subjMatch.selector;
  const subject = text(subjMatch.elements[0]);

  const messages = extractGmailMessages(self, diag);
  diag.messagesFound = messages.length;

  const draft = getGmailDraft(diag);
  diag.draftLen = draft.length;

  // Only flag a real failure: a thread is clearly open (its subject is present)
  // yet we parsed no message bodies. No subject means no email is open (e.g. the
  // inbox list) — a normal state, not an anomaly.
  if (subject && messages.length === 0) diag.anomalies.push("gmail-zero-messages");

  // The contact is the most recent person who isn't me — memory and voice key on
  // the person, not the email subject.
  const others = messages.filter((m) => !m.isSelf).map((m) => m.sender);
  const primary = others.length > 0 ? others[others.length - 1] : "";
  const conversationTitle = primary || subject || "(unknown thread)";
  const participants: Participant[] = Array.from(new Set(others)).map((name) => ({ name }));

  diag.extractedAt = new Date().toISOString();
  const context = {
    platform: "gmail" as const,
    conversation_title: conversationTitle,
    participants,
    messages,
    current_draft: draft,
    page_metadata: {
      url: window.location.href,
      title: document.title,
      extracted_at: diag.extractedAt,
    },
    contact_profile_url: null,
  };

  return { context, diagnostics: diag };
}

/** No-op for Gmail v1 — the open thread is already loaded; expanding collapsed
 * messages is a follow-up. */
export async function backfillMessages(): Promise<number> {
  return -1;
}

export function installMessageObserver(onChange: () => void): MutationObserver | null {
  const m = queryFirstChain(document, GMAIL.mainContainer);
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

export function getGmailSubtreeHtml(): string {
  const m = queryFirstChain(document, GMAIL.mainContainer);
  const container = m.elements[0] as HTMLElement | undefined;
  return container?.outerHTML ?? "";
}
