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
  updateNote,
  upsertProfile,
} from "./memory.js";

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
    const id = addNote("Maya", "first note", "manual");
    expect(getNotesFor("Maya").map((n) => n.body)).toContain("first note");
    expect(updateNote(id, "edited")).toBe(true);
    expect(getNotesFor("Maya")[0].body).toBe("edited");
    expect(deleteNote(id)).toBe(true);
    expect(getNotesFor("Maya")).toHaveLength(0);
  });

  it("cascades note deletion when a contact is deleted", () => {
    addNote("Devin", "note a", "auto");
    addNote("Devin", "note b", "manual");
    expect(deleteContact("Devin")).toBe(true);
    expect(getNotesFor("Devin")).toHaveLength(0);
    expect(getContact("Devin")).toBeNull();
  });

  it("hides unconfirmed notes by default, shows them on request, and confirms them", () => {
    proposeNote("Priya", "pending fact");
    expect(getNotesFor("Priya")).toHaveLength(0);
    const all = getNotesFor("Priya", { includeUnconfirmed: true });
    expect(all).toHaveLength(1);
    expect(all[0].confirmed_by_user).toBe(0);
    confirmNote(all[0].id);
    expect(getNotesFor("Priya")).toHaveLength(1);
  });

  it("counts aggregates in getStats", () => {
    addNote("A", "n1", "manual");
    addNote("B", "n2", "auto");
    proposeNote("A", "pending");
    const stats = getStats(new Date().toISOString());
    expect(stats.contacts).toBe(2);
    expect(stats.notes).toBe(3);
    expect(stats.pending_notes).toBe(1);
  });

  it("round-trips an enriched profile (JSON fields)", () => {
    upsertProfile("Noah", {
      role: "Hardware Engineer",
      company: "Vega",
      headline: "FPGA",
      experience: [{ title: "Eng", company: "Vega", duration: "4y" }],
      skills: ["FPGA", "Verilog"],
      fetchedAt: new Date().toISOString(),
    });
    const c = getContact("Noah");
    expect(c?.role).toBe("Hardware Engineer");
    expect(c?.experience[0]).toMatchObject({ title: "Eng", company: "Vega" });
    expect(c?.skills).toEqual(["FPGA", "Verilog"]);
    expect(getAllContacts().find((x) => x.name === "Noah")?.note_count).toBe(0);
  });
});
