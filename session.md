# Session log — Comms Assistant

A running handoff doc. Read this first when you come back; it tells you where things are and how to resume. Pairs with `CLAUDE.md` (architecture reference) — this file is the *current state*, that one is the *durable map*.

---
## The three open items (2026-08-30, later)

**1. The dead model — fixed, but the replacement is slow.** Every 70B Llama is
gone from `integrate.api.nvidia.com`; of 83 listed models most 404 or 410 when
actually called (listed ≠ deployed), and `openai/gpt-oss-120b` is a reasoning
model that returns `content: null` with everything in `reasoning_content`, which
the `openai-compat` provider cannot read. The one that works cleanly is
**`deepseek-ai/deepseek-v4-pro-0813`**, now set via the dashboard's live switch.

It is slow: **49s for a 5k-char prompt, 146s for a 7.8k-char one** — and prompts
are routinely that size now that few-shot examples are injected.
`LLM_TIMEOUT_MS=180000` only just covers it, and it makes the streaming/prefetch
work pointless. Worth moving to the native `anthropic` provider (already built,
with prompt caching, default `claude-haiku-4-5`) or a local Ollama if either is
an option — this endpoint is the weak link now, not the code.

**2. The mojibake was my mistake, not a bug.** `contacts.name` stores
`Sergio Vázquez` correctly — codepoint `e1`, verified straight out of SQLite.
The `Ã¡` reported last session came from piping a UTF-8 HTTP response through a
Windows console decoding it as cp1252. Nothing to fix; no repair was written,
which is the right outcome — a "fix" here would have corrupted correct names.

**3. voice:eval had drifted from the product.** It called `buildPrompt` with
`{ctx, voiceProfile, mode, steer}` while `/analyze` had grown to inject ranked
ABOUT ME items and few-shot examples, so it was scoring a pipeline that no
longer existed: retrieval work could never move the number, and a retrieval
regression would not have shown at all. Fixed — it now assembles the same inputs
`/analyze` does, with `--no-examples` / `--no-aboutme` for genuine before/after,
and both flags recorded in the JSON report.

- **Baseline: 72/100** across the six scenarios with both inputs off.
- The few-shot-ON comparison **did not complete** — the endpoint slowed and then
  stopped responding mid-run. Re-run `npm run voice:eval` (and once with
  `--no-examples`) on a faster provider to get the real number.

### Live checks that were blocked, now done

- **Gmail register** ✓ — greeting, blank-line paragraphs, "Best regards", answers
  the subject without restating it, no `Subject:` line.
- **LinkedIn control** ✓ — visibly different register from the same input: opens
  "Hi ma'am" (the user's own corpus opener), no sign-off, no paragraph breaks.
- **Corpus round-trip** ✓ — `POST /corpus/exchanges` then a draft on a matching
  topic, and the new exchange appears in `explain.examples_used` immediately.
  Run on a throwaway tenant so the real corpus was not touched.

Test contact rows created while verifying were deleted afterwards; contacts are
back to the 40 real ones.

---

## Four gaps found while shipping Track C (2026-08-30)

All six branches from the previous session were merged to `master` and deleted;
`master` is now the only branch and everything below is on it. Working through
Track C surfaced four gaps that were on no roadmap, each verified against the
running system rather than inferred.

**Per-platform register.** `instructionFor` switched on mode only — `platform`
reached the untrusted JSON payload but never the instruction — so Gmail was
drafted with LinkedIn DM rules. Worse, `gmail.ts` had been extracting the
subject line all along and dropping it into a thread-title fallback. Both are
fixed; the subject renders *inside* the untrusted fence, since whoever started
the thread wrote it. LinkedIn maps to the empty register on purpose and a test
asserts its instruction is byte-identical to before. The corpus is
platform-aware too (`<platform>_successful_messages.md`, falling back to the
LinkedIn file), which is what lets a Gmail corpus exist.

**The corpus loop.** The corpus was read by four subsystems and written by none.
The overlay can now add an exchange that got a reply, prefilled from the thread,
and reply rates are computed into a block delimited by HTML comments — the
hand-tallied `## Reply rates by template` section is left untouched beside it.
Trust: this is a **user-reviewed** append, never automatic, and `prompt.ts`'s
NOTE was rewritten to say so; that review is what lets these examples stay
outside the untrusted boundary.

**Follow-ups fire.** There was no `chrome.alarms` code and no permission for it,
so a follow-up only reached you if you went looking. Against the live database
that meant **11 due, the oldest 107 days overdue**. An hourly alarm now polls
`GET /memory/followups` and badges the toolbar icon; the popup lists them with
thread links. Badge, not notification — it's an ambient count, not an interrupt.

**Contact data health.** `upsertContact` validated nothing. A v2 migration
cleans names written before `sanitizeContactName` existed — merging rather than
clobbering when a cleaned name collides with an existing row — and
`GET /memory/health` plus an Overview card make the rot visible. It renders
nothing when everything is clean.

### Bugs caught by the work itself

- `corpusPath` falls back to the LinkedIn corpus when a platform has none, which
  is right for reading and wrong for writing: a Gmail exchange would have been
  appended into `linkedin_successful_messages.md` and could never be separated
  out. Writing goes through `corpusWritePath`, which never follows the fallback.
- The corpus cache was keyed by tenant. With two corpus files per tenant it
  would serve LinkedIn examples for a Gmail draft. Now keyed by resolved path.
- Bumping the shared `SCHEMA_VERSION` made the v1 migration re-run and stamp 2,
  silently skipping the v2 cleanup on exactly the databases that needed it. Each
  migration now gates on and stamps its **own** version.
- The name rename hit a FOREIGN KEY failure — no ordering satisfies the
  constraint mid-rename — so FK enforcement toggles off around the transaction,
  as `migrateToCompositePk` already did.

### Still open

- **The dead model is fixed** — see the section above; the live checks it blocked
  have all been done.
- **39 of 41 contacts still have no enrichment.** The selector fix repairs this
  going forward, but existing rows stay empty until those profiles are opened
  again. The Overview card now says so.
- Verify the four features live once the model is fixed: a Gmail draft reading as
  email, the corpus round-trip showing up in `examples_used`, the badge count,
  and the health card.

Full suite green: **231 backend + 46 extension tests**, both builds clean.

---
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

- **The provider is the weak link now.** deepseek-v4-pro works but takes 49–146s
  per draft depending on prompt size. Moving to the native `anthropic` provider
  (built, with prompt caching) or a local Ollama would make the streaming and
  prefetch work actually pay off, and would unblock the voice:eval comparison.
- **Roadmap** — Tracks A, B, C and D are all done. What genuinely remains:
  **A5 Chrome Web Store submission** (store copy, promo assets, the manual
  billed submission) and **C5 opt-in Google Calendar connect** — which
  deliberately crosses "copy-never-send", so it must stay explicit and off by
  default. Everything else shipped here is off-roadmap work found by using the
  code.
- **Finish the voice:eval comparison.** The harness now measures the real
  pipeline and the baseline is 72/100 (inputs off); the few-shot-ON run needs a
  provider that can complete it. `npm run voice:eval` vs
  `npm run voice:eval -- --no-examples`.
- **Capture a filled-in LinkedIn profile** to finish the Experience/Education
  entry selectors — the one part of the profile fix not verified against real
  DOM.
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
