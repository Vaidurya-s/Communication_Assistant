#!/usr/bin/env node
/**
 * Seed a SQLite DB with fictional demo data for screenshots / trying the
 * dashboard without real contacts. Writes to argv[2] (default data/demo.sqlite
 * so it never clobbers real memory.sqlite by accident).
 *
 *   node scripts/seed-demo.mjs data/memory.sqlite
 *
 * Run from the backend/ directory (so better-sqlite3 resolves).
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const target = resolve(process.cwd(), process.argv[2] || "data/demo.sqlite");
mkdirSync(dirname(target), { recursive: true });
const db = new Database(target);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    name TEXT PRIMARY KEY, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    last_thread_url TEXT, suggested_followup_at TEXT, profile_url TEXT, headline TEXT,
    role TEXT, company TEXT, location TEXT, about TEXT,
    experience_json TEXT, education_json TEXT, skills_json TEXT, profile_fetched_at TEXT
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_name TEXT NOT NULL REFERENCES contacts(name) ON DELETE CASCADE,
    body TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('auto','manual')),
    proposed_by TEXT NOT NULL DEFAULT 'llm' CHECK (proposed_by IN ('llm','user','system')),
    confirmed_by_user INTEGER NOT NULL DEFAULT 1 CHECK (confirmed_by_user IN (0,1)),
    confirmed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_name);
  CREATE INDEX IF NOT EXISTS idx_notes_confirmed ON notes(confirmed_by_user);
  CREATE TABLE IF NOT EXISTS strategy_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, contact_name TEXT NOT NULL,
    read_at TEXT NOT NULL DEFAULT (datetime('now')), text TEXT NOT NULL, suggested_followup_at TEXT
  );
`);

// Clean slate.
db.exec(`DELETE FROM notes; DELETE FROM strategy_log; DELETE FROM contacts;`);

const now = new Date();
const iso = (d) => d.toISOString();
const dayAdd = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
const dateOnly = (n) => { const d = dayAdd(n); d.setUTCHours(0, 0, 0, 0); return iso(d); };
const sqlTime = (n) => iso(dayAdd(n)).slice(0, 19).replace("T", " ");

const contacts = [
  { name: "Maya Chen", seen: -1, role: "Product Designer", company: "Northwind Labs", loc: "Berlin, DE",
    headline: "Product Designer at Northwind Labs · ex-Figma", url: "https://www.linkedin.com/in/maya-chen-demo",
    about: "Designing calm, legible tools for technical teams. Previously on the design systems crew at Figma.",
    exp: [{ title: "Product Designer", company: "Northwind Labs", duration: "2y" }, { title: "Designer", company: "Figma", duration: "3y" }],
    edu: [{ school: "RISD", degree: "BFA, Graphic Design" }], skills: ["Design systems", "Prototyping", "UX research"],
    enriched: true },
  { name: "Devin Okoro", seen: -2, role: "Founder & CEO", company: "Cobalt Robotics", loc: "Lagos, NG",
    headline: "Building autonomous warehouse robots", followup: -2 },
  { name: "Priya Nair", seen: -1, role: "ML Engineer", company: "Helix AI", loc: "Bengaluru, IN",
    headline: "ML Engineer at Helix AI · LLM inference", url: "https://www.linkedin.com/in/priya-nair-demo",
    about: "Working on low-latency inference for production LLMs. Open-source contributor.",
    exp: [{ title: "ML Engineer", company: "Helix AI", duration: "1y" }], edu: [{ school: "IIT Madras", degree: "B.Tech, CS" }],
    skills: ["PyTorch", "CUDA", "Distributed systems"], enriched: true },
  { name: "Tomás Ruiz", seen: -3, role: "Technical Recruiter", company: "Brightpath", loc: "Madrid, ES",
    headline: "Connecting hardware engineers with great teams", followup: 6 },
  { name: "Aisha Bello", seen: -2, role: "PhD Candidate", company: "ETH Zürich", loc: "Zürich, CH",
    headline: "PhD in neuromorphic computing", pending: true },
  { name: "Liam Walsh", seen: 0, role: "VLSI Engineer", company: "Silicon Foundry", loc: "Dublin, IE",
    headline: "Digital design · timing closure · low power", followup: 0 },
  { name: "Sara Kim", seen: -4, role: "Growth Lead", company: "Lumen", loc: "Seoul, KR",
    headline: "Growth & lifecycle marketing" },
  { name: "Noah Bauer", seen: -6, role: "Hardware Engineer", company: "Vega Systems", loc: "Munich, DE",
    headline: "FPGA & signal integrity", url: "https://www.linkedin.com/in/noah-bauer-demo",
    about: "FPGA prototyping and high-speed board design.", exp: [{ title: "Hardware Engineer", company: "Vega Systems", duration: "4y" }],
    edu: [{ school: "TU München", degree: "MSc, EE" }], skills: ["FPGA", "Verilog", "PCB design"], enriched: true },
];

const insC = db.prepare(`INSERT INTO contacts
  (name, first_seen, last_seen, last_thread_url, suggested_followup_at, profile_url, headline, role, company, location, about, experience_json, education_json, skills_json, profile_fetched_at)
  VALUES (@name,@first_seen,@last_seen,@thread,@followup,@url,@headline,@role,@company,@loc,@about,@exp,@edu,@skills,@fetched)`);

for (const c of contacts) {
  insC.run({
    name: c.name, first_seen: iso(dayAdd(c.seen - 7)), last_seen: iso(dayAdd(c.seen)),
    thread: "https://www.linkedin.com/messaging/thread/demo", followup: c.followup !== undefined ? dateOnly(c.followup) : null,
    url: c.url ?? null, headline: c.headline ?? null, role: c.role ?? null, company: c.company ?? null, loc: c.loc ?? null,
    about: c.about ?? null, exp: c.exp ? JSON.stringify(c.exp) : null, edu: c.edu ? JSON.stringify(c.edu) : null,
    skills: c.skills ? JSON.stringify(c.skills) : null, fetched: c.enriched ? iso(dayAdd(c.seen)) : null,
  });
}

const insN = db.prepare(`INSERT INTO notes (contact_name, body, source, proposed_by, confirmed_by_user, confirmed_at, created_at)
  VALUES (?,?,?,?,?,?,?)`);
// [contact, body, source, proposed_by, confirmed, confirmed_at, created_at]
const notes = [
  ["Maya Chen", "Leads the design-systems guild; prefers async, detailed written updates.", "auto", "llm", 1, sqlTime(-1), sqlTime(-1)],
  ["Devin Okoro", "Raising a seed round; warm to intros but wants a working demo first.", "auto", "llm", 1, sqlTime(-2), sqlTime(-2)],
  ["Priya Nair", "Maintains a popular inference library; happy to review a PR if it's small.", "manual", "user", 1, sqlTime(-1), sqlTime(-1)],
  ["Tomás Ruiz", "Hiring for two analog roles in Q3; said to ping again after the tape-out.", "auto", "llm", 1, sqlTime(-3), sqlTime(-3)],
  ["Aisha Bello", "Mentioned a workshop in October — worth attending if travel allows.", "auto", "llm", 0, null, sqlTime(-2)],
  ["Sara Kim", "Met at the Lumen growth meetup; interested in a referral swap.", "manual", "user", 1, sqlTime(-4), sqlTime(-4)],
  ["Noah Bauer", "Deep on signal integrity; offered to look over the high-speed layout.", "auto", "llm", 1, sqlTime(-6), sqlTime(-6)],
];
for (const n of notes) insN.run(n[0], n[1], n[2], n[3], n[4], n[5], n[6]);

const insS = db.prepare(`INSERT INTO strategy_log (contact_name, read_at, text, suggested_followup_at) VALUES (?,?,?,?)`);
const strat = [
  ["Liam Walsh", sqlTime(0), "Actively comparing timing tools; share the benchmark you ran and offer to pair on a tricky path.", dateOnly(0)],
  ["Devin Okoro", sqlTime(-2), "Receptive but gated on proof — send the short demo video before asking for the intro.", dateOnly(-2)],
  ["Maya Chen", sqlTime(-1), "Collaborative and detail-oriented; a concise written proposal will land better than a call.", null],
  ["Priya Nair", sqlTime(-1), "Technical and generous with time; lead with the specific question, not the broad ask.", null],
  ["Tomás Ruiz", sqlTime(-3), "Pipeline-building, not urgent; a light check-in after the tape-out keeps it warm.", dateOnly(6)],
  ["Sara Kim", sqlTime(-4), "Mutually beneficial; propose a concrete referral swap with two names each.", null],
  ["Aisha Bello", sqlTime(-2), "Early-stage rapport; the workshop is a natural, low-pressure next touchpoint.", null],
  ["Noah Bauer", sqlTime(-6), "Offered help unprompted — accept it and send the layout; reciprocate later.", null],
];
for (const s of strat) insS.run(s[0], s[1], s[2], s[3]);

console.log(`Seeded demo data → ${target}`);
console.log(`  ${contacts.length} contacts, ${notes.length} notes, ${strat.length} strategy reads`);
db.close();
