/**
 * Sectioned voice-authoring model.
 *
 * Voice is authored as discrete sections (openers, rhythm, …) stored as JSON at
 * `<voiceDir>/sections.json`, then COMPILED down to the existing single runtime
 * artifact `strategy_analysis.md`. Sections are an authoring convenience; the
 * runtime contract is unchanged — `voiceProfile.ts` / `prompt.ts` still load
 * exactly one file (see plan §3, §4.1, Phase 2).
 *
 * Tenant-aware throughout: dirs and the runtime-file path come from
 * `voiceProfile.ts` (`voiceDirFor` / `voiceProfilePath`), never hard-coded — so
 * the local tenant keeps repo-root `voice_profile/` and others land under
 * `backend/data/tenants/<id>/voice_profile/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TENANT } from "./tenant.js";
import { voiceDirFor, voiceProfilePath } from "./voiceProfile.js";

/** Canonical section keys, in compile order. */
export const SECTION_KEYS = [
  "openers",
  "rhythm",
  "disagreeing",
  "questions",
  "closings",
  "registers",
  "vocabulary",
  "declining",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

/** Human-readable heading for each section in the compiled Markdown. */
export const SECTION_LABELS: Record<SectionKey, string> = {
  openers: "How I open messages",
  rhythm: "Sentence length and rhythm",
  disagreeing: "How I disagree",
  questions: "How I ask questions",
  closings: "How I close",
  registers: "Register shifts",
  vocabulary: "Vocabulary",
  declining: "How I decline things",
};

/** Where a section's body came from. */
export type SectionSource = "distilled" | "manual" | "interview" | "imported";

export interface Section {
  body: string;
  source: string;
}

export interface SectionsDoc {
  version: number;
  updatedAt: string;
  sections: Record<SectionKey, Section>;
}

const SECTIONS_VERSION = 1;
const SECTIONS_FILE = "sections.json";

/** Absolute path to a tenant's sections.json. */
function sectionsPath(tenantId: string): string {
  return join(voiceDirFor(tenantId), SECTIONS_FILE);
}

/** A SectionsDoc with every canonical section present but empty. */
function emptyDoc(nowIso: string): SectionsDoc {
  const sections = {} as Record<SectionKey, Section>;
  for (const key of SECTION_KEYS) sections[key] = { body: "", source: "manual" };
  return { version: SECTIONS_VERSION, updatedAt: nowIso, sections };
}

/**
 * Load a tenant's sections.json, or null if it doesn't exist. Missing keys are
 * backfilled as empty so callers always get the full canonical shape.
 */
export function loadSections(tenantId: string = DEFAULT_TENANT): SectionsDoc | null {
  const path = sectionsPath(tenantId);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<SectionsDoc>;
  const doc = emptyDoc(raw.updatedAt ?? new Date().toISOString());
  doc.version = raw.version ?? SECTIONS_VERSION;
  if (raw.sections) {
    for (const key of SECTION_KEYS) {
      const s = raw.sections[key];
      if (s) doc.sections[key] = { body: s.body ?? "", source: s.source ?? "manual" };
    }
  }
  return doc;
}

/**
 * Update one section's body (and source), writing a fresh updatedAt. Creates
 * sections.json (and the voice dir) on first write.
 */
export function saveSection(
  tenantId: string,
  key: SectionKey,
  body: string,
  source: string = "manual",
): void {
  const dir = voiceDirFor(tenantId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const doc = loadSections(tenantId) ?? emptyDoc(new Date().toISOString());
  doc.sections[key] = { body, source };
  doc.updatedAt = new Date().toISOString();
  writeFileSync(sectionsPath(tenantId), JSON.stringify(doc, null, 2) + "\n", "utf-8");
}

/**
 * Assemble sections.json into a Markdown document and WRITE it to the tenant's
 * runtime artifact (strategy_analysis.md). Each non-empty section becomes a
 * `## <Label>` heading; empty sections are skipped. Returns the compiled text.
 */
export function compileSections(tenantId: string = DEFAULT_TENANT): string {
  const doc = loadSections(tenantId);
  const parts: string[] = ["# Strategy analysis — voice profile"];

  if (doc) {
    for (const key of SECTION_KEYS) {
      const body = doc.sections[key]?.body?.trim();
      if (!body) continue; // skip empty sections
      parts.push(`## ${SECTION_LABELS[key]}\n\n${body}`);
    }
  }

  const compiled = parts.join("\n\n") + "\n";

  const outPath = voiceProfilePath(tenantId);
  const dir = voiceDirFor(tenantId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, compiled, "utf-8");

  return compiled;
}

/**
 * One-time adoption of an existing (pre-sections) install: if no sections.json
 * exists but a strategy_analysis.md does, create a sections.json so the new
 * authoring model can take over without losing the hand-written profile.
 *
 * Choice on where the existing content lands: SECTION_KEYS stays strict (no
 * synthetic `imported` key, so the compile/runtime shape is unchanged). The
 * entire existing markdown is preserved verbatim in the FIRST section
 * (`openers`) with source `'imported'`; the remaining sections are left empty.
 * Nothing is lost — a re-compile reproduces the full original text (under the
 * "How I open messages" heading) — and the user can later split it across the
 * proper sections by editing. If neither/both files dictate, an empty doc is
 * still returned and persisted so subsequent saves have somewhere to land.
 */
export function adoptExisting(tenantId: string = DEFAULT_TENANT): SectionsDoc {
  const existing = loadSections(tenantId);
  if (existing) return existing;

  const dir = voiceDirFor(tenantId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const doc = emptyDoc(new Date().toISOString());

  const profilePath = voiceProfilePath(tenantId);
  if (existsSync(profilePath)) {
    const body = readFileSync(profilePath, "utf-8").trim();
    if (body) doc.sections.openers = { body, source: "imported" };
  }

  writeFileSync(sectionsPath(tenantId), JSON.stringify(doc, null, 2) + "\n", "utf-8");
  return doc;
}
