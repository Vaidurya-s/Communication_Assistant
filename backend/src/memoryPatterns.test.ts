import { describe, it, expect } from "vitest";
import {
  findRecurringTopics,
  findRelationshipStages,
  type PatternInput,
} from "./memoryPatterns.js";

function input(over: Partial<PatternInput> = {}): PatternInput {
  return { notes: [], strategies: [], ...over };
}

describe("findRecurringTopics", () => {
  it("surfaces a term that recurs across DIFFERENT contacts", () => {
    const topics = findRecurringTopics(
      input({
        notes: [
          { contact_name: "Reed", body: "Works on neuromorphic accelerators at Sandia" },
          { contact_name: "Saaketh", body: "Also neuromorphic research, same lab" },
        ],
      }),
    );
    expect(topics[0].term).toBe("neuromorphic");
    expect(topics[0].contacts).toEqual(["Reed", "Saaketh"]);
  });

  it("ignores a term used many times with ONE contact", () => {
    // Ten mentions with one person is that person's topic, not a theme of mine.
    const topics = findRecurringTopics(
      input({
        notes: Array.from({ length: 10 }, () => ({
          contact_name: "Reed",
          body: "neuromorphic neuromorphic",
        })),
      }),
    );
    expect(topics).toEqual([]);
  });

  it("will not surface a term that appears only in generated strategy prose", () => {
    // Strategy text is the model's own advice, and it writes the same shape
    // every time — real data made "potential"/"collaboration"/"opportunities"
    // the top "themes" purely because the generator repeats itself.
    const topics = findRecurringTopics(
      input({
        strategies: [
          { contact_name: "A", text: "Discuss the neuromorphic angle" },
          { contact_name: "B", text: "Discuss the neuromorphic angle" },
        ],
      }),
    );
    expect(topics).toEqual([]);
  });

  it("lets strategies reinforce a term that IS grounded in a note", () => {
    const topics = findRecurringTopics(
      input({
        notes: [{ contact_name: "A", body: "neuromorphic accelerators" }],
        strategies: [{ contact_name: "B", text: "Bring up neuromorphic work" }],
      }),
    );
    expect(topics[0].term).toBe("neuromorphic");
    expect(topics[0].contacts).toEqual(["A", "B"]);
  });

  it("drops networking boilerplate even when it appears in a note", () => {
    const topics = findRecurringTopics(
      input({
        notes: [
          { contact_name: "A", body: "Potential collaboration, explore opportunities" },
          { contact_name: "B", body: "Potential collaboration, explore opportunities" },
        ],
      }),
    );
    expect(topics).toEqual([]);
  });

  it("drops hyphen fragments that ride on a real term", () => {
    // tokenize splits "post-quantum" into "post" + "quantum"; the bare "post"
    // has the same counts as the real term and would outrank it alphabetically.
    const topics = findRecurringTopics(
      input({
        notes: [
          { contact_name: "A", body: "post-quantum cryptography" },
          { contact_name: "B", body: "post-quantum cryptography" },
        ],
      }),
    );
    expect(topics.map((t) => t.term)).not.toContain("post");
    expect(topics.map((t) => t.term)).toContain("quantum");
  });

  it("cleans malformed contact names out of the proposal body", () => {
    // Names come from scraped DOM; a bad extraction can leave newlines and
    // markup in one. The body becomes a trusted ABOUT ME item once adopted.
    const [topic] = findRecurringTopics(
      input({
        notes: [
          { contact_name: "Michal Krelina", body: "quantum governance" },
          { contact_name: "Divyanshu\n   \n  Gupta", body: "quantum computing" },
        ],
      }),
    );
    expect(topic.body).toContain("Michal Krelina, Divyanshu Gupta");
    expect(topic.body).not.toContain("\n");
  });

  it("cuts scraped UI chrome off a contact name", () => {
    // Real example from the database — thread-title extraction swallowed the
    // presence indicator into the stored name.
    const [topic] = findRecurringTopics(
      input({
        notes: [
          { contact_name: "Divyanshu Gupta Status is reachable Mobile • 10h", body: "quantum" },
          { contact_name: "Michal Krelina", body: "quantum" },
        ],
      }),
    );
    expect(topic.body).toContain("Divyanshu Gupta");
    expect(topic.body).not.toContain("reachable");
    expect(topic.body).not.toContain("10h");
  });

  it("summarises a long tail of contacts instead of listing everyone", () => {
    const notes = ["A", "B", "C", "D", "E", "F"].map((n) => ({
      contact_name: n,
      body: "neuromorphic",
    }));
    const [topic] = findRecurringTopics(input({ notes }));
    expect(topic.body).toContain("A, B, C, D and 2 others");
  });

  it("ranks by distinct contacts before raw mention count", () => {
    const topics = findRecurringTopics(
      input({
        notes: [
          // "lattice" — 2 contacts, but mentioned a lot.
          { contact_name: "A", body: "lattice lattice lattice lattice" },
          { contact_name: "B", body: "lattice lattice lattice" },
          // "photonics" — 3 contacts, mentioned once each. Should win.
          { contact_name: "C", body: "photonics" },
          { contact_name: "D", body: "photonics" },
          { contact_name: "E", body: "photonics" },
        ],
      }),
    );
    expect(topics[0].term).toBe("photonics");
    expect(topics[1].term).toBe("lattice");
  });

  it("filters conversation-meta words that appear in every thread", () => {
    const topics = findRecurringTopics(
      input({
        notes: [
          { contact_name: "A", body: "Replied to my message, thanks, wants to connect next week" },
          { contact_name: "B", body: "Replied to my message, thanks, wants to connect next week" },
        ],
      }),
    );
    // Every one of these recurs across both contacts, and none is a theme.
    for (const junk of ["replied", "message", "thanks", "wants", "connect", "next", "week"]) {
      expect(topics.map((t) => t.term)).not.toContain(junk);
    }
  });

  it("respects maxTopics and minContacts", () => {
    const notes = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].flatMap((w) => [
      { contact_name: "A", body: w },
      { contact_name: "B", body: w },
    ]);
    expect(findRecurringTopics(input({ notes }), { maxTopics: 2 })).toHaveLength(2);
    expect(findRecurringTopics(input({ notes }), { minContacts: 3 })).toEqual([]);
  });

  it("writes a proposal ready to become a context item", () => {
    const [topic] = findRecurringTopics(
      input({
        notes: [
          { contact_name: "Reed", body: "neuromorphic work" },
          { contact_name: "Saaketh", body: "neuromorphic work" },
        ],
      }),
    );
    expect(topic.title).toBe("Recurring theme: neuromorphic");
    expect(topic.body).toContain("2 conversations");
    expect(topic.body).toContain("Reed, Saaketh");
  });

  it("returns [] with no data at all", () => {
    expect(findRecurringTopics(input())).toEqual([]);
  });
});

describe("findRelationshipStages", () => {
  function strategies(pairs: Array<[string, number]>) {
    return pairs.flatMap(([name, n]) =>
      Array.from({ length: n }, (_, i) => ({ contact_name: name, text: `read ${i}` })),
    );
  }

  it("classifies by drafted-exchange count", () => {
    const out = findRelationshipStages(
      input({ strategies: strategies([["New", 1], ["Warm", 3], ["Old", 7]]) }),
    );
    const byName = Object.fromEntries(out.map((r) => [r.contact, r]));
    expect(byName.New.stage).toBe("new");
    expect(byName.Warm.stage).toBe("warming");
    expect(byName.Old.stage).toBe("established");
  });

  it("orders by exchange count, busiest first", () => {
    const out = findRelationshipStages(
      input({ strategies: strategies([["Quiet", 1], ["Busy", 9]]) }),
    );
    expect(out.map((r) => r.contact)).toEqual(["Busy", "Quiet"]);
  });

  it("phrases the hint as what was DRAFTED, not as an absolute claim", () => {
    // Replies sent outside the tool are invisible here, so the count is a floor.
    const [only] = findRelationshipStages(input({ strategies: strategies([["A", 5]]) }));
    expect(only.hint).toContain("drafted exchange");
    expect(only.exchanges).toBe(5);
  });

  it("singularises a single exchange", () => {
    const [only] = findRelationshipStages(input({ strategies: strategies([["A", 1]]) }));
    expect(only.hint).toContain("1 drafted exchange ");
    expect(only.hint).not.toContain("1 drafted exchanges");
  });

  it("ignores rows with no contact name", () => {
    const out = findRelationshipStages(input({ strategies: [{ contact_name: "", text: "x" }] }));
    expect(out).toEqual([]);
  });
});
