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

---

## Branch cleanup + the four remaining feature tracks (2026-08-29)

Cleared the branch backlog and shipped everything still open on the roadmap.
**Six branches are on the remote awaiting review.** `gh` was not authenticated,
so the PRs still need opening — run `gh auth login`, then open one per branch.

**Branch hygiene.** Five local branches were already merged into `master` and
were deleted; `feat/cold-open-first-message` in particular was a byte-identical
duplicate of `612c3d6` (same `git patch-id`), not pending work. Two stale remote
branches (`feat/structured-feedback`, `feat/voice-and-perf`) were deleted too.
The demo render (`Communication_Assistant*.mp4/.srt`, 38 MB) is now gitignored;
`CLAUDE.md`, `session.md`, `VIDEO.md` and the report artifacts are tracked, with
the four architecture diagrams renamed from their camera-roll filenames.

**Branches on the remote.** The last four stack in this order — each edits the
same `server.ts` / `prompt.ts` regions, so merge them in sequence:

| Branch | What | Base |
|---|---|---|
| `fix/extraction-render-race` | The 4 render-race commits, previously unpushed | master |
| `fix/linkedin-profile-selectors` | Profile extraction vs. the server-driven layout | master |
| `feat/about-me-project-cap` | ABOUT ME project cap + the docs commit | master |
| `feat/few-shot-grounding` | C2 | ↑ |
| `feat/reply-variations` | C3 | ↑ |
| `feat/cross-conversation-memory` | C4 | ↑ |

**C2 — few-shot grounding** (`backend/src/corpus.ts`). Only `gemini-cli` could
reach `linkedin_successful_messages.md`; every toolless provider (anthropic,
openai-compat — now the default) got nothing. The two most on-topic exchanges
are now injected per contact, ranked with the *existing* `selectRelevantContext`.
Two things the real corpus forced: it interleaves genuine exchanges with the
user's own distilled analysis ("Punctuation quirks"), so `parseCorpus` keeps only
sections that transcribe a message (20 of 30); and the section renders in the
VARIABLE remainder, never `staticPrefix`, or the anthropic cache prefix would
change on every request. A test pins that.

**LinkedIn profile selectors.** LinkedIn moved profiles to a **server-driven
UI**. Verified live: no `<h1>`, no `#about`/`#experience` anchors, no `og:` meta
or JSON-LD on the logged-in SPA, no `.pvs-list__item--line-separated`, and zero
`span[aria-hidden="true"]` duplication — every hook the readers used. What it
*does* give is a stable semantic card id,
`com.linkedin.sdui.profile.card.ref<opaque>About`, which `getSectionRoot` now
tries first. The top card is ~10 levels of anonymous div, so identity fields are
read by anchoring on the name heading and taking only its DIRECT-CHILD `<p>`
siblings — that is what separates the headline from the "Verify in 2 minutes"
promo and four upsells. Location is found via the "Contact info" landmark. The
chains moved into `content/selectors.ts` (they had rotted precisely because
`profile.ts` inlined its own, against what CLAUDE.md says). Verified on the real
page: name, headline, company, location, about and skills all extract;
previously only name did.

- **Not observed:** Experience/Education entry markup — the profile available for
  capture has none of those sections. Those readers depend only on what every
  layout shares, and `profileExtractionGaps()` plus a console warning now fire
  instead of returning an empty shell in silence. Capture a real one next time
  you view a filled-in profile.

**C3 — "Another take".** A second draft rendered *beside* the first (Regenerate
replaces it), generated on demand so the fast streaming first draft is never
slowed by a speculative second call. `variation_of` is a first-class trusted
field, outside the untrusted fence. Picking either draft posts an implicit 👍 via
the existing `/feedback` route. The prefetch cache needed a guard — without it a
variation request would be served the very draft the user wanted an alternative
to.

**C4 — cross-conversation patterns** (`backend/src/memoryPatterns.ts`, pure).
`GET /memory/patterns` is READ-ONLY; adopting a proposal goes through the
existing gates (`POST /context`, `POST /memory/notes/manual`), so no new trusted
channel is created. Real data taught two lessons, both now tested: ranking on raw
recurrence surfaced "potential" / "collaboration" / "opportunities" — strategy-log
boilerplate, because the model repeats its own advice shape — so a theme must now
be grounded in a **confirmed note**. With that, the top theme became "quantum",
which is correct.

### Two real problems found along the way (neither fixed here)

1. **The configured LLM model is dead.** `.env` points at
   `meta/llama-3.1-70b-instruct` on NVIDIA, which reached end-of-life
   2026-08-26 — every `/analyze` returns `410 Gone`. Pick a current model in the
   dashboard's Settings tab. This is why C2 was verified through a direct
   prompt-assembly probe rather than a live draft.
2. **A stored contact name contains scraped UI chrome** — `contacts.name` holds
   `"Divyanshu Gupta Status is reachable Mobile • 10h"`; thread-title extraction
   swallowed the presence indicator. `memoryPatterns` cleans names before they
   enter a proposal, but that is damage control: the stored row is still wrong,
   and whatever wrote it needs a look.

Full suite green throughout: **188 backend + 33 extension tests**, both builds
clean.

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

