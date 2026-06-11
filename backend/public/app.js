// Comms Assistant — management console. Vanilla JS, same-origin fetch.
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
  return json;
}

let toastTimer = null;
function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? esc(iso) : d.toLocaleString();
}
function fmtDay(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? esc(iso) : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function relTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const diff = Date.now() - d.getTime();
  const day = 86400000;
  if (diff < 0) return `in ${Math.ceil(-diff / day)}d`;
  if (diff < day) return "today";
  return `${Math.floor(diff / day)}d ago`;
}

// Tiny, safe markdown → HTML (escape first, then a limited set of formatting).
function miniMarkdown(src) {
  const lines = esc(src).split(/\r?\n/);
  let html = "";
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const line of lines) {
    const t = line.trim();
    if (/^### /.test(t)) { closeList(); html += `<h4>${inline(t.slice(4))}</h4>`; }
    else if (/^## /.test(t)) { closeList(); html += `<h3>${inline(t.slice(3))}</h3>`; }
    else if (/^# /.test(t)) { closeList(); html += `<h2>${inline(t.slice(2))}</h2>`; }
    else if (/^[-*] /.test(t)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(t.slice(2))}</li>`; }
    else if (!t) { closeList(); }
    else { closeList(); html += `<p>${inline(t)}</p>`; }
  }
  closeList();
  return html;
  function inline(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }
}

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(label || "Copied"); }
  catch { toast("Copy failed — select and copy manually", "err"); }
}

// ---- Calendar export -------------------------------------------------------
// All client-side. We never auto-create events or touch your Google account —
// the "Google Calendar" link opens an event PRE-FILLED for you to save with one
// click, and the .ics download imports into any calendar (Google/Outlook/Apple).

// suggested_followup_at is a date (stored at UTC midnight). Use the date part
// directly so an all-day event lands on the right day regardless of timezone.
function calDates(iso) {
  const datePart = (iso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const start = datePart.replace(/-/g, "");
  const d = new Date(datePart + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1); // DTEND is exclusive for all-day events
  const end = d.toISOString().slice(0, 10).replace(/-/g, "");
  return { start, end };
}

function gcalUrl(ev) {
  const params = new URLSearchParams({ action: "TEMPLATE", text: ev.title });
  const dt = calDates(ev.iso);
  if (dt) params.set("dates", `${dt.start}/${dt.end}`);
  if (ev.details) params.set("details", ev.details);
  if (ev.location) params.set("location", ev.location);
  return "https://calendar.google.com/calendar/render?" + params.toString();
}

function icsEsc(s) {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsEvent(ev) {
  const dt = calDates(ev.iso);
  const uid = `comms-${(ev.title + (dt ? dt.start : "")).replace(/[^a-z0-9]/gi, "")}@local`;
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    dt ? `DTSTART;VALUE=DATE:${dt.start}` : "",
    dt ? `DTEND;VALUE=DATE:${dt.end}` : "",
    `SUMMARY:${icsEsc(ev.title)}`,
    ev.details ? `DESCRIPTION:${icsEsc(ev.details)}` : "",
    ev.location ? `LOCATION:${icsEsc(ev.location)}` : "",
    "END:VEVENT",
  ].filter(Boolean).join("\r\n");
}

function icsDocument(events) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Comms Assistant//Follow-ups//EN", ...events.map(icsEvent), "END:VCALENDAR"].join("\r\n");
}

function downloadIcs(filename, events) {
  const blob = new Blob([icsDocument(events)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- Router
const LOADERS = {
  overview: loadOverview,
  contacts: loadContacts,
  followups: loadFollowups,
  voice: loadVoice,
  activity: loadActivity,
  settings: loadConfig,
};
function show(view) {
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (LOADERS[view]) LOADERS[view]();
}
$$(".nav-item").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

// ---------------------------------------------------------------- Overview
let lastConfig = null;

async function loadOverview() {
  const cards = $("#statCards");
  cards.innerHTML = `<div class="muted">Loading…</div>`;
  let stats, cfg;
  try {
    [stats, cfg] = await Promise.all([api("/stats"), api("/config")]);
  } catch (err) {
    cards.innerHTML = `<div class="status err">Failed to load: ${esc(err.message)}</div>`;
    return;
  }
  lastConfig = cfg;

  const card = (label, value, sub, view) =>
    `<button class="card" ${view ? `data-goto="${view}"` : ""}>
      <div class="card-value">${value}</div>
      <div class="card-label">${esc(label)}</div>
      ${sub ? `<div class="card-sub">${esc(sub)}</div>` : ""}
    </button>`;

  cards.innerHTML = [
    card("Contacts", stats.contacts, "people remembered", "contacts"),
    card("Notes", stats.notes, stats.pending_notes ? `${stats.pending_notes} pending` : "all confirmed", "contacts"),
    card("Follow-ups due", stats.followups_due, `${stats.followups_total} total`, "followups"),
    card("Enriched profiles", stats.enriched_profiles, "from LinkedIn", "contacts"),
    card("Strategy reads", stats.strategies, "logged insights", "activity"),
    card("Feedback given", stats.feedback, "👍 / 👎", "voice"),
  ].join("");
  $$("#statCards .card[data-goto]").forEach((c) => c.addEventListener("click", () => show(c.dataset.goto)));

  // Onboarding checklist.
  const providerOk = cfg.provider === "gemini-cli" || !!cfg.openai.apiKeyMasked;
  const steps = [
    { state: "done", title: "Backend running", hint: "Serving this console on localhost:8000." },
    providerOk
      ? { state: "done", title: `LLM provider configured (${stats.provider})`, hint: "Change it any time in Settings.", view: "settings" }
      : { state: "todo", title: "Configure an LLM provider", hint: "openai-compat is selected but no API key is stored.", view: "settings" },
    stats.voice_profile_ok
      ? { state: "done", title: "Voice profile ready", hint: `${stats.voice_profile_chars} characters loaded.`, view: "voice" }
      : { state: "todo", title: "Add your voice profile", hint: "Run npm run init-voice, or edit voice_profile/strategy_analysis.md.", view: "voice" },
    { state: "info", title: "Load the Chrome extension", hint: "chrome://extensions → Developer mode → Load unpacked → extension/dist." },
    stats.contacts > 0
      ? { state: "done", title: "First conversation captured", hint: `${stats.contacts} contact${stats.contacts === 1 ? "" : "s"} so far.`, view: "contacts" }
      : { state: "todo", title: "Open a LinkedIn thread and click Suggest", hint: "Your first contact will appear here." },
  ];
  const ico = { done: "✓", todo: "○", info: "◐" };
  $("#checklist").innerHTML = steps
    .map((s) => `<li class="check ${s.state}" ${s.view ? `data-goto="${s.view}"` : ""}>
      <span class="check-ico">${ico[s.state]}</span>
      <div><div class="check-title">${esc(s.title)}</div><div class="check-hint">${esc(s.hint)}</div></div>
    </li>`)
    .join("");
  $$("#checklist .check[data-goto]").forEach((li) => li.addEventListener("click", () => show(li.dataset.goto)));
}
$("#refreshOverview").addEventListener("click", loadOverview);

// ---------------------------------------------------------------- Contacts
let contacts = [];
let selectedName = null;
let activeFilter = "all";

async function loadContacts() {
  try {
    const data = await api("/memory/contacts");
    contacts = data.contacts || [];
    $("#navContacts").textContent = contacts.length || "";
    renderList();
  } catch (err) {
    $("#contactList").innerHTML = `<li class="muted">Failed to load: ${esc(err.message)}</li>`;
  }
}

function isDue(iso) { return iso && new Date(iso).getTime() <= Date.now(); }

function filteredSorted() {
  const q = $("#search").value.trim().toLowerCase();
  let list = contacts.filter((c) =>
    !q ||
    (c.name || "").toLowerCase().includes(q) ||
    (c.company || "").toLowerCase().includes(q) ||
    (c.role || "").toLowerCase().includes(q),
  );
  if (activeFilter === "notes") list = list.filter((c) => c.note_count > 0);
  else if (activeFilter === "pending") list = list.filter((c) => c.unconfirmed_count > 0);
  else if (activeFilter === "enriched") list = list.filter((c) => c.profile_fetched_at);
  else if (activeFilter === "followup") list = list.filter((c) => isDue(c.suggested_followup_at));

  const sort = $("#sortSelect").value;
  if (sort === "name") list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else if (sort === "notes") list.sort((a, b) => b.note_count - a.note_count);
  // "recent" keeps server order (last_seen desc)
  return list;
}

function cleanName(name) {
  // Some early captures stored multi-line LinkedIn blobs as the name; show the first line.
  return (name || "").split("\n")[0].trim();
}

function renderList() {
  const list = filteredSorted();
  $("#listMeta").textContent = `${list.length} of ${contacts.length}`;
  $("#contactList").innerHTML = list
    .map((c) => {
      const sub = [c.role, c.company].filter(Boolean).join(" · ") || (c.headline ? cleanName(c.headline) : "");
      const badges = [
        c.unconfirmed_count > 0 ? `<span class="badge pending">${c.unconfirmed_count} pending</span>` : "",
        isDue(c.suggested_followup_at) ? `<span class="badge warn">🔔 due</span>` : "",
        c.profile_fetched_at ? `<span class="badge ok">enriched</span>` : "",
        c.note_count > 0 ? `<span class="badge">${c.note_count} note${c.note_count === 1 ? "" : "s"}</span>` : "",
      ].filter(Boolean).join(" ");
      return `<li data-name="${esc(c.name)}" class="${c.name === selectedName ? "selected" : ""}">
        <div class="ci-name">${esc(cleanName(c.name))}</div>
        <div class="ci-sub">${esc(sub)}</div>
        <div class="ci-badges">${badges}</div>
      </li>`;
    })
    .join("") || `<li class="muted">No contacts match.</li>`;
  $$("#contactList li[data-name]").forEach((li) =>
    li.addEventListener("click", () => showDetail(li.dataset.name)),
  );
}

$("#search").addEventListener("input", renderList);
$("#sortSelect").addEventListener("change", renderList);
$$("#filterRow .chip-btn").forEach((b) =>
  b.addEventListener("click", () => {
    activeFilter = b.dataset.filter;
    $$("#filterRow .chip-btn").forEach((x) => x.classList.toggle("active", x === b));
    renderList();
  }),
);

async function showDetail(name) {
  selectedName = name;
  renderList();
  $("#detailEmpty").hidden = true;
  const detail = $("#detail");
  detail.hidden = false;
  detail.innerHTML = `<div class="muted">Loading…</div>`;

  let data;
  try { data = await api(`/memory/contact/${encodeURIComponent(name)}`); }
  catch (err) { detail.innerHTML = `<div class="status err">Failed: ${esc(err.message)}</div>`; return; }
  const c = data.contact || { name };
  const notes = data.notes || [];

  const profileUrl = c.profile_url
    ? `<a href="${esc(c.profile_url)}" target="_blank" rel="noopener">LinkedIn ↗</a>` : "";

  const ALWAYS = new Set(["First seen", "Last seen"]);
  const kv = [
    ["Role", c.role], ["Company", c.company], ["Location", c.location],
    ["First seen", fmtDate(c.first_seen)], ["Last seen", fmtDate(c.last_seen)],
    ["Follow-up", c.suggested_followup_at ? fmtDate(c.suggested_followup_at) : ""],
    ["Profile fetched", c.profile_fetched_at ? fmtDate(c.profile_fetched_at) : ""],
  ].filter(([k, v]) => (v && v !== "—") || ALWAYS.has(k))
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v || "—")}</dd>`).join("");

  const experience = (c.experience || [])
    .map((e) => `<div class="exp-item"><strong>${esc(e.title)}</strong>${e.company ? " · " + esc(e.company) : ""}${e.duration ? `<div class="muted small">${esc(e.duration)}</div>` : ""}</div>`).join("");
  const education = (c.education || [])
    .map((e) => `<div class="exp-item"><strong>${esc(e.school)}</strong>${e.degree ? " · " + esc(e.degree) : ""}</div>`).join("");
  const skills = (c.skills || []).map((s) => `<span class="chip">${esc(s)}</span>`).join("");

  detail.innerHTML = `
    <div class="detail-head">
      <div><h2>${esc(cleanName(c.name))}</h2><div class="headline">${esc(c.headline ? cleanName(c.headline) : "")}</div></div>
      <div style="margin-left:auto">${profileUrl}</div>
    </div>
    <dl class="kv">${kv}</dl>
    ${c.about ? `<div class="section-title">About</div><div class="about">${esc(c.about)}</div>` : ""}
    ${experience ? `<div class="section-title">Experience</div>${experience}` : ""}
    ${education ? `<div class="section-title">Education</div>${education}` : ""}
    ${skills ? `<div class="section-title">Skills</div><div class="chips">${skills}</div>` : ""}
    <div class="section-title">Notes (${notes.length})</div>
    <div id="noteList">${notes.map(renderNote).join("") || '<div class="muted small">No notes yet.</div>'}</div>
    <div class="add-note">
      <input id="newNote" type="text" placeholder="Add a note…" />
      <button class="btn" id="addNoteBtn">Add</button>
    </div>
    <div class="detail-footer"><button class="btn danger" id="deleteContactBtn">Delete contact</button></div>
  `;
  $$("#noteList .note").forEach(wireNote);
  $("#addNoteBtn").addEventListener("click", () => addNote(name));
  $("#newNote").addEventListener("keydown", (e) => { if (e.key === "Enter") addNote(name); });
  $("#deleteContactBtn").addEventListener("click", () => deleteContact(name));
}

function renderNote(n) {
  const pending = n.confirmed_by_user === 0;
  const meta = [n.source, `by ${n.proposed_by}`, fmtDate(n.created_at), pending ? "⚠ pending" : ""].filter(Boolean).join(" · ");
  return `<div class="note ${pending ? "pending" : ""}" data-id="${n.id}">
    <div class="note-body"><div class="note-text">${esc(n.body)}</div><div class="note-meta">${esc(meta)}</div></div>
    <div class="note-actions">
      ${pending ? `<button class="icon-btn ok" data-act="confirm">✓ confirm</button>` : ""}
      <button class="icon-btn" data-act="edit">edit</button>
      <button class="icon-btn danger" data-act="delete">delete</button>
    </div></div>`;
}

function wireNote(el) {
  const id = Number(el.dataset.id);
  el.querySelector('[data-act="delete"]').addEventListener("click", async () => {
    if (!confirm("Delete this note?")) return;
    try { await api(`/memory/notes/${id}`, { method: "DELETE" }); toast("Note deleted"); showDetail(selectedName); loadContacts(); }
    catch (err) { toast(err.message, "err"); }
  });
  el.querySelector('[data-act="edit"]').addEventListener("click", async () => {
    const current = el.querySelector(".note-text").textContent;
    const body = prompt("Edit note:", current);
    if (body === null || body.trim() === current.trim()) return;
    try { await api(`/memory/notes/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) }); toast("Note updated"); showDetail(selectedName); }
    catch (err) { toast(err.message, "err"); }
  });
  const confirmBtn = el.querySelector('[data-act="confirm"]');
  if (confirmBtn) confirmBtn.addEventListener("click", async () => {
    try { await api(`/memory/notes/${id}/confirm`, { method: "POST" }); toast("Note confirmed"); showDetail(selectedName); loadContacts(); }
    catch (err) { toast(err.message, "err"); }
  });
}

async function addNote(name) {
  const input = $("#newNote");
  const note = input.value.trim();
  if (!note) return;
  try {
    await api("/memory/notes/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contact_name: name, note }) });
    input.value = ""; toast("Note added"); showDetail(name); loadContacts();
  } catch (err) { toast(err.message, "err"); }
}

async function deleteContact(name) {
  if (!confirm(`Delete "${cleanName(name)}" and all of their notes? This cannot be undone.`)) return;
  try {
    await api(`/memory/contact/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast("Contact deleted"); selectedName = null;
    $("#detail").hidden = true; $("#detailEmpty").hidden = false; loadContacts();
  } catch (err) { toast(err.message, "err"); }
}

// ---------------------------------------------------------------- Follow-ups
let followupEvents = {}; // keyed by contact name → {title, iso, details, location}

async function loadFollowups() {
  const el = $("#followupsContent");
  el.innerHTML = `<div class="muted">Loading…</div>`;
  let data, strat;
  try {
    [data, strat] = await Promise.all([api("/memory/contacts"), api("/memory/strategies?limit=300")]);
  } catch (err) { el.innerHTML = `<div class="status err">${esc(err.message)}</div>`; return; }

  // Most-recent strategy text per contact, for the calendar event description.
  const reasonFor = {};
  for (const s of strat.strategies || []) if (!reasonFor[s.contact_name]) reasonFor[s.contact_name] = s.text;

  const withFollowup = (data.contacts || []).filter((c) => c.suggested_followup_at)
    .sort((a, b) => new Date(a.suggested_followup_at) - new Date(b.suggested_followup_at));
  $("#navFollowups").textContent = withFollowup.filter((c) => isDue(c.suggested_followup_at)).length || "";

  if (!withFollowup.length) { el.innerHTML = `<div class="empty">No follow-ups scheduled. The assistant adds these when a conversation suggests checking back.</div>`; return; }

  // Build a calendar event per follow-up.
  followupEvents = {};
  for (const c of withFollowup) {
    const who = cleanName(c.name);
    const roleLine = [c.role, c.company].filter(Boolean).join(" · ");
    const details = [
      reasonFor[c.name] ? `Why: ${reasonFor[c.name]}` : "",
      roleLine ? `Who: ${who} — ${roleLine}` : "",
      c.profile_url ? `Profile: ${c.profile_url}` : "",
      "Added by Comms Assistant.",
    ].filter(Boolean).join("\n");
    followupEvents[c.name] = { title: `Follow up with ${who}`, iso: c.suggested_followup_at, details, location: "LinkedIn" };
  }

  const due = withFollowup.filter((c) => isDue(c.suggested_followup_at));
  const upcoming = withFollowup.filter((c) => !isDue(c.suggested_followup_at));

  const row = (c) => {
    const ev = followupEvents[c.name];
    const line = `Follow up with ${cleanName(c.name)} (due ${fmtDay(c.suggested_followup_at)})`;
    return `<div class="fu-row">
      <div class="fu-info">
        <div class="fu-name" data-name="${esc(c.name)}">${esc(cleanName(c.name))}</div>
        <div class="muted small">${esc([c.role, c.company].filter(Boolean).join(" · ") || "")}</div>
      </div>
      <div class="fu-when ${isDue(c.suggested_followup_at) ? "due" : ""}">${fmtDay(c.suggested_followup_at)} <span class="muted small">(${relTime(c.suggested_followup_at)})</span></div>
      <div class="fu-actions">
        <a class="btn ghost small" href="${esc(gcalUrl(ev))}" target="_blank" rel="noopener" title="Opens Google Calendar with the event pre-filled — review and save">📅 Google Calendar</a>
        <button class="btn ghost small" data-ics="${esc(c.name)}" title="Download .ics (Outlook / Apple / any calendar)">⬇ .ics</button>
        <button class="btn ghost small" data-copy="${esc(line)}" title="Copy a one-line summary">Copy</button>
      </div>
    </div>`;
  };

  const allBtn = withFollowup.length > 1
    ? `<button class="btn ghost small" id="icsAll">⬇ Download all (${withFollowup.length}) as .ics</button>` : "";
  el.innerHTML =
    `<div class="fu-note muted small">Calendar links open Google Calendar with the event pre-filled — nothing is created until you save it. ${allBtn}</div>` +
    (due.length ? `<div class="section-title">Due now (${due.length})</div>${due.map(row).join("")}` : "") +
    (upcoming.length ? `<div class="section-title">Upcoming (${upcoming.length})</div>${upcoming.map(row).join("")}` : "");

  $$("#followupsContent [data-copy]").forEach((b) => b.addEventListener("click", () => copy(b.dataset.copy, "Copied to clipboard")));
  $$("#followupsContent [data-ics]").forEach((b) => b.addEventListener("click", () => {
    const ev = followupEvents[b.dataset.ics];
    if (ev) { downloadIcs(`followup-${ev.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.ics`, [ev]); toast("Calendar file downloaded"); }
  }));
  $$("#followupsContent .fu-name[data-name]").forEach((n) => n.addEventListener("click", () => { show("contacts"); showDetail(n.dataset.name); }));
  const icsAll = $("#icsAll");
  if (icsAll) icsAll.addEventListener("click", () => { downloadIcs("comms-followups.ics", Object.values(followupEvents)); toast("All follow-ups downloaded"); });
}
$("#refreshFollowups").addEventListener("click", loadFollowups);

// ---------------------------------------------------------------- Voice
async function loadVoice() {
  const el = $("#voiceContent");
  el.innerHTML = `<div class="muted">Loading…</div>`;
  let v;
  try { v = await api("/voice"); } catch (err) { el.innerHTML = `<div class="status err">${esc(err.message)}</div>`; return; }

  const fb = v.feedback || [];
  const fbHtml = fb.length
    ? fb.map((f) => `<div class="fb-item ${f.rating}">
        <div class="fb-head">${f.rating === "up" ? "👍 liked" : "👎 off"} <span class="muted small">${esc(fmtDate(f.date))}${f.contact ? " · " + esc(f.contact) : ""}</span></div>
        ${f.note ? `<div class="fb-note">${esc(f.note)}</div>` : ""}
        ${f.suggestion ? `<div class="muted small fb-sug">“${esc(f.suggestion)}”</div>` : ""}
      </div>`).join("")
    : `<div class="muted small">No feedback yet. Use 👍/👎 in the overlay and it shows up here.</div>`;

  el.innerHTML = `
    <div class="panel">
      <div class="voice-stat">
        <span class="badge ${v.ok ? "ok" : "warn"}">${v.ok ? "ready" : "needs setup"}</span>
        <span class="muted small">${v.chars.toLocaleString()} characters${v.updated_at ? " · updated " + fmtDate(v.updated_at) : ""}</span>
      </div>
      <p class="muted small">This is the compiled voice the assistant writes in. To update it, edit
        <code>voice_profile/strategy_analysis.md</code> or run <code>npm run init-voice</code>
        (which also folds in your 👍/👎 feedback below).</p>
      <div class="voice-doc">${miniMarkdown(v.content)}</div>
    </div>
    <div class="panel">
      <h2>Feedback history (${fb.length})</h2>
      ${fbHtml}
    </div>`;
}
$("#refreshVoice").addEventListener("click", loadVoice);

// ---------------------------------------------------------------- Activity
async function loadActivity() {
  const sEl = $("#strategyContent");
  const snEl = $("#snapshotContent");
  sEl.innerHTML = `<div class="muted">Loading…</div>`;
  snEl.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    const [sd, snd] = await Promise.all([api("/memory/strategies?limit=50"), api("/snapshots")]);
    const strategies = sd.strategies || [];
    sEl.innerHTML = strategies.length
      ? strategies.map((s) => `<div class="timeline-row">
          <div class="timeline-meta"><span class="t-name" data-name="${esc(s.contact_name)}">${esc(cleanName(s.contact_name))}</span><span class="muted small">${esc(fmtDate(s.read_at))}</span></div>
          <div class="timeline-text">${esc(s.text)}</div>
          ${s.suggested_followup_at ? `<div class="muted small">🔔 follow-up ${esc(fmtDay(s.suggested_followup_at))}</div>` : ""}
        </div>`).join("")
      : `<div class="muted small">No strategy reads yet.</div>`;
    $$("#strategyContent .t-name[data-name]").forEach((n) => n.addEventListener("click", () => { show("contacts"); showDetail(n.dataset.name); }));

    const snaps = snd.snapshots || [];
    snEl.innerHTML = snaps.length
      ? `<table class="tbl"><thead><tr><th>Saved</th><th>Page</th><th>Msgs</th><th>Anomalies</th><th>Size</th></tr></thead><tbody>${
          snaps.map((s) => `<tr>
            <td>${esc(fmtDate(s.savedAt))}</td>
            <td title="${esc(s.url || "")}">${esc((s.pageTitle || "—").slice(0, 40))}</td>
            <td>${s.messagesFound ?? "—"}</td>
            <td>${s.anomalies && s.anomalies.length ? `<span class="badge warn">${s.anomalies.length}</span>` : "—"}</td>
            <td class="muted small">${(s.bytes / 1024).toFixed(1)} KB</td></tr>`).join("")
        }</tbody></table>`
      : `<div class="muted small">No snapshots captured.</div>`;
  } catch (err) {
    sEl.innerHTML = `<div class="status err">${esc(err.message)}</div>`;
    snEl.innerHTML = "";
  }
}
$("#refreshActivity").addEventListener("click", loadActivity);

// ---------------------------------------------------------------- Settings
let presets = [];

async function loadConfig() {
  let cfg;
  try { cfg = await api("/config"); } catch (err) { $("#settingsStatus").textContent = err.message; return; }
  lastConfig = cfg;
  presets = cfg.presets || [];
  const sel = $("#presetSelect");
  const current = presets.find((p) =>
    p.provider === cfg.provider &&
    (p.provider === "gemini-cli" || p.baseUrl.replace(/\/+$/, "") === (cfg.openai.baseUrl || "").replace(/\/+$/, "")),
  ) || presets.find((p) => p.provider === cfg.provider);
  sel.innerHTML = presets.map((p) => `<option value="${esc(p.id)}" ${current && p.id === current.id ? "selected" : ""}>${esc(p.label)}</option>`).join("");

  $("#baseUrl").value = cfg.openai.baseUrl || "";
  $("#model").value = cfg.openai.model || "";
  $("#apiKey").value = "";
  $("#temperature").value = cfg.openai.temperature ?? "";
  $("#timeoutMs").value = cfg.timeoutMs ?? "";
  $("#currentKey").textContent = cfg.openai.apiKeyMasked ? `Current key: ${cfg.openai.apiKeyMasked}` : "No key stored.";
  onPresetChange();

  $("#backendInfo").innerHTML = [
    ["Provider", cfg.provider],
    ["Model", cfg.provider === "gemini-cli" ? "(gemini CLI)" : cfg.openai.model],
    ["Base URL", cfg.provider === "gemini-cli" ? "—" : cfg.openai.baseUrl],
    ["Timeout", `${cfg.timeoutMs} ms`],
    ["Console", "http://127.0.0.1:8000/"],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
}

function onPresetChange() {
  const p = presets.find((x) => x.id === $("#presetSelect").value);
  if (!p) return;
  $("#presetNote").textContent = p.note || "";
  $("#httpFields").style.display = p.provider === "gemini-cli" ? "none" : "block";
  if (p.provider !== "gemini-cli") {
    if (p.baseUrl) $("#baseUrl").value = p.baseUrl;
    $("#modelList").innerHTML = (p.models || []).map((m) => `<option value="${esc(m)}">`).join("");
    if (p.models && p.models.length && !p.models.includes($("#model").value)) $("#model").value = p.models[0];
  }
}
$("#presetSelect").addEventListener("change", onPresetChange);

function settingsBody() {
  const id = $("#presetSelect").value;
  const body = { preset: id };
  const p = presets.find((x) => x.id === id);
  if (p && p.provider !== "gemini-cli") {
    body.baseUrl = $("#baseUrl").value.trim();
    body.model = $("#model").value.trim();
    const key = $("#apiKey").value.trim();
    if (key) body.apiKey = key;
    const temp = $("#temperature").value.trim();
    if (temp !== "") body.temperature = Number(temp);
  }
  const to = $("#timeoutMs").value.trim();
  if (to !== "") body.timeoutMs = Number(to);
  return body;
}

function setStatus(msg, kind) {
  const el = $("#settingsStatus");
  el.textContent = msg;
  el.className = `status ${kind || ""}`;
}

$("#applyBtn").addEventListener("click", async () => {
  setStatus("Applying…", "pending");
  try {
    const cfg = await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settingsBody()) });
    setStatus(`Applied — provider is now ${cfg.provider}, model ${cfg.openai.model}.`, "ok");
    toast("Settings applied");
    refreshStatus(); loadConfig();
  } catch (err) { setStatus(err.message, "err"); }
});

$("#testBtn").addEventListener("click", async () => {
  setStatus("Testing connection…", "pending");
  try {
    const r = await api("/config/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settingsBody()) });
    if (r.ok) setStatus(r.note ? r.note : `✓ Connection OK (${r.ms} ms).`, "ok");
    else setStatus(`✗ ${r.error}`, "err");
  } catch (err) { setStatus(err.message, "err"); }
});

// ---------------------------------------------------------------- Status
async function refreshStatus() {
  const dot = $("#statusDot");
  try {
    const h = await api("/health");
    $("#providerBadge").textContent = h.provider || "?";
    dot.className = "status-dot online";
    $("#statusText").textContent = "backend online";
  } catch {
    $("#providerBadge").textContent = "offline";
    dot.className = "status-dot offline";
    $("#statusText").textContent = "backend offline";
  }
}

// ---------------------------------------------------------------- Init
refreshStatus();
loadOverview();
loadContacts(); // populate nav count
