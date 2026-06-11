/**
 * A platform extractor abstracts everything platform-specific about reading a
 * conversation and a contact's profile from the page. The content script
 * dispatches to whichever extractor matches the current URL, so adding a new
 * platform (e.g. Gmail) means writing one of these — not touching the content
 * script's plumbing.
 *
 * These methods touch the DOM, so this interface (and its implementations) are
 * content-script only. The background worker uses the pure URL predicates in
 * `./urls` instead.
 */
import type { ExtractionResult, Platform } from "../shared/types";
import type { ContactProfile } from "../shared/profile";

export interface PlatformExtractor {
  readonly platform: Platform;

  /** URL predicates (same logic as `./urls`, exposed for the content registry). */
  isMessagingUrl(u: URL): boolean;
  isProfileUrl(u: URL): boolean;

  /** Read the current conversation + diagnostics from the messaging surface. */
  extractContext(): Promise<ExtractionResult>;
  /** Scroll back to load older messages; returns wall-clock ms spent (-1 if skipped). */
  backfillMessages(): Promise<number>;
  /** Observe the message list and fire onChange (debounced) on new activity. */
  installMessageObserver(onChange: () => void): MutationObserver | null;
  /** Outer HTML of the message subtree, for forensic snapshots. */
  getCaptureHtml(): string;
  /** The contact's profile URL discoverable from the open thread, or null. */
  getContactProfileUrl(): string | null;

  /** Profile-page side (hidden tab): wait until the profile DOM is ready. */
  waitForProfileReady(timeoutMs: number): Promise<boolean>;
  /** Profile-page side: extract the contact's profile. */
  extractProfile(): ContactProfile;
}
