# Session log — Comms Assistant

A running handoff doc. Read this first when you come back; it tells you where things are and how to resume. Pairs with `CLAUDE.md` (architecture reference) — this file is the *current state*, that one is the *durable map*.

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

- **Open the six PRs.** Everything below is pushed but unreviewed; `gh auth login`
  first. Merge the four stacked branches in the order given above.
- **Fix the dead LLM model** (Settings → provider) — nothing drafts until then.
- **Roadmap** — Tracks A, B and D are done (hosting H1–H5 all landed, CI exists,
  Vitest covers both workspaces). Track C is now complete too: C1 voice-eval,
  C2 few-shot, C3 variations, C4 cross-conversation memory. What genuinely
  remains: **A5 Chrome Web Store submission** (store copy, promo assets, the
  manual billed submission) and **C5 opt-in Google Calendar connect** — which
  deliberately crosses "copy-never-send", so it must stay explicit and off by
  default.
- **Capture a filled-in LinkedIn profile** to finish the Experience/Education
  entry selectors — see the caveat above.
- **Selector currency** — when extraction returns 0 messages, use the overlay
  debug-pane snapshot button → `/snapshots` to capture real DOM and fix
  `extension/src/content/selectors.ts`.

---

## Gotchas / things to remember

- **session.md is tracked now** (on `feat/about-me-project-cap`), along with
  `CLAUDE.md` and `VIDEO.md`. Older sections live in `session-archive.md`.
- **`voice_profile/` and `backend/.env` are gitignored** — a fresh clone has neither; backend refuses to boot in local mode without `voice_profile/strategy_analysis.md`.
- **Live provider switch** mutates `process.env` directly because `config.ts`'s loader only fills *missing* keys — don't "simplify" that to re-reading `.env`.
- **Tenant scoping is mandatory** — every `memory.ts` query takes `tenantId` first. Don't add an unscoped query.
- Large demo binaries (`Communication_Assistant*.mp4/.srt`, 38 MB) are now
  **gitignored** rather than merely untracked — keep it that way.
- **The few-shot section must never enter `staticPrefix`** — it's ranked per
  contact, so it would break the anthropic cache prefix on every request. A test
  in `prompt.test.ts` guards this; don't "tidy" it into the prefix.

---

## How this doc should be used

Update at the end of any session that changes meaningful state — add to the top or rewrite. Keep it under ~200 lines; archive old content to `session-archive.md` if it grows. Don't paste secrets, `voice_profile/` contents, or any contact's data here.
