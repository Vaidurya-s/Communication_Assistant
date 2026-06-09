/**
 * Forensic snapshot exporter.
 *
 * A snapshot captures everything we'd need to reproduce an extraction failure
 * or investigate a suspicious LLM response offline: the URL, the diagnostics,
 * the parsed conversation context, and the raw HTML of the message-list
 * subtree at the moment of capture.
 *
 * Snapshots are NEVER written to disk by the extension. They live in memory
 * until the user clicks Export, at which point we copy the JSON to the
 * clipboard. This is intentional — the snapshot contains the user's
 * conversation contents and should be treated as sensitive when shared.
 *
 * Anomaly auto-capture: when extraction produces a non-empty `anomalies`
 * array, we ARM a snapshot (compute it from the last extraction + current
 * DOM) and expose it. The overlay shows a card with [Export JSON][Dismiss].
 */

import { getLastExtraction } from "./index";
import { getMessageListSubtreeHtml } from "./linkedin";
import type { ExtractionDiagnostics } from "./diagnostics";
import type { ConversationContext } from "../shared/types";

export interface Snapshot {
  /** ISO timestamp of when captureSnapshot() was called. */
  capturedAt: string;
  url: string;
  pageTitle: string;
  /** Latest parsed conversation context, if any. */
  parsedContext: ConversationContext | null;
  /** Diagnostics corresponding to the parsed context. */
  diagnostics: ExtractionDiagnostics | null;
  /** Raw outerHTML of the message-list container at capture time. */
  htmlSubtree: string;
  /** Browser viewport at capture time (helps reproduce virtualization quirks). */
  viewport: { width: number; height: number };
  /** UA string. Helps disambiguate Chromium versions in the field. */
  userAgent: string;
}

/**
 * In-memory holder for an anomaly-armed snapshot. The overlay polls
 * (or reads on render) to decide whether to show the anomaly card.
 *
 * We hold ONE snapshot at a time. A fresh anomaly overwrites the previous —
 * we only care about the latest broken state.
 */
let armedSnapshot: Snapshot | null = null;

export function captureSnapshot(): Snapshot {
  const last = getLastExtraction();
  return {
    capturedAt: new Date().toISOString(),
    url: window.location.href,
    pageTitle: document.title,
    parsedContext: last?.context ?? null,
    diagnostics: last?.diagnostics ?? null,
    htmlSubtree: getMessageListSubtreeHtml(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    userAgent: navigator.userAgent,
  };
}

export function armAnomalySnapshot(): void {
  armedSnapshot = captureSnapshot();
}

export function getArmedSnapshot(): Snapshot | null {
  return armedSnapshot;
}

export function clearArmedSnapshot(): void {
  armedSnapshot = null;
}
