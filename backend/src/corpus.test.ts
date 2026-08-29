import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { corpusPath, loadCorpusExchanges, parseCorpus, resetCorpusCache } from "./corpus.js";
import { voiceDirFor } from "./voiceProfile.js";

// A miniature of the real file's shape: a title + capture-notes preamble, then
// numbered `##` exchange sections separated by `---` rules.
const SAMPLE = `# LinkedIn — Successful Formal Messages (Received Replies)

Captured from LinkedIn DMs on 2026-05-14. Only includes messages where the
recipient replied.

---

## 1. Chitra Shukla (Researcher, cold outreach about PQC)

**Me → Chitra:**
> Hi ma'am,
> I was experimenting with ML-KEM and ML-DSA.

**Chitra → Me:** "Thanks, I would get back to you soon."

---

## 2. Rahul Verma (FPGA recruiter)

**Me → Rahul:**
> Thanks for reaching out — the RV32IM core is on GitHub.
`;

describe("parseCorpus", () => {
  it("splits on ## headings and drops the preamble", () => {
    const items = parseCorpus(SAMPLE);
    expect(items).toHaveLength(2);
    // The `#` title and the capture notes above the first `##` are provenance,
    // not writing samples — they must not become an item.
    expect(items.some((i) => i.title.includes("Successful Formal Messages"))).toBe(false);
  });

  it("strips the leading ordinal from the title", () => {
    const items = parseCorpus(SAMPLE);
    expect(items[0].title).toBe("Chitra Shukla (Researcher, cold outreach about PQC)");
    expect(items[1].title).toBe("Rahul Verma (FPGA recruiter)");
  });

  it("keeps the exchange body and drops the --- separators", () => {
    const items = parseCorpus(SAMPLE);
    expect(items[0].body).toContain("ML-KEM and ML-DSA");
    expect(items[0].body).toContain("Thanks, I would get back to you soon.");
    // The next heading's content must not bleed into the previous item.
    expect(items[0].body).not.toContain("RV32IM");
    expect(items[0].body).not.toContain("---");
  });

  it("stamps every item as an exchange so it ranks like a RetrievableItem", () => {
    for (const item of parseCorpus(SAMPLE)) {
      expect(item.type).toBe("exchange");
      expect(typeof item.body).toBe("string");
    }
  });

  it("treats ### as content within an exchange, not a new item", () => {
    const items = parseCorpus("## 1. A\n### Context\n> body text\n## 2. B\n> more");
    expect(items).toHaveLength(2);
    expect(items[0].body).toContain("### Context");
  });

  it("drops a heading with no content under it", () => {
    const items = parseCorpus("## 1. Empty\n\n---\n\n## 2. Real\n**Me → Them:** hi");
    expect(items.map((i) => i.title)).toEqual(["Real"]);
  });

  it("skips analysis sections that transcribe no message", () => {
    // The real corpus interleaves exchanges with the user's own distilled notes
    // ("Punctuation quirks", "Openers by audience"). Those are already compiled
    // into the voice profile — presenting one as "a message I sent" would be
    // false, and it would crowd out a real example.
    const items = parseCorpus(
      [
        "## 1. Real Person (outreach)",
        "",
        "**Me → Them:** hello there",
        "",
        "## Punctuation quirks",
        "",
        '- Double "??" on real questions',
        "- Comfortable with \"ma'am\"",
        "",
        "## Openers by audience",
        "",
        "- **Academic professor:** Namaste Sir,",
      ].join("\n"),
    );
    expect(items.map((i) => i.title)).toEqual(["Real Person (outreach)"]);
  });

  it("accepts a blockquote as evidence of a transcribed message", () => {
    const items = parseCorpus("## 1. A\n> Hi ma'am, about ML-KEM\n## 2. Notes\n- a bullet");
    expect(items.map((i) => i.title)).toEqual(["A"]);
  });

  it("a top-level heading closes a section without bleeding into it", () => {
    // The real file has a `# Part 2 — Deeper Dive` divider partway through.
    const items = parseCorpus(
      ["## 1. A", "> msg", "", "# Part 2 — Deeper Dive", "", "intro prose", "", "## 2. B", "> other"].join("\n"),
    );
    expect(items).toHaveLength(2);
    expect(items[0].body).not.toContain("Part 2");
    expect(items[0].body).not.toContain("intro prose");
  });

  it("returns [] for an empty or heading-less corpus", () => {
    expect(parseCorpus("")).toEqual([]);
    expect(parseCorpus("# Just a title\n\nsome prose, no sections")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const items = parseCorpus("## 1. A\r\n> body line\r\n## 2. B\r\n> other");
    expect(items).toHaveLength(2);
    expect(items[0].body).toBe("> body line");
  });
});

/**
 * Platform resolution needs real files on disk, so these use a throwaway tenant
 * under `backend/data/tenants/` (gitignored, and the same path the app itself
 * uses for a hosted tenant) rather than mocking the fs.
 */
describe("corpusPath / loadCorpusExchanges — platform resolution", () => {
  const TENANT = "corpus-platform-test";
  let dir: string;

  const EXCHANGE = (who: string) => `## 1. ${who} (test)\n\n**Me → ${who}:**\n> hello from ${who}\n`;

  beforeEach(() => {
    dir = voiceDirFor(TENANT);
    mkdirSync(dir, { recursive: true });
    resetCorpusCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetCorpusCache();
  });

  it("prefers the platform-specific corpus when it exists", () => {
    writeFileSync(join(dir, "linkedin_successful_messages.md"), EXCHANGE("LinkedInPerson"));
    writeFileSync(join(dir, "gmail_successful_messages.md"), EXCHANGE("GmailPerson"));
    expect(loadCorpusExchanges(TENANT, "gmail")[0].title).toContain("GmailPerson");
    expect(loadCorpusExchanges(TENANT, "linkedin")[0].title).toContain("LinkedInPerson");
  });

  it("falls back to the LinkedIn corpus when the platform has none", () => {
    // Imperfect-register examples beat no examples for a user who has only ever
    // curated the original corpus.
    writeFileSync(join(dir, "linkedin_successful_messages.md"), EXCHANGE("LinkedInPerson"));
    expect(loadCorpusExchanges(TENANT, "gmail")[0].title).toContain("LinkedInPerson");
  });

  it("treats an absent platform as LinkedIn, exactly as before", () => {
    writeFileSync(join(dir, "linkedin_successful_messages.md"), EXCHANGE("LinkedInPerson"));
    expect(loadCorpusExchanges(TENANT)).toEqual(loadCorpusExchanges(TENANT, "linkedin"));
  });

  it("caches per FILE, so one platform's corpus never serves another", () => {
    writeFileSync(join(dir, "linkedin_successful_messages.md"), EXCHANGE("LinkedInPerson"));
    writeFileSync(join(dir, "gmail_successful_messages.md"), EXCHANGE("GmailPerson"));
    // Warm the cache with LinkedIn first; Gmail must not hit that entry.
    loadCorpusExchanges(TENANT, "linkedin");
    expect(loadCorpusExchanges(TENANT, "gmail")[0].title).toContain("GmailPerson");
  });

  it("returns [] and never throws when nothing is on disk", () => {
    expect(loadCorpusExchanges(TENANT, "gmail")).toEqual([]);
    expect(loadCorpusExchanges("no-such-tenant-at-all")).toEqual([]);
  });

  it("reports a stable path even when no corpus exists", () => {
    expect(corpusPath(TENANT, "gmail")).toContain("linkedin_successful_messages.md");
  });
});
