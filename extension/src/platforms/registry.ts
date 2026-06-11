/**
 * Content-script registry: picks the extractor that handles the current page.
 * Importing this pulls in DOM-dependent extractor code, so it is content-script
 * only — the background worker uses `./urls` (pure) instead.
 */
import { linkedinExtractor } from "./linkedin";
import { gmailExtractor } from "./gmail";
import type { PlatformExtractor } from "./types";

const EXTRACTORS: readonly PlatformExtractor[] = [linkedinExtractor, gmailExtractor];

function parse(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** The extractor whose messaging surface matches this location, or null. */
export function messagingExtractor(loc: { href: string }): PlatformExtractor | null {
  const u = parse(loc.href);
  return u ? EXTRACTORS.find((e) => e.isMessagingUrl(u)) ?? null : null;
}

/** The extractor whose profile page matches this location, or null. */
export function profileExtractor(loc: { href: string }): PlatformExtractor | null {
  const u = parse(loc.href);
  return u ? EXTRACTORS.find((e) => e.isProfileUrl(u)) ?? null : null;
}
