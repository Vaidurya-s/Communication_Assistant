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
  | "no-message-events-matched";

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
    case "none":
      return "unknown";
  }
}
