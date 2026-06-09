/**
 * LinkedIn profile page extractor. Runs when the content script lands on a
 * /in/<handle>/ URL. Selectors are intentionally conservative — anything we
 * can't read falls back to empty string rather than throwing. Profile pages
 * vary by viewer (logged-in vs not, premium, language) so partial extraction
 * is the norm.
 */

import type {
  ContactEducation,
  ContactExperience,
  ContactProfile,
} from "../shared/profile";
import { canonicalProfileUrl } from "../shared/profile";

const MAX_ABOUT_CHARS = 1500;
const MAX_LIST_ITEMS = 6;

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function isLinkedInProfileUrl(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    const u = new URL(href, window.location.origin);
    return u.hostname.includes("linkedin.com") && u.pathname.startsWith("/in/");
  } catch {
    return false;
  }
}

export function isOnProfilePage(): boolean {
  return (
    window.location.hostname.includes("linkedin.com") &&
    window.location.pathname.startsWith("/in/")
  );
}

function readName(): string {
  // The h1 on a profile page is overwhelmingly the contact name.
  const h1 = document.querySelector("main h1") ?? document.querySelector("h1");
  return text(h1);
}

function readHeadline(): string {
  // Common pattern: <div class="text-body-medium break-words">...</div>
  const candidates = [
    "main .text-body-medium.break-words",
    "main [data-generated-suggestion-target] + div",
    ".pv-text-details__left-panel .text-body-medium",
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    const t = text(el);
    if (t) return t;
  }
  return "";
}

function readLocation(): string {
  const candidates = [
    "main .text-body-small.inline.t-black--light.break-words",
    ".pv-text-details__left-panel .text-body-small",
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    const t = text(el);
    if (t) return t;
  }
  return "";
}

/**
 * Sections on a profile page are anchored by an id (#about, #experience,
 * #education, #skills). The visible content lives in a sibling/cousin
 * container. Walk up to the section root, then read its body.
 */
function getSectionRoot(anchorId: string): Element | null {
  const anchor = document.getElementById(anchorId);
  if (!anchor) return null;
  // Walk up to find the <section> ancestor.
  let cur: Element | null = anchor;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur.tagName === "SECTION") return cur;
    cur = cur.parentElement;
  }
  return anchor.parentElement;
}

function readAbout(): string {
  const section = getSectionRoot("about");
  if (!section) return "";
  // The visible text is usually in a span with aria-hidden="true" (LinkedIn
  // duplicates content for accessibility). Prefer the aria-hidden text.
  const spans = section.querySelectorAll('span[aria-hidden="true"]');
  for (const s of Array.from(spans)) {
    const t = text(s);
    if (t.length > 40) return t.slice(0, MAX_ABOUT_CHARS);
  }
  // Fallback: whole section text minus the "About" heading.
  const all = text(section).replace(/^About\s*/i, "").trim();
  return all.slice(0, MAX_ABOUT_CHARS);
}

interface ListItem {
  primary: string; // first significant line — usually the title/school
  secondary: string; // second line — usually company/degree
  meta: string; // remaining lines (duration, location, etc.) joined
}

function readListItems(sectionId: string): ListItem[] {
  const section = getSectionRoot(sectionId);
  if (!section) return [];
  // pvs-list__item--line-separated is LinkedIn's modern profile list item class.
  const items = section.querySelectorAll(".pvs-list__item--line-separated, li.artdeco-list__item");
  const out: ListItem[] = [];
  for (const el of Array.from(items)) {
    if (out.length >= MAX_LIST_ITEMS) break;
    // LinkedIn duplicates strings inside aria-hidden spans + visually-hidden
    // siblings. Read aria-hidden to dedupe.
    const lines: string[] = [];
    const spans = el.querySelectorAll('span[aria-hidden="true"]');
    for (const s of Array.from(spans)) {
      const t = text(s);
      if (t && !lines.includes(t)) lines.push(t);
    }
    if (lines.length === 0) continue;
    out.push({
      primary: lines[0] ?? "",
      secondary: lines[1] ?? "",
      meta: lines.slice(2).join(" · "),
    });
  }
  return out;
}

function readExperience(): ContactExperience[] {
  return readListItems("experience").map((l) => ({
    title: l.primary,
    company: l.secondary,
    duration: l.meta || undefined,
  }));
}

function readEducation(): ContactEducation[] {
  return readListItems("education").map((l) => ({
    school: l.primary,
    degree: l.secondary || undefined,
  }));
}

function readSkills(): string[] {
  const section = getSectionRoot("skills");
  if (!section) return [];
  const out: string[] = [];
  const spans = section.querySelectorAll('span[aria-hidden="true"]');
  for (const s of Array.from(spans)) {
    if (out.length >= 12) break;
    const t = text(s);
    if (!t || t.length > 60) continue;
    if (out.includes(t)) continue;
    // Filter out non-skill UI strings (LinkedIn intersperses "Endorsed by..." etc.)
    if (/endorsed|show all|see more/i.test(t)) continue;
    out.push(t);
  }
  return out;
}

export function extractLinkedInProfile(): ContactProfile {
  const experience = readExperience();
  const profileUrl = canonicalProfileUrl(window.location.href);
  return {
    name: readName(),
    headline: readHeadline(),
    role: experience[0]?.title ?? "",
    company: experience[0]?.company ?? "",
    location: readLocation(),
    about: readAbout(),
    experience,
    education: readEducation(),
    skills: readSkills(),
    profileUrl,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Find the profile URL of the contact from the currently-open thread.
 * Returns null if no link to a /in/ page is found in the thread header.
 */
export function getThreadContactProfileUrl(): string | null {
  // The thread header link to profile is the most reliable; fall back to any
  // anchor at the top of the messaging pane.
  const candidates = [
    "a.msg-thread__link-to-profile[href]",
    ".msg-entity-lockup a[href*='/in/']",
    ".msg-thread-actions a[href*='/in/']",
  ];
  for (const sel of candidates) {
    const a = document.querySelector(sel) as HTMLAnchorElement | null;
    if (a && isLinkedInProfileUrl(a.href)) return canonicalProfileUrl(a.href);
  }
  // Last-ditch: any /in/ link inside what looks like the active thread.
  const anchors = document.querySelectorAll("a[href*='/in/']");
  for (const el of Array.from(anchors)) {
    const a = el as HTMLAnchorElement;
    if (isLinkedInProfileUrl(a.href)) return canonicalProfileUrl(a.href);
  }
  return null;
}

/**
 * Wait until the profile page DOM is populated enough to extract from.
 * LinkedIn loads sections lazily; h1 + at least one of {about, experience}
 * is a reasonable readiness signal.
 */
export function waitForProfileReady(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const haveName = !!text(document.querySelector("h1"));
      const haveSection =
        !!document.getElementById("about") ||
        !!document.getElementById("experience");
      if (haveName && haveSection) {
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(haveName); // partial is OK
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
}
