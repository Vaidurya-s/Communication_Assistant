import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendExchange,
  corpusPath,
  loadCorpusExchanges,
  parseCorpus,
  resetCorpusCache,
} from "./corpus.js";
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

describe("appendExchange — closing the corpus loop", () => {
  const TENANT = "corpus-append-test";
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = voiceDirFor(TENANT);
    mkdirSync(dir, { recursive: true });
    file = join(dir, "linkedin_successful_messages.md");
    resetCorpusCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetCorpusCache();
  });

  const exchange = (contact: string, replied = true) => ({
    contact,
    context: "cold outreach about PQC",
    turns: replied
      ? [
          { isSelf: true, text: "Hi — I've been working on ML-KEM in hardware." },
          { isSelf: false, text: "Happy to chat, send over your notes." },
        ]
      : [{ isSelf: true, text: "Hi — I've been working on ML-KEM in hardware." }],
  });

  it("writes an entry that parseCorpus reads straight back as an example", () => {
    // The whole point: an appended exchange must be retrievable immediately, so
    // it has to satisfy isTranscribedExchange on the shape we write.
    appendExchange(TENANT, exchange("Reed Wittman"), "2026-08-30T10:00:00Z");
    const items = loadCorpusExchanges(TENANT);
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain("Reed Wittman");
    expect(items[0].body).toContain("ML-KEM in hardware");
    expect(items[0].body).toContain("Happy to chat");
  });

  it("creates the file with a header when there is none", () => {
    appendExchange(TENANT, exchange("Reed"), "2026-08-30T10:00:00Z");
    expect(readFileSync(file, "utf-8")).toContain("# Successful messages");
  });

  it("appends rather than replacing, and busts the cache", () => {
    appendExchange(TENANT, exchange("First"), "2026-08-30T10:00:00Z");
    loadCorpusExchanges(TENANT); // warm the cache
    appendExchange(TENANT, exchange("Second"), "2026-08-30T11:00:00Z");
    expect(loadCorpusExchanges(TENANT).map((i) => i.title.split(" (")[0])).toEqual(["First", "Second"]);
  });

  it("computes reply rates and rewrites the block rather than duplicating it", () => {
    appendExchange(TENANT, exchange("Replied"), "2026-08-30T10:00:00Z");
    appendExchange(TENANT, exchange("Ignored", false), "2026-08-30T11:00:00Z");
    const text = readFileSync(file, "utf-8");
    expect(text.match(/comms:auto-stats/g)).toHaveLength(2); // one open, one close
    expect(text).toContain("1/2 exchanges got a reply (50%)");
  });

  it("never treats the computed stats block as a few-shot example", () => {
    // It has a `##` heading like an exchange does, but transcribes no message.
    appendExchange(TENANT, exchange("Reed"), "2026-08-30T10:00:00Z");
    const titles = loadCorpusExchanges(TENANT).map((i) => i.title);
    expect(titles.some((t) => /reply rates/i.test(t))).toBe(false);
    expect(loadCorpusExchanges(TENANT)[0].body).not.toContain("comms:auto-stats");
  });

  it("leaves the user's own prose outside the markers untouched", () => {
    writeFileSync(
      file,
      "# Successful messages\n\nMy own notes I care about.\n\n## Openers by audience\n\n- Academic: Namaste Sir\n",
      "utf-8",
    );
    appendExchange(TENANT, exchange("Reed"), "2026-08-30T10:00:00Z");
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("My own notes I care about.");
    expect(text).toContain("## Openers by audience");
    expect(text).toContain("- Academic: Namaste Sir");
  });

  it("reports per-tag rates when entries carry a tag", () => {
    appendExchange(TENANT, { ...exchange("A"), tag: "crypto template" }, "2026-08-30T10:00:00Z");
    appendExchange(
      TENANT,
      { ...exchange("B", false), tag: "crypto template" },
      "2026-08-30T11:00:00Z",
    );
    expect(readFileSync(file, "utf-8")).toContain("`crypto template`: 1/2 (50%)");
  });

  it("counts a reply name-agnostically, so hand-written entries still tally", () => {
    // The hand-written corpus attributes turns as "Vaidurya → Chitra"; appended
    // ones use "Me → Chitra". A rule keyed to either would miscount the other.
    writeFileSync(
      file,
      [
        "# Successful messages",
        "",
        "## 1. Chitra (hand-written)",
        "",
        "**Vaidurya → Chitra:**",
        "> Hi ma'am",
        "",
        "**Chitra → Vaidurya:**",
        "> I'll get back to you",
        "",
      ].join("\n"),
      "utf-8",
    );
    appendExchange(TENANT, exchange("Reed"), "2026-08-30T10:00:00Z");
    expect(readFileSync(file, "utf-8")).toContain("2/2 exchanges got a reply (100%)");
  });

  it("routes a Gmail exchange to the Gmail corpus", () => {
    appendExchange(TENANT, exchange("Reed"), "2026-08-30T10:00:00Z", "gmail");
    expect(existsSync(join(dir, "gmail_successful_messages.md"))).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("rejects an entry with no contact or no content", () => {
    expect(() => appendExchange(TENANT, { contact: "", turns: [{ isSelf: true, text: "x" }] })).toThrow();
    expect(() => appendExchange(TENANT, { contact: "A", turns: [{ isSelf: true, text: "  " }] })).toThrow();
  });
});
