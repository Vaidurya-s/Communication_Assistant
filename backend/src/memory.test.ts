import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb } from "./db.js";
import {
  addNote,
  confirmNote,
  deleteContact,
  deleteNote,
  getAllContacts,
  getContact,
  getNotesFor,
  getStats,
  proposeNote,
  recordStrategy,
  getRecentStrategies,
  updateNote,
  upsertProfile,
} from "./memory.js";

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

describe("memory CRUD", () => {
  it("adds, reads, updates and deletes a note", () => {
    const id = addNote(T, "Maya", "first note", "manual");
    expect(getNotesFor(T, "Maya").map((n) => n.body)).toContain("first note");
    expect(updateNote(T, id, "edited")).toBe(true);
    expect(getNotesFor(T, "Maya")[0].body).toBe("edited");
    expect(deleteNote(T, id)).toBe(true);
    expect(getNotesFor(T, "Maya")).toHaveLength(0);
  });

  it("cascades note deletion when a contact is deleted", () => {
    addNote(T, "Devin", "note a", "auto");
    addNote(T, "Devin", "note b", "manual");
    expect(deleteContact(T, "Devin")).toBe(true);
    expect(getNotesFor(T, "Devin")).toHaveLength(0);
    expect(getContact(T, "Devin")).toBeNull();
  });

  it("hides unconfirmed notes by default, shows them on request, and confirms them", () => {
    proposeNote(T, "Priya", "pending fact");
    expect(getNotesFor(T, "Priya")).toHaveLength(0);
    const all = getNotesFor(T, "Priya", { includeUnconfirmed: true });
    expect(all).toHaveLength(1);
    expect(all[0].confirmed_by_user).toBe(0);
    confirmNote(T, all[0].id);
    expect(getNotesFor(T, "Priya")).toHaveLength(1);
  });

  it("counts aggregates in getStats", () => {
    addNote(T, "A", "n1", "manual");
    addNote(T, "B", "n2", "auto");
    proposeNote(T, "A", "pending");
    const stats = getStats(T, new Date().toISOString());
    expect(stats.contacts).toBe(2);
    expect(stats.notes).toBe(3);
    expect(stats.pending_notes).toBe(1);
  });

  it("round-trips an enriched profile (JSON fields)", () => {
    upsertProfile(T, "Noah", {
      role: "Hardware Engineer",
      company: "Vega",
      headline: "FPGA",
      experience: [{ title: "Eng", company: "Vega", duration: "4y" }],
      skills: ["FPGA", "Verilog"],
      fetchedAt: new Date().toISOString(),
    });
    const c = getContact(T, "Noah");
    expect(c?.role).toBe("Hardware Engineer");
    expect(c?.experience[0]).toMatchObject({ title: "Eng", company: "Vega" });
    expect(c?.skills).toEqual(["FPGA", "Verilog"]);
    expect(getAllContacts(T).find((x) => x.name === "Noah")?.note_count).toBe(0);
  });
});

// The correctness-critical core of H1: one tenant must never read or mutate
// another's rows. Distinct names per tenant (same-name isolation is covered
// once H1b adds the composite primary key).
describe("tenant isolation", () => {
  const t1 = "tenant-one";
  const t2 = "tenant-two";

  it("getAllContacts / getContact only see the caller's tenant", () => {
    addNote(t1, "Alice", "a1", "manual");
    addNote(t2, "Bob", "b1", "manual");

    const t1Names = getAllContacts(t1).map((c) => c.name);
    const t2Names = getAllContacts(t2).map((c) => c.name);
    expect(t1Names).toEqual(["Alice"]);
    expect(t2Names).toEqual(["Bob"]);

    expect(getContact(t1, "Bob")).toBeNull();
    expect(getContact(t2, "Alice")).toBeNull();
  });

  it("getNotesFor is scoped — a foreign tenant sees no notes", () => {
    addNote(t1, "Alice", "secret", "manual");
    expect(getNotesFor(t1, "Alice").map((n) => n.body)).toEqual(["secret"]);
    expect(getNotesFor(t2, "Alice")).toHaveLength(0);
  });

  it("getStats counts per-tenant", () => {
    addNote(t1, "Alice", "a1", "manual");
    addNote(t1, "Alice", "a2", "auto");
    addNote(t2, "Bob", "b1", "manual");
    recordStrategy(t1, "Alice", "t1 strategy", null);

    const s1 = getStats(t1, new Date().toISOString());
    const s2 = getStats(t2, new Date().toISOString());
    expect(s1.contacts).toBe(1);
    expect(s1.notes).toBe(2);
    expect(s1.strategies).toBe(1);
    expect(s2.contacts).toBe(1);
    expect(s2.notes).toBe(1);
    expect(s2.strategies).toBe(0);
  });

  it("getRecentStrategies is scoped to the tenant", () => {
    recordStrategy(t1, "Alice", "t1 strategy", null);
    recordStrategy(t2, "Bob", "t2 strategy", null);
    expect(getRecentStrategies(t1).map((s) => s.text)).toEqual(["t1 strategy"]);
    expect(getRecentStrategies(t2).map((s) => s.text)).toEqual(["t2 strategy"]);
  });

  it("a foreign tenant cannot mutate another tenant's note (id is not enough)", () => {
    const id = addNote(t1, "Alice", "a1", "manual");
    // Cross-tenant attempts no-op…
    expect(deleteNote(t2, id)).toBe(false);
    expect(updateNote(t2, id, "hijacked")).toBe(false);
    confirmNote(t2, id); // silently no-ops
    // …and the original row is untouched.
    expect(getNotesFor(t1, "Alice")[0].body).toBe("a1");
    // The owner can still mutate it.
    expect(updateNote(t1, id, "edited")).toBe(true);
    expect(deleteNote(t1, id)).toBe(true);
  });

  it("deleteContact only removes the caller's contact", () => {
    addNote(t1, "Alice", "a1", "manual");
    addNote(t2, "Bob", "b1", "manual");
    expect(deleteContact(t2, "Alice")).toBe(false); // not t2's contact
    expect(getContact(t1, "Alice")).not.toBeNull();
    expect(deleteContact(t1, "Alice")).toBe(true);
  });

  // H1b: two tenants may now hold a contact with the SAME name as independent
  // rows. (Before the composite PK this collided on the single-column name PK.)
  it("keeps same-named contacts independent across tenants", () => {
    addNote(t1, "Sam", "t1 sam note", "manual");
    addNote(t2, "Sam", "t2 sam note", "manual");

    expect(getNotesFor(t1, "Sam").map((n) => n.body)).toEqual(["t1 sam note"]);
    expect(getNotesFor(t2, "Sam").map((n) => n.body)).toEqual(["t2 sam note"]);

    // Deleting one tenant's Sam (cascading its note) leaves the other intact.
    expect(deleteContact(t1, "Sam")).toBe(true);
    expect(getContact(t1, "Sam")).toBeNull();
    expect(getContact(t2, "Sam")).not.toBeNull();
    expect(getNotesFor(t2, "Sam").map((n) => n.body)).toEqual(["t2 sam note"]);
  });
});
