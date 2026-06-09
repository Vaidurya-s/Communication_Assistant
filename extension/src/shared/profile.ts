/**
 * Contact profile data, extracted from a LinkedIn profile page.
 *
 * Trust model: every string here is attacker-controlled in principle.
 * Anyone can write "ignore previous instructions" in their About section.
 * The backend places this entire object inside its UNTRUSTED_CONVERSATION
 * boundary.
 */
export interface ContactProfile {
  /** Display name (h1 on the profile page). */
  name: string;
  /** Tagline beneath the name. */
  headline: string;
  /** Current role (top experience entry's title). */
  role: string;
  /** Current company (top experience entry's company). */
  company: string;
  location: string;
  /** Free-form "About" section text. Truncated to keep prompts small. */
  about: string;
  /** Recent positions (most recent first). */
  experience: ContactExperience[];
  /** Education entries (most recent first). */
  education: ContactEducation[];
  /** Top listed skills. */
  skills: string[];
  /** Canonical profile URL (https://www.linkedin.com/in/<handle>/). */
  profileUrl: string;
  /** ISO timestamp this profile was extracted. */
  fetchedAt: string;
}

export interface ContactExperience {
  title: string;
  company: string;
  duration?: string;
}

export interface ContactEducation {
  school: string;
  degree?: string;
}

export const PROFILE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isProfileFresh(p: ContactProfile, now = Date.now()): boolean {
  const ts = Date.parse(p.fetchedAt);
  if (!Number.isFinite(ts)) return false;
  return now - ts < PROFILE_CACHE_TTL_MS;
}

const STORAGE_PREFIX = "profile_cache:";

function cacheKey(profileUrl: string): string {
  return STORAGE_PREFIX + canonicalProfileUrl(profileUrl);
}

/** Strip query string and fragment; ensure trailing slash. */
export function canonicalProfileUrl(url: string): string {
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/\/+$/, "");
    return `${u.origin}${path}/`;
  } catch {
    return url;
  }
}

export async function getCachedProfile(profileUrl: string): Promise<ContactProfile | null> {
  const key = cacheKey(profileUrl);
  const result = await chrome.storage.local.get(key);
  const cached = result[key] as ContactProfile | undefined;
  if (!cached) return null;
  if (!isProfileFresh(cached)) return null;
  return cached;
}

export async function setCachedProfile(profile: ContactProfile): Promise<void> {
  const key = cacheKey(profile.profileUrl);
  await chrome.storage.local.set({ [key]: profile });
}
