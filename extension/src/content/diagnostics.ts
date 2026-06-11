/**
 * Diagnostics record produced alongside every extraction. Two purposes:
 * 1. Reliability — surface which selectors hit, which fallbacks were needed,
 *    where self-detection landed. The first signal that a LinkedIn redesign
 *    broke us shows up here.
 * 2. Forensics — if a downstream prompt or response looks suspicious, the
 *    snapshot mechanism captures this object alongside the parsed context.
 */
export interface ExtractionDiagnostics {
  /** Wall-clock ms spent in the auto-scroll backfill loop (-1 if skipped). */
  backfillMs: number;
  /** Map of logical selector target → which selector in the chain matched (or null). */
  selectorHits: Record<string, string | null>;
  /** How the logged-in user's display name was resolved. */
  selfDetectionPath: SelfDetectionPath;
  /** Total messages successfully parsed from the DOM. */
  messagesFound: number;
  /** Length of the draft text we read (0 if no draft box visible). */
  draftLen: number;
  /**
   * Anomaly labels. Empty array = healthy extraction. Non-empty triggers the
   * overlay's "Extraction anomaly detected" card.
   */
  anomalies: Anomaly[];
  /** ISO timestamp of when the extraction ran. */
  extractedAt: string;
}

export type SelfDetectionPath =
  | "configured-name"   // chrome.storage.sync display name matched
  | "me-menu-alt"       // resolved via top-nav avatar alt text
  | "me-menu-aria"      // resolved via the Me button's aria-label
  | "gmail-account"     // resolved via the signed-in Gmail account email
  | "none";             // self could not be resolved — every msg sender is "them"

export type Anomaly =
  /** On a /messaging/thread/ URL but 0 messages parsed. */
  | "zero-messages-on-thread-route"
  /** Conversation title selector chain produced nothing. */
  | "conversation-title-missing"
  /** Message list container selector chain failed entirely. */
  | "message-list-container-missing"
  /** Configured self-name is set but didn't match any sender in the thread. */
  | "self-name-configured-but-unmatched"
  /** The whole messageEvent chain returned 0 elements (DOM may have changed). */
  | "no-message-events-matched"
  /** Gmail: a thread is open (subject present) but no expanded message bodies were parsed. */
  | "gmail-zero-messages";

export function createEmptyDiagnostics(): ExtractionDiagnostics {
  return {
    backfillMs: -1,
    selectorHits: {},
    selfDetectionPath: "none",
    messagesFound: 0,
    draftLen: 0,
    anomalies: [],
    extractedAt: new Date().toISOString(),
  };
}

/** One-line human-readable summary for the overlay footer. */
export function formatDiagnosticsSummary(d: ExtractionDiagnostics): string {
  const parts = [`${d.messagesFound} msg${d.messagesFound === 1 ? "" : "s"}`];
  parts.push(`self ${shortSelfPath(d.selfDetectionPath)}`);
  if (d.draftLen > 0) parts.push(`draft ${d.draftLen}ch`);
  if (d.backfillMs >= 0) parts.push(`backfill ${(d.backfillMs / 1000).toFixed(1)}s`);
  if (d.anomalies.length > 0) parts.push(`⚠ ${d.anomalies.length} anomaly`);
  return parts.join(" · ");
}

function shortSelfPath(p: SelfDetectionPath): string {
  switch (p) {
    case "configured-name":
      return "configured";
    case "me-menu-alt":
      return "alt";
    case "me-menu-aria":
      return "aria";
    case "gmail-account":
      return "gmail";
    case "none":
      return "unknown";
  }
}

/**
 * Anomalies that mean a selector/DOM expectation failed — i.e. the page layout
 * likely changed and extraction couldn't read the conversation. (Everything
 * except `self-name-configured-but-unmatched`, which is a self-detection nicety,
 * not a structural break.)
 */
const LAYOUT_ANOMALIES: ReadonlySet<Anomaly> = new Set<Anomaly>([
  "zero-messages-on-thread-route",
  "conversation-title-missing",
  "message-list-container-missing",
  "no-message-events-matched",
  "gmail-zero-messages",
]);

/** True if any anomaly indicates the page layout may have changed. */
export function hasLayoutAnomaly(anomalies: Anomaly[]): boolean {
  return anomalies.some((a) => LAYOUT_ANOMALIES.has(a));
}

/** One human-readable phrase per anomaly. The exhaustive switch also guards: a
 * new Anomaly won't compile until it's described here. */
export function describeAnomaly(a: Anomaly): string {
  switch (a) {
    case "zero-messages-on-thread-route":
      return "couldn't find any messages in this thread";
    case "conversation-title-missing":
      return "couldn't read the conversation title";
    case "message-list-container-missing":
      return "couldn't find the message list";
    case "no-message-events-matched":
      return "couldn't find any messages";
    case "gmail-zero-messages":
      return "couldn't read the email's messages";
    case "self-name-configured-but-unmatched":
      return "couldn't match your name to a sender";
  }
}
