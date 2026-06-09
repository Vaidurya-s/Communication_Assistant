/**
 * Out-of-band LinkedIn profile fetcher.
 *
 * Flow when a content script on a thread asks us to enrich a contact:
 *   1. Look up the canonical profile URL in chrome.storage.local cache.
 *      If fresh, do nothing.
 *   2. Open the profile URL in a background (inactive) tab.
 *   3. The content script auto-injected into that tab extracts the profile
 *      and sends PROFILE_EXTRACTED. We listen for it.
 *   4. Close the tab. Cache the result.
 *
 * Dedupe: if a fetch for the same URL is already in flight, drop the new
 * request. Stale entries time out after 30s.
 */

import {
  canonicalProfileUrl,
  getCachedProfile,
  setCachedProfile,
  type ContactProfile,
} from "../shared/profile";

const FETCH_TIMEOUT_MS = 30_000;

interface InFlight {
  tabId: number;
  startedAt: number;
}

const inFlight = new Map<string, InFlight>();

function isLinkedInProfileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.includes("linkedin.com") && u.pathname.startsWith("/in/");
  } catch {
    return false;
  }
}

export async function getProfileForUrl(profileUrl: string): Promise<ContactProfile | null> {
  const url = canonicalProfileUrl(profileUrl);
  const cached = await getCachedProfile(url);
  return cached;
}

/**
 * Public entrypoint from content script. Idempotent. Resolves immediately;
 * the actual extraction happens asynchronously via runtime.onMessage.
 */
export async function requestProfileFetch(profileUrl: string): Promise<void> {
  if (!isLinkedInProfileUrl(profileUrl)) return;
  const url = canonicalProfileUrl(profileUrl);

  // Cache hit → nothing to do.
  const cached = await getCachedProfile(url);
  if (cached) return;

  // Already fetching → no-op.
  const existing = inFlight.get(url);
  if (existing && Date.now() - existing.startedAt < FETCH_TIMEOUT_MS) return;

  // Open hidden tab. The content script auto-injects (matches linkedin.com/*).
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    console.warn("[profile] tab open failed:", (err as Error).message);
    return;
  }
  if (tab.id === undefined) return;

  inFlight.set(url, { tabId: tab.id, startedAt: Date.now() });

  // Failsafe: if PROFILE_EXTRACTED never arrives, close the tab after timeout.
  setTimeout(() => {
    const cur = inFlight.get(url);
    if (cur && cur.tabId === tab.id) {
      inFlight.delete(url);
      chrome.tabs.remove(tab.id!).catch(() => {});
      console.warn("[profile] fetch timed out:", url);
    }
  }, FETCH_TIMEOUT_MS);
}

/**
 * Called by background's runtime.onMessage handler when a PROFILE_EXTRACTED
 * message arrives. Returns true if the message corresponded to one of our
 * in-flight fetches (so the caller knows to swallow rather than rebroadcast).
 */
export async function handleProfileExtracted(
  profile: ContactProfile,
  senderTabId: number | undefined,
): Promise<boolean> {
  const url = canonicalProfileUrl(profile.profileUrl);
  const entry = inFlight.get(url);
  if (!entry) return false;
  // Belt-and-suspenders: sender tab should match the one we opened.
  if (senderTabId !== undefined && senderTabId !== entry.tabId) {
    console.warn(
      `[profile] sender tab ${senderTabId} != expected ${entry.tabId} for ${url}`,
    );
  }

  await setCachedProfile(profile);
  inFlight.delete(url);

  if (entry.tabId !== undefined) {
    chrome.tabs.remove(entry.tabId).catch(() => {});
  }
  return true;
}
