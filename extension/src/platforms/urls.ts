/**
 * Pure, URL-level platform predicates — NO DOM, NO chrome APIs.
 *
 * This is the only part of the platform layer the background service worker
 * imports. It must stay dependency-free so the worker bundle never pulls in
 * DOM-dependent extractor code (which would throw at import time in a worker).
 *
 * Each platform declares which URLs are "messaging" surfaces (where the overlay
 * mounts) and which are "profile" pages (for hidden-tab enrichment).
 */
import type { Platform } from "../shared/types";

/**
 * URL-hash marker the background's profile-enrichment fetcher appends when it
 * opens a profile in a hidden tab. The content script checks for it to skip
 * mounting the cold-open overlay in those throwaway tabs (they're scraped and
 * closed, never seen). A user-opened profile has no such hash, so the overlay
 * mounts there regardless of tab visibility.
 */
export const ENRICHMENT_HASH = "#comms-enrich";

export interface PlatformUrls {
  readonly platform: Platform;
  isMessagingUrl(u: URL): boolean;
  isProfileUrl(u: URL): boolean;
}

export const LINKEDIN_URLS: PlatformUrls = {
  platform: "linkedin",
  isMessagingUrl: (u) => u.hostname.includes("linkedin.com") && u.pathname.includes("/messaging/"),
  isProfileUrl: (u) => u.hostname.includes("linkedin.com") && u.pathname.startsWith("/in/"),
};

export const GMAIL_URLS: PlatformUrls = {
  platform: "gmail",
  // The overlay mounts across the Gmail app; the extractor reads whatever thread
  // is open (and degrades gracefully on the inbox list). Gmail has no profile page.
  isMessagingUrl: (u) => u.hostname === "mail.google.com" && u.pathname.startsWith("/mail/"),
  isProfileUrl: () => false,
};

/** Every platform with URL-level support. Add new platforms here. */
export const PLATFORM_URLS: readonly PlatformUrls[] = [LINKEDIN_URLS, GMAIL_URLS];

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True if any platform recognises this URL as a messaging surface. */
export function isSupportedMessagingUrl(url: string): boolean {
  const u = parse(url);
  return !!u && PLATFORM_URLS.some((p) => p.isMessagingUrl(u));
}

/** True if any platform recognises this URL as an enrichable profile page. */
export function isProfileUrl(url: string): boolean {
  const u = parse(url);
  return !!u && PLATFORM_URLS.some((p) => p.isProfileUrl(u));
}

/**
 * True if the overlay can mount here at all — a messaging surface (reply
 * drafting) OR a profile page (cold-open first-message drafting). The
 * background uses this to decide whether to inject the content script.
 */
export function isOverlayUrl(url: string): boolean {
  return isSupportedMessagingUrl(url) || isProfileUrl(url);
}
