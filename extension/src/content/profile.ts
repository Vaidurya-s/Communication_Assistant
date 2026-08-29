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
import {
  LINKEDIN_PROFILE_SELECTORS as P,
  PROFILE_SECTIONS,
  queryChain,
  queryFirstChain,
  sduiCard,
  type ProfileSectionKey,
} from "./selectors";

const MAX_ABOUT_CHARS = 1500;
const MAX_LIST_ITEMS = 6;
const MAX_SKILLS = 12;

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Visible text of an element, split into trimmed non-empty lines. */
function lines(el: Element | null | undefined): string[] {
  const raw = (el as HTMLElement | null | undefined)?.innerText ?? el?.textContent ?? "";
  return raw
    .split("\n")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Chrome-only UI strings LinkedIn interleaves with real content. They're not
 * part of anyone's profile, and left in they become fake skills and fake job
 * titles.
 */
const UI_NOISE =
  /^(…|\.\.\.|more|see more|show all|show less|endorsed|endorse|edit|add section|enhance profile|contact info|verify in|·)$/i;

function isNoise(s: string): boolean {
  return !s || UI_NOISE.test(s) || /^show all \d+/i.test(s);
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
  // h1 (legacy) → h2 in the top card (server-driven layout). See
  // LINKEDIN_PROFILE_SELECTORS.name.
  const fromDom = text(queryFirstChain(document, P.name).elements[0]);
  if (fromDom) return fromDom;

  // Layout-proof fallback: the page <title> is "<Name> | LinkedIn", sometimes
  // prefixed with a "(3) " notification count.
  const title = (document.title || "").replace(/^\(\d+\)\s*/, "").split("|")[0].trim();
  if (title && !/^linkedin$/i.test(title)) return title;

  // Last resort: og:title. Absent on the logged-in SPA (verified 2026-08-29),
  // but still present on the logged-out public profile view.
  const og = document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? "";
  const ogName = og.split("|")[0].split(" - ")[0].trim();
  return /linkedin/i.test(ogName) ? "" : ogName;
}

/** The top card, if this page has one. */
function topcard(): Element | null {
  return queryFirstChain(document, P.topcard).elements[0] ?? null;
}

/**
 * The identity block inside the top card: the nearest ancestor of the name that
 * also holds the headline and company as DIRECT-CHILD <p> elements.
 *
 * Verified live: the top card is ~10 levels of anonymous <div>, and the only
 * thing distinguishing the headline from the half-dozen other <p> elements in
 * the card (a "Verify in 2 minutes" promo, "500+ connections", four "Get
 * started" upsells) is that the real identity fields are direct children of the
 * block that contains the name heading, while the noise is nested deeper inside
 * <a> wrappers. So we anchor on the name and read only its siblings — never a
 * descendant search over the whole card.
 */
function identityBlock(): Element | null {
  const card = topcard();
  if (!card) return null;
  const heading = card.querySelector("h1, h2");
  if (!heading) return null;

  // Climb until we reach an ancestor that has direct-child <p> elements.
  let cur: Element | null = heading.parentElement;
  for (let i = 0; i < 6 && cur && cur !== card; i++) {
    if (Array.from(cur.children).some((c) => c.tagName === "P")) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/** Direct-child <p> text of the identity block, noise removed, in DOM order. */
function identityLines(): string[] {
  const block = identityBlock();
  if (!block) return [];
  return Array.from(block.children)
    .filter((c) => c.tagName === "P")
    .map((c) => text(c))
    .filter((t) => !isNoise(t));
}

function readHeadline(): string {
  // Legacy class hooks first — some accounts still get the old layout.
  for (const sel of [
    "main .text-body-medium.break-words",
    ".pv-text-details__left-panel .text-body-medium",
  ]) {
    const t = text(document.querySelector(sel));
    if (t) return t;
  }
  // Server-driven layout: first direct-child <p> of the identity block.
  return identityLines()[0] ?? "";
}

function readLocation(): string {
  for (const sel of [
    "main .text-body-small.inline.t-black--light.break-words",
    ".pv-text-details__left-panel .text-body-small",
  ]) {
    const t = text(document.querySelector(sel));
    if (t) return t;
  }

  // Server-driven layout: the location sits in a sub-block of the identity
  // block alongside the "Contact info" link — that link is the one stable
  // landmark down there, so we find it and take the first <p> beside it.
  const block = identityBlock();
  if (!block) return "";
  const contactLink = Array.from(block.querySelectorAll("a, p")).find((el) =>
    /^contact info$/i.test(text(el)),
  );
  const group = contactLink?.closest("div");
  if (group) {
    const first = Array.from(group.querySelectorAll("p"))
      .map((p) => text(p))
      .find((t) => !isNoise(t));
    if (first) return first;
  }
  return "";
}

/**
 * Sections on a profile page are anchored by an id (#about, #experience,
 * #education, #skills). The visible content lives in a sibling/cousin
 * container. Walk up to the section root, then read its body.
 */
function climbToSection(start: Element, maxHops: number): Element | null {
  let cur: Element | null = start;
  for (let i = 0; i < maxHops && cur; i++) {
    if (cur.tagName === "SECTION") return cur;
    cur = cur.parentElement;
  }
  return start.parentElement;
}

/**
 * Find a section's container. Three strategies, most-durable first:
 *   1. The server-driven card id (`…profile.card.<ref>About`) — stable across
 *      deploys because the trailing section name is semantic, not a hash.
 *   2. The legacy id anchor (#about, #experience, …).
 *   3. The section's <h2>/<h3> heading text, climbed to its container.
 * Each is independent of the others, so a redesign has to break all three.
 */
function getSectionRoot(key: ProfileSectionKey): Element | null {
  const name = PROFILE_SECTIONS[key];

  const card = document.querySelector(sduiCard(name));
  if (card) return card;

  const anchor = document.getElementById(key);
  if (anchor) return climbToSection(anchor, 6);

  const heading = Array.from(
    document.querySelectorAll("main h2, main h3, section h2, section h3"),
  ).find((el) => text(el).toLowerCase() === name.toLowerCase());
  return heading ? climbToSection(heading, 8) : null;
}

function readAbout(): string {
  const section = getSectionRoot("about");
  if (!section) return "";

  // Legacy: the visible text was duplicated into an aria-hidden twin.
  for (const s of Array.from(section.querySelectorAll('span[aria-hidden="true"]'))) {
    const t = text(s);
    if (t.length > 40) return t.slice(0, MAX_ABOUT_CHARS);
  }

  // Server-driven layout: the bio is the card's longest <p>. Taking the longest
  // (rather than the first) skips the "Top skills" sub-block LinkedIn now nests
  // inside the About card.
  const longest = Array.from(section.querySelectorAll("p"))
    .map((p) => text(p))
    .filter((t) => t.length > 40)
    .sort((a, b) => b.length - a.length)[0];
  if (longest) return stripTruncationSuffix(longest).slice(0, MAX_ABOUT_CHARS);

  // Fallback: whole section text minus the "About" heading.
  const all = text(section).replace(/^About\s*/i, "").trim();
  return stripTruncationSuffix(all).slice(0, MAX_ABOUT_CHARS);
}

/** LinkedIn appends a "…more" toggle inside the bio paragraph; drop it. */
function stripTruncationSuffix(s: string): string {
  return s.replace(/\s*[….]{1,3}\s*(see\s+)?more\s*$/i, "").trim();
}

interface ListItem {
  primary: string; // first significant line — usually the title/school
  secondary: string; // second line — usually company/degree
  meta: string; // remaining lines (duration, location, etc.) joined
}

/**
 * Read the entries of a list section (Experience / Education).
 *
 * Entry text is gathered from whichever carrier the layout uses — the legacy
 * aria-hidden twins, or plain <p>/<span> leaves on the server-driven layout —
 * de-duplicated, with UI noise removed. We take the section's own heading out
 * too, since a structural `li` fallback can otherwise pick it up.
 *
 * CAVEAT, stated plainly: the *container* strategies here are verified against
 * real DOM, but the per-entry markup of an Experience/Education card is NOT —
 * the profile available for capture has no such sections, and reading a
 * stranger's profile to get them was out of scope. The reader is therefore
 * written to depend only on what every layout has in common (a list entry with
 * text leaves in visual order) rather than on a shape we guessed at. If it does
 * come back empty on a real profile, `profileExtractionGaps` below says so out
 * loud instead of silently returning a blank profile.
 */
function readListItems(key: ProfileSectionKey): ListItem[] {
  const section = getSectionRoot(key);
  if (!section) return [];

  const heading = PROFILE_SECTIONS[key].toLowerCase();
  // First selector in the chain that matches wins — legacy class hooks before
  // the structural `li`, so an old layout never falls through to the loose one.
  const candidates = queryChain(section, P.listItem).elements;

  const out: ListItem[] = [];
  for (const el of candidates) {
    if (out.length >= MAX_LIST_ITEMS) break;
    const parts = entryLines(el).filter((t) => t.toLowerCase() !== heading);
    if (parts.length === 0) continue;
    out.push({
      primary: parts[0] ?? "",
      secondary: parts[1] ?? "",
      meta: parts.slice(2).join(" · "),
    });
  }
  return out;
}

/** De-duplicated, noise-free text leaves of one list entry, in document order. */
function entryLines(el: Element): string[] {
  for (const sel of P.listItemText) {
    const found: string[] = [];
    for (const node of Array.from(el.querySelectorAll(sel))) {
      // Only leaf carriers — a wrapper <span> would repeat its children's text.
      if (node.childElementCount > 0) continue;
      const t = text(node);
      if (isNoise(t) || found.includes(t)) continue;
      found.push(t);
    }
    if (found.length > 0) return found;
  }
  // Nothing matched a text carrier — fall back to the entry's rendered lines.
  return lines(el).filter((t) => !isNoise(t));
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
  const out: string[] = [];
  const push = (t: string) => {
    if (!t || t.length > 60 || isNoise(t) || out.includes(t)) return;
    if (/endorsed/i.test(t)) return;
    if (out.length < MAX_SKILLS) out.push(t);
  };

  const section = getSectionRoot("skills");
  if (section) {
    for (const s of Array.from(section.querySelectorAll('span[aria-hidden="true"]'))) {
      push(text(s));
    }
    if (out.length === 0) {
      for (const l of readListItems("skills")) push(l.primary);
    }
  }

  // The server-driven layout also surfaces a "Top skills" line inside the About
  // card — a single bullet-separated string. It's the only skills signal on a
  // profile with no Skills section, so read it when we have nothing else.
  if (out.length === 0) {
    const about = getSectionRoot("about");
    const topSkills = Array.from(about?.querySelectorAll("p") ?? [])
      .map((p) => text(p))
      .find((t) => t.includes("•"));
    if (topSkills) topSkills.split("•").forEach((s) => push(s.trim()));
  }

  return out;
}

/**
 * Which profile fields came back empty. LinkedIn redesigns silently, and the
 * failure mode we just fixed was a profile that extracted to an empty shell
 * with no signal that anything was wrong — enrichment and cold-open drafts
 * quietly lost their grounding. Naming the gaps gives the snapshot workflow in
 * CLAUDE.md something to act on.
 */
export function profileExtractionGaps(p: ContactProfile): string[] {
  const gaps: string[] = [];
  if (!p.name) gaps.push("name");
  if (!p.headline) gaps.push("headline");
  if (!p.location) gaps.push("location");
  if (!p.about) gaps.push("about");
  if (p.experience.length === 0) gaps.push("experience");
  if (p.education.length === 0) gaps.push("education");
  if (p.skills.length === 0) gaps.push("skills");
  return gaps;
}

export function extractLinkedInProfile(): ContactProfile {
  const profile = buildProfile();
  // Say it out loud when a redesign has hollowed this out. The bug this
  // replaced returned an empty shell in silence, so enrichment and cold-open
  // drafts lost their grounding with nothing in the logs to explain it.
  const gaps = profileExtractionGaps(profile);
  if (gaps.length >= 4) {
    console.warn(
      `[comms] LinkedIn profile extraction is mostly empty (missing: ${gaps.join(", ")}). ` +
        `The profile layout has probably changed — capture a snapshot from the overlay ` +
        `debug pane and fix content/selectors.ts against the real DOM.`,
    );
  }
  return profile;
}

function buildProfile(): ContactProfile {
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
      const haveName = !!readName();
      const haveSection =
        !!getSectionRoot("about") || !!getSectionRoot("experience");
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
