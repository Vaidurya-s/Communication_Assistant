# Session archive — Comms Assistant

Superseded sections moved out of `session.md` to keep it scannable (its own
rule: stay under ~200 lines). All of this work has landed on `master`.

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

