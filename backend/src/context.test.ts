import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb } from "./db.js";
import {
  addContextItem,
  confirmContextItem,
  deleteContextItem,
  getConfirmedContext,
  getContextItems,
  updateContextItem,
} from "./context.js";

// The default single-user tenant — what every server request resolves to when
// no X-Comms-Tenant header is present.
const T = "local";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comms-db-"));
  process.env.COMMS_DB_PATH = join(dir, "test.sqlite");
  resetDb();
});
afterEach(() => {
  // Close handles BEFORE rm, or Windows throws EBUSY on the .sqlite/-wal/-shm files.
  resetDb();
  delete process.env.COMMS_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("context CRUD", () => {
  it("adds, reads, updates and deletes an item", () => {
    const id = addContextItem(T, {
      type: "project",
      title: "Realtime sync engine",
      body: "Built a CRDT-backed sync layer",
      tags: ["distributed", "crdt"],
    });
    const items = getContextItems(T);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "project",
      title: "Realtime sync engine",
      tags: ["distributed", "crdt"],
      confirmed: 1,
    });

    expect(updateContextItem(T, id, { body: "Rewrote it in Rust", tags: ["rust"] })).toBe(true);
    const after = getContextItems(T)[0];
    expect(after.body).toBe("Rewrote it in Rust");
    expect(after.tags).toEqual(["rust"]);

    expect(deleteContextItem(T, id)).toBe(true);
    expect(getContextItems(T)).toHaveLength(0);
  });

  it("filters by type", () => {
    addContextItem(T, { type: "project", title: "P", body: "b" });
    addContextItem(T, { type: "achievement", title: "A", body: "b" });
    expect(getContextItems(T, { type: "project" }).map((i) => i.title)).toEqual(["P"]);
    expect(getContextItems(T, { type: "achievement" }).map((i) => i.title)).toEqual(["A"]);
  });

  it("excludes proposed items from confirmed context until confirmed", () => {
    const id = addContextItem(T, {
      type: "bio",
      title: "Bio",
      body: "Inferred from LinkedIn",
      confirmed: 0,
    });
    // Hidden from confirmed reads…
    expect(getConfirmedContext(T)).toHaveLength(0);
    expect(getContextItems(T)).toHaveLength(0);
    // …but visible when explicitly requested.
    const all = getContextItems(T, { includeUnconfirmed: true });
    expect(all).toHaveLength(1);
    expect(all[0].confirmed).toBe(0);

    expect(confirmContextItem(T, id)).toBe(true);
    expect(getConfirmedContext(T).map((i) => i.title)).toEqual(["Bio"]);
    // Re-confirming an already-confirmed item is a no-op.
    expect(confirmContextItem(T, id)).toBe(false);
  });

  it("rejects an invalid type and empty title/body", () => {
    expect(() =>
      // @ts-expect-error — deliberately invalid type
      addContextItem(T, { type: "hobby", title: "x", body: "y" }),
    ).toThrow();
    expect(() => addContextItem(T, { type: "bio", title: "  ", body: "y" })).toThrow();
    expect(() => addContextItem(T, { type: "bio", title: "x", body: "  " })).toThrow();

    const id = addContextItem(T, { type: "bio", title: "x", body: "y" });
    expect(() => updateContextItem(T, id, { title: "  " })).toThrow();
    expect(() => updateContextItem(T, id, { body: "  " })).toThrow();
  });
});

// One tenant must never read or mutate another's context items.
describe("context tenant isolation", () => {
  const t1 = "tenant-one";
  const t2 = "tenant-two";

  it("each tenant only sees its own items", () => {
    addContextItem(t1, { type: "project", title: "t1 project", body: "b" });
    addContextItem(t2, { type: "project", title: "t2 project", body: "b" });

    expect(getContextItems(t1).map((i) => i.title)).toEqual(["t1 project"]);
    expect(getContextItems(t2).map((i) => i.title)).toEqual(["t2 project"]);
    expect(getConfirmedContext(t1).map((i) => i.title)).toEqual(["t1 project"]);
  });

  it("a foreign tenant cannot mutate another tenant's item (id is not enough)", () => {
    const id = addContextItem(t1, { type: "project", title: "t1 project", body: "b" });
    expect(deleteContextItem(t2, id)).toBe(false);
    expect(updateContextItem(t2, id, { title: "hijacked" })).toBe(false);
    expect(confirmContextItem(t2, id)).toBe(false);
    // The original row is untouched and the owner can still mutate it.
    expect(getContextItems(t1)[0].title).toBe("t1 project");
    expect(updateContextItem(t1, id, { title: "edited" })).toBe(true);
    expect(deleteContextItem(t1, id)).toBe(true);
  });
});
