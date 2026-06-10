// Comms Assistant management console — vanilla JS, same-origin fetch.
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

// ---- Tabs ----
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    $(`#view-${tab.dataset.view}`).classList.add("active");
    if (tab.dataset.view === "settings") loadConfig();
  });
});

// ---- Contacts ----
let contacts = [];
let selectedName = null;

async function loadContacts() {
  try {
    const data = await api("/memory/contacts");
    contacts = data.contacts || [];
    renderList();
  } catch (err) {
    $("#contactList").innerHTML = `<li class="muted">Failed to load: ${esc(err.message)}</li>`;
  }
}

function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const filtered = contacts.filter((c) =>
    !q ||
    (c.name || "").toLowerCase().includes(q) ||
    (c.company || "").toLowerCase().includes(q) ||
    (c.role || "").toLowerCase().includes(q),
  );
  $("#listMeta").textContent = `${filtered.length} of ${contacts.length} contact${contacts.length === 1 ? "" : "s"}`;
  $("#contactList").innerHTML = filtered
    .map((c) => {
      const sub = [c.role, c.company].filter(Boolean).join(" · ") || c.headline || "";
      const pending = c.unconfirmed_count > 0
        ? `<span class="badge pending">${c.unconfirmed_count} pending</span>`
        : "";
      const notes = c.note_count > 0 ? `<span class="badge">${c.note_count} note${c.note_count === 1 ? "" : "s"}</span>` : "";
      return `<li data-name="${esc(c.name)}" class="${c.name === selectedName ? "selected" : ""}">
        <div class="ci-name">${esc(c.name)} ${pending}</div>
        <div class="ci-sub">${esc(sub)}</div>
        <div style="margin-top:4px">${notes}</div>
      </li>`;
    })
    .join("");
  $$("#contactList li[data-name]").forEach((li) =>
    li.addEventListener("click", () => showDetail(li.dataset.name)),
  );
}

$("#search").addEventListener("input", renderList);

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? esc(iso) : d.toLocaleString();
}

async function showDetail(name) {
  selectedName = name;
  renderList();
  $("#detailEmpty").hidden = true;
  const detail = $("#detail");
  detail.hidden = false;
  detail.innerHTML = `<div class="muted">Loading…</div>`;

  let data;
  try {
    data = await api(`/memory/contact/${encodeURIComponent(name)}`);
  } catch (err) {
    detail.innerHTML = `<div class="status err">Failed: ${esc(err.message)}</div>`;
    return;
  }
  const c = data.contact || { name };
  const notes = data.notes || [];

  const profileUrl = c.profile_url
    ? `<a href="${esc(c.profile_url)}" target="_blank" rel="noopener">LinkedIn ↗</a>`
    : "";

  const ALWAYS = new Set(["First seen", "Last seen"]);
  const kv = [
    ["Role", c.role],
    ["Company", c.company],
    ["Location", c.location],
    ["First seen", fmtDate(c.first_seen)],
    ["Last seen", fmtDate(c.last_seen)],
    ["Follow-up", c.suggested_followup_at ? fmtDate(c.suggested_followup_at) : ""],
    ["Profile fetched", c.profile_fetched_at ? fmtDate(c.profile_fetched_at) : ""],
  ]
    .filter(([k, v]) => (v && v !== "—") || ALWAYS.has(k))
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v || "—")}</dd>`)
    .join("");

  const experience = (c.experience || [])
    .map((e) => `<div class="exp-item"><strong>${esc(e.title)}</strong>${e.company ? " · " + esc(e.company) : ""}${e.duration ? `<div class="muted small">${esc(e.duration)}</div>` : ""}</div>`)
    .join("");
  const education = (c.education || [])
    .map((e) => `<div class="exp-item"><strong>${esc(e.school)}</strong>${e.degree ? " · " + esc(e.degree) : ""}</div>`)
    .join("");
  const skills = (c.skills || []).map((s) => `<span class="chip">${esc(s)}</span>`).join("");

  detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${esc(c.name)}</h2>
        <div class="headline">${esc(c.headline || "")}</div>
      </div>
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

    <div class="detail-footer">
      <button class="btn danger" id="deleteContactBtn">Delete contact</button>
    </div>
  `;

  $$("#noteList .note").forEach(wireNote);
  $("#addNoteBtn").addEventListener("click", () => addNote(name));
  $("#newNote").addEventListener("keydown", (e) => { if (e.key === "Enter") addNote(name); });
  $("#deleteContactBtn").addEventListener("click", () => deleteContact(name));
}

function renderNote(n) {
  const pending = n.confirmed_by_user === 0;
  const meta = [
    n.source,
    `by ${n.proposed_by}`,
    fmtDate(n.created_at),
    pending ? "⚠ pending confirmation" : "",
  ].filter(Boolean).join(" · ");
  return `<div class="note ${pending ? "pending" : ""}" data-id="${n.id}">
    <div class="note-body">
      <div class="note-text">${esc(n.body)}</div>
      <div class="note-meta">${esc(meta)}</div>
    </div>
    <div class="note-actions">
      ${pending ? `<button class="icon-btn ok" data-act="confirm">✓ confirm</button>` : ""}
      <button class="icon-btn" data-act="edit">edit</button>
      <button class="icon-btn danger" data-act="delete">delete</button>
    </div>
  </div>`;
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
    input.value = "";
    toast("Note added");
    showDetail(name);
    loadContacts();
  } catch (err) { toast(err.message, "err"); }
}

async function deleteContact(name) {
  if (!confirm(`Delete "${name}" and all of their notes? This cannot be undone.`)) return;
  try {
    await api(`/memory/contact/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast("Contact deleted");
    selectedName = null;
    $("#detail").hidden = true;
    $("#detailEmpty").hidden = false;
    loadContacts();
  } catch (err) { toast(err.message, "err"); }
}

// ---- Settings ----
let presets = [];

async function loadConfig() {
  let cfg;
  try { cfg = await api("/config"); } catch (err) { $("#settingsStatus").textContent = err.message; return; }
  presets = cfg.presets || [];
  const sel = $("#presetSelect");

  // Choose which preset matches the current config: provider + baseUrl.
  const current = presets.find((p) =>
    p.provider === cfg.provider &&
    (p.provider === "gemini-cli" || p.baseUrl.replace(/\/+$/, "") === (cfg.openai.baseUrl || "").replace(/\/+$/, "")),
  ) || presets.find((p) => p.provider === cfg.provider);

  sel.innerHTML = presets.map((p) => `<option value="${esc(p.id)}" ${current && p.id === current.id ? "selected" : ""}>${esc(p.label)}</option>`).join("");

  $("#baseUrl").value = cfg.openai.baseUrl || "";
  $("#model").value = cfg.openai.model || "";
  $("#apiKey").value = "";
  $("#currentKey").textContent = cfg.openai.apiKeyMasked
    ? `Current key: ${cfg.openai.apiKeyMasked}`
    : "No key stored.";
  onPresetChange();
}

function onPresetChange() {
  const p = presets.find((x) => x.id === $("#presetSelect").value);
  if (!p) return;
  $("#presetNote").textContent = p.note || "";
  $("#httpFields").style.display = p.provider === "gemini-cli" ? "none" : "block";
  if (p.provider !== "gemini-cli") {
    // Prefill base URL + suggested models when the user switches preset.
    if (p.baseUrl) $("#baseUrl").value = p.baseUrl;
    $("#modelList").innerHTML = (p.models || []).map((m) => `<option value="${esc(m)}">`).join("");
    if (p.models && p.models.length && !p.models.includes($("#model").value)) {
      $("#model").value = p.models[0];
    }
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
  }
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
    refreshProviderBadge();
    loadConfig();
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

// ---- Provider badge ----
async function refreshProviderBadge() {
  try {
    const h = await api("/health");
    $("#providerBadge").textContent = h.provider || "?";
  } catch { $("#providerBadge").textContent = "offline"; }
}

// ---- Init ----
loadContacts();
refreshProviderBadge();
