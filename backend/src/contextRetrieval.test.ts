import { describe, it, expect } from "vitest";
import {
  selectRelevantContext,
  tokenize,
  type RetrievableItem,
} from "./contextRetrieval.js";

/** Minimal item factory — only the fields ranking reads. */
function item(
  title: string,
  body: string,
  tags?: string[],
  type = "project",
): RetrievableItem {
  return { type, title, body, tags };
}

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, drops short tokens and stopwords", () => {
    expect(tokenize("Raft-based STORAGE engine, in Go!")).toEqual([
      "raft",
      "based",
      "storage",
      "engine",
    ]);
    // "in" / "go" are < 3 chars; "the"/"and" are stopwords.
    expect(tokenize("the and a to")).toEqual([]);
  });

  it("does not throw on empty input", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("selectRelevantContext", () => {
  it("returns all items unchanged (original order) when count <= max", () => {
    const items = [
      item("Alpha", "first"),
      item("Beta", "second"),
      item("Gamma", "third"),
    ];
    const out = selectRelevantContext(items, "anything at all", { max: 4 });
    expect(out).toEqual(items);
    // Same identities, preserved order.
    expect(out.map((i) => i.title)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("ranks the on-topic item above off-topic ones for a given signal", () => {
    const items = [
      item("Marketing campaign", "Ran brand and design ads for a launch"),
      item(
        "Distributed storage engine",
        "Built a Raft-based replicated storage system in Go for consensus",
      ),
      // A second, weaker on-topic item: shares "distributed"/"systems" with the
      // signal but fewer terms than the storage engine.
      item("Systems notes", "Notes on distributed systems design tradeoffs"),
      item("Cooking blog", "Recipes and food photography hobby"),
      item("Photography", "Landscape and portrait photography"),
    ];
    const signal =
      "We are building distributed systems with Raft consensus and replicated storage";

    const out = selectRelevantContext(items, signal, { max: 2 });
    const titles = out.map((i) => i.title);

    // The storage item is the clear on-topic match and must be selected first;
    // the weaker systems item comes second. Off-topic items are dropped.
    expect(titles).toEqual(["Distributed storage engine", "Systems notes"]);
    expect(titles).not.toContain("Marketing campaign");
  });

  it("title/tag match outranks a body-only match of similar length", () => {
    const signal = "Looking for someone with kubernetes experience";
    const items = [
      // Body-only match: "kubernetes" appears in the body.
      item(
        "Side project",
        "A small tool I wrote that happens to mention kubernetes once",
      ),
      // Title + tag match: "kubernetes" appears in both title and tags.
      item("Kubernetes operator", "A controller that reconciles cluster state", [
        "kubernetes",
        "operators",
      ]),
      // Filler off-topic items so we exceed max and ranking actually runs.
      item("Gardening", "Tomatoes and herbs"),
      item("Travel", "Trips around the world"),
      item("Music", "Guitar and piano"),
    ];

    const out = selectRelevantContext(items, signal, { max: 1 });
    expect(out[0].title).toBe("Kubernetes operator");
  });

  it("empty signal returns the first `max` items, stably, without throwing", () => {
    const items = [
      item("One", "a"),
      item("Two", "b"),
      item("Three", "c"),
      item("Four", "d"),
      item("Five", "e"),
      item("Six", "f"),
    ];
    const out = selectRelevantContext(items, "", { max: 3 });
    // All scores are 0 → stable by original index → the first three.
    expect(out.map((i) => i.title)).toEqual(["One", "Two", "Three"]);
  });

  it("fills up to max with zero-overlap items when too few positives exist", () => {
    const signal = "graph database query engine";
    const items = [
      item("Graph engine", "A query engine over a graph database"), // positive
      item("Knitting", "Scarves and hats"),
      item("Sailing", "Boats and wind"),
      item("Baking", "Bread and cake"),
      item("Running", "Marathons"),
    ];
    const out = selectRelevantContext(items, signal, { max: 3 });
    expect(out).toHaveLength(3);
    // The positive-scoring item is first; the rest fill from original order.
    expect(out[0].title).toBe("Graph engine");
  });

  it("never exceeds max and only returns items from the input", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      item(`Item ${i}`, `body number ${i} storage raft`),
    );
    const out = selectRelevantContext(items, "storage raft consensus", { max: 4 });
    expect(out.length).toBeLessThanOrEqual(4);
    for (const o of out) {
      expect(items).toContain(o);
    }
  });

  it("uses a default max of 4 when opts is omitted", () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      item(`T${i}`, `body ${i}`),
    );
    const out = selectRelevantContext(items, "");
    expect(out).toHaveLength(4);
  });

  it("preserves the full generic item shape (extra fields ride along)", () => {
    type Extended = RetrievableItem & { id: number; confirmed: 0 | 1 };
    const items: Extended[] = [
      { id: 1, confirmed: 1, type: "project", title: "Raft store", body: "storage", tags: [] },
      { id: 2, confirmed: 1, type: "bio", title: "Painter", body: "art", tags: [] },
      { id: 3, confirmed: 1, type: "bio", title: "Chef", body: "food", tags: [] },
      { id: 4, confirmed: 1, type: "bio", title: "Pilot", body: "planes", tags: [] },
      { id: 5, confirmed: 1, type: "bio", title: "Diver", body: "ocean", tags: [] },
    ];
    const out = selectRelevantContext(items, "raft storage system", { max: 1 });
    expect(out[0].id).toBe(1);
    expect(out[0].confirmed).toBe(1);
  });
});
