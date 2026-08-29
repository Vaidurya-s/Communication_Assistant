# Session log — Comms Assistant

A running handoff doc. Read this first when you come back; it tells you where things are and how to resume. Pairs with `CLAUDE.md` (architecture reference) — this file is the *current state*, that one is the *durable map*.

---

## Extraction render-race + snapshot triage (2026-06-30)

**Branch:** `fix/extraction-render-race` (ahead of `master` by these commits:
`4d16835` Gmail all-quoted recovery, `dcb3536` wait-for-render, `966ee22` per-tab
isolation, `e316e37` explainability, `8ce1937` voice versioning, …).

Triaged the saved debug snapshots in `backend/data/snapshots/`:
- **Gmail Jun 23 (×2)** — `gmail-zero-messages` on an all-quoted thread. Replayed
  the real captured DOM through current `extractGmailContext`: 1 message, no
  anomaly, quoted chain retained. **Already fixed** by `4d16835`.
- **LinkedIn Jun 29** — captured DOM was the **My Network feed**, not the thread;
  extraction fired against the stale pre-navigation page (URL was a thread, but
  the SPA hadn't swapped `main` yet). `backfillMs` 4077 = it hit the old 4s wait
  ceiling and gave up. **Not a selector rename** — verified live in-browser that
  every LinkedIn selector chain still matches on a rendered thread
  (`.msg-s-message-list-container`, `…__event`, `…__body`, `…group__name`,
  `.msg-form__contenteditable`, `.msg-entity-lockup__entity-title` all hit).

**Fix (committed):**
- `content/linkedin.ts` `waitForMessageList`: 4s → **10s** budget (cold messaging
  bundle when arriving from another surface), and now waits for a message **event
  to hydrate** (or a 1.5s content-settle for empty threads) — not just the
  container shell.
- `content/index.ts` `tryInstallObserver`: a thread that paints *after* the
  observer installs fires no mutations, so it now **kicks one extraction on a late
  install** so `lastContext`/prefetch reflect the rendered thread.
- New regression test `content/linkedin.test.ts` reproduces "wrong page mounted →
  thread paints 250ms later". `tsc` clean, 24/24 extension tests pass, build clean.

**To verify live:** reload the extension card at `chrome://extensions` (dist was
rebuilt), then open a thread via "Message" from My Network — the path that raced.

### Follow-up: the latest snapshot (Jul 8) — wrong-surface, not slow-render

The Jul 8 snapshot (`snapshot-2026-07-08T16-50-18-…`) came in AFTER the 10s fix
(`backfillMs` was 10010 = it waited the full new budget) and STILL failed: 0
messages, captured DOM was **My Network again** (`main#workspace`, thread URL
present only as 10 message-preview hrefs). So it's not "thread paints slowly" —
**the messaging app never mounted in that document at all**. Verified live:
direct navigation to that exact thread URL renders fine (container/events/draft
all present, `main#main`). Decisive discriminator, confirmed live on both
surfaces: messaging carries **~395 `[class*='msg-']`** elements; feed / My
Network carries **0**.

**Fix (this branch):**
- `linkedin.ts` `waitForMessageList`: **fast-bail** after a 3s grace when no
  `msg-*` scaffold exists at all (wrong surface) — no more 10s hang on a page
  that will never yield a thread. Genuine slow *messaging* loads still get the
  full 10s (their scaffold shows within the grace).
- `extractLinkedInContext`: when the messaging surface isn't mounted on a thread
  route, **early-return one honest anomaly** `messaging-thread-not-mounted`
  instead of parsing the foreign page + emitting misleading "layout changed"
  anomalies (and the 120k My-Network debug dump).
- `diagnostics.ts`: new `messaging-thread-not-mounted` anomaly, deliberately NOT
  a layout anomaly → overlay shows "⚠ Heads up: this conversation isn't loaded in
  this tab — reload / open it from Messaging", not "couldn't read this page".
- Regression test drives the real wrong-surface DOM: fast-bail + honest anomaly +
  `hasLayoutAnomaly === false`. 25/25 extension tests pass, build clean.

---

## In progress — voice + performance build (2026-06-17, agent-team)

Executing `docs/voice-onboarding-plan.md` + `docs/performance-plan.md` in waves with parallel subagents (disjoint file ownership).

**Wave 1 — DONE, verified end-to-end (backend tsc + 95 tests green; live-tested on :8000):**
- **Native Anthropic provider** `llm/anthropic.ts` (`@anthropic-ai/sdk`) with `cache_control` on the static voice prefix + streaming (`runStream`). Registered in config.ts/llm/index.ts/presets.ts; `.env` = `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` (default `claude-haiku-4-5`). Dashboard Settings can switch to it live. `prompt.ts` now returns `staticPrefix` (voice profile + workspace note, byte-stable) separate from the variable remainder; the anthropic provider caches the prefix, others get the full context unchanged.
- **Personal-context layer** (`context_items` table in db.ts, `context.ts` tenant-scoped CRUD + confirm, tests). `prompt.ts` injects a trusted **ABOUT ME** block from confirmed items. Verified live: a cold-open reply referenced an added project ("Raft-based KV store in Go").
- **Voice sections + shared distill**: `voiceDistill.ts` (extracted, tenant-aware; CLI + endpoints share it), `voiceSections.ts` (sections.json ↔ compile to strategy_analysis.md, adopt-existing), `initVoice.ts` refactored.
- **Endpoints** added to server.ts: `/context` CRUD + `/context/:id/confirm`; `/voice/sections` GET, `/voice/sections/:key` PUT, `/voice/compile`, `/voice/distill` (busts voiceCache). All smoke-tested.

**Wave 2 — built, contract-verified (browser visual check PENDING — extension was disconnected):**
- Dashboard editing UI (`backend/public/*`): Voice tab → editable section cards + Compile bar + paste-to-distill; new **About me** tab → context CRUD with confirm. `node --check` clean, endpoint shapes curl-verified. Served statically (no build/restart needed).

**Not yet done (next):** streaming reply to overlay (SSE + Port relay + overlay incremental — needs browser verification), insight decouple (Phase A), cold-start flows (interview, infer-from-LinkedIn), provenance/confidence per section, gemini-cli plan-mode speed fix.

**To verify Wave 2 visually:** reconnect the Chrome/Edge extension, open `http://localhost:8000/` → Voice + About me tabs. To feel the caching win: set `LLM_PROVIDER=anthropic` + an `ANTHROPIC_API_KEY` and watch a 2nd draft on the same thread.

---

## Cold-open "first message" feature (2026-06-17)

New feature: draft a first message to someone you haven't messaged, from their
**profile** (the profile is the grounding; no conversation). Two entry points:
profile-page overlay (cold-open variant) + popup "Draft a first message" (by URL).

- **Backend** (`prompt.ts`/`server.ts`): new `cold_open` mode — verified live via
  `gemini-cli` (real draft, guard rejects when no `contact_profile` → 400, contact
  + profile persisted, insight skipped). Trust boundary unchanged (profile stays
  UNTRUSTED; intent rides the trusted `steer`).
- **Extension**: cold-open overlay variant (intent box + "Draft intro"), popup
  compose path, `COLD_OPEN_CONTEXT` plumbing. All tsc/tests/build green.
- **Bug found+fixed in browser test**: the profile overlay was gated on
  `!document.hidden`, which also broke background-opened profile tabs. Replaced
  with an `ENRICHMENT_HASH` (`#comms-enrich`) marker the fetcher appends to its
  hidden scrape tabs, so the overlay mounts on any real profile, visibility aside.
- **Selector currency (LinkedIn)**: current LinkedIn profile DOM is the newer
  **obfuscated-class** layout — no `<h1>`, no `#about`/`#experience` id anchors
  (name is an `<h2>`; sections are `<h2>` headings). Updated `profile.ts`
  `readName()` to fall back to `document.title`/og:title (layout-proof) and
  `getSectionRoot()` to fall back to matching `<h2>/<h3>` heading text. Verified
  live: name + Experience section now extract. **Follow-up:** the list-item
  selectors (`.pvs-list__item--line-separated`) and headline/about readers are
  still class-based and likely need refreshing for this layout — affects profile
  enrichment generally, not just cold-open.
- **Verified live in browser (Edge):** on a real LinkedIn profile, the cold-open
  overlay mounts ("First message to <name>"), intent → **Draft intro** → a
  personalized, voice-matched first message rendered in the preview. Name +
  profile extraction work via the new layout-robust selectors. Full round-trip
  confirmed end to end.

---

## Current state (as of 2026-06-17)

**Last commit:** `fbbfc0c  feat: data export + erasure, rate limiting, Dockerfile, deploy guide`

Working tree: untracked release/demo artifacts only (`CLAUDE.md`, `session.md`, `VIDEO.md`, `Communication_Assistant.{srt,mp4}`, `docs/project-report.{html,pdf}`, `docs/images/Screenshot *.png`). No tracked source is dirty.

**Recent commit history**
```
fbbfc0c  feat: data export + erasure, rate limiting, Dockerfile, deploy guide
a7dc536  feat: per-tenant LLM keys (AES-256-GCM), configurable extension URL
dd77b51  feat: bearer-token auth, enforced-mode guard, tenant CLI
3976e70  feat: multi-tenant data model — tenant_id scoping + composite PK/FK
a6e0264  feat: voice eval harness, eval retry fix, manual panel open button
886996b  feat: Gmail extractor, platform abstraction, multi-platform UI copy
```

All pushed to `github.com/Vaidurya-s/Communication_Assistant` (branch `master`).

---

## What works end-to-end right now

- **Reply drafting**: LinkedIn + Gmail extraction (platform abstraction in `extension/src/platforms/`), Shadow-DOM overlay with `Suggest / Follow-up / Shorter / Longer`, parallel reply + insight LLM calls.
- **Memory**: SQLite per-contact notes (with provenance: `proposed_by` / `confirmed_by_user`), strategy log, follow-up dates, profile enrichment columns. All rows scoped by `tenant_id`.
- **Trust boundary**: conversation/profile fenced as `<UNTRUSTED_CONVERSATION>` JSON; voice profile + confirmed memory + steer are the only trusted instructions.
- **Provider flexibility**: `gemini-cli` (sandboxed subprocess) or any `openai-compat` endpoint; switchable live from the dashboard with no restart; presets in `presets.ts`.
- **Hosting groundwork (H1–H5, all landed)**:
  - H1/H1b — multi-tenant data model, composite PK/FK migration gated by `PRAGMA user_version`.
  - H2 — bearer-token auth (`auth.ts`, SHA-256 hashes), `COMMS_REQUIRE_AUTH=1` enforced mode, tenant CLI.
  - H3 — per-tenant LLM keys encrypted at rest (AES-256-GCM, `secretBox.ts` / `secrets.ts`, keyed by `COMMS_SECRET_KEY`).
  - H5 — data export (`GET /export`) + erasure (`POST /data/purge`, confirm-by-tenant-id), per-tenant rate limiting (`rateLimit.ts`), `Dockerfile`, `docs/DEPLOY.md`.
- **Dashboard** at `http://127.0.0.1:8000/` (vanilla HTML in `backend/public/`): Overview, Contacts, Follow-ups, Voice profile, Activity, Settings.
- **Voice eval harness**: `npm run voice:eval` (`backend/src/eval/`).

---

## How to resume

```bash
# from repo root
npm start                 # backend on :8000 (tsx watch)
# extension, only if you changed its source:
npm run build:extension   # → extension/dist, then reload the card in chrome://extensions
```

Sanity check:
```bash
curl http://127.0.0.1:8000/health
# {"ok":true,"voiceProfileChars":<N>,"voiceProfileOk":true,"provider":"...","requireAuth":false}
```

Run tests: `npm test` (root) or `npx vitest run <file>` inside `backend/` or `extension/`.

---

## Next-up / open threads

- **Roadmap tracks** (see `docs/ROADMAP.md`, `docs/ROADMAP-HOSTING.md`): first CI + LinkedIn-selector resilience + Chrome Web Store release; more platforms beyond Gmail; voice-quality eval loop + reply variations; finish the optional hosted mode.
- **H4 (if not done)** — check whether the hosting roadmap's remaining phase (per-tenant voice upload / onboarding UI) has landed; H1–H3 and H5 are in. Verify against `docs/ROADMAP-HOSTING.md`.
- **Selector currency** — when extraction returns 0 messages, use the overlay debug-pane snapshot button → `/snapshots` to capture real DOM and fix `extension/src/content/selectors.ts`.

---

## Gotchas / things to remember

- **session.md is untracked** (never committed) — it's the handoff doc and is safe to commit, but currently isn't in git. Decide whether to commit it.
- **`voice_profile/` and `backend/.env` are gitignored** — a fresh clone has neither; backend refuses to boot in local mode without `voice_profile/strategy_analysis.md`.
- **Live provider switch** mutates `process.env` directly because `config.ts`'s loader only fills *missing* keys — don't "simplify" that to re-reading `.env`.
- **Tenant scoping is mandatory** — every `memory.ts` query takes `tenantId` first. Don't add an unscoped query.
- Large demo binaries (`Communication_Assistant_nocap.mp4`, 38 MB) are untracked in the root — keep them out of commits.

---

## How this doc should be used

Update at the end of any session that changes meaningful state — add to the top or rewrite. Keep it under ~200 lines; archive old content to `session-archive.md` if it grows. Don't paste secrets, `voice_profile/` contents, or any contact's data here.
