import { describe, it, expect } from "vitest";
import { parseCorpus } from "./corpus.js";

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
