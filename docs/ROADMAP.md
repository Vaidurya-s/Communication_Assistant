# Comms Assistant — product roadmap

Where the project goes next. Today the core is solid: the LinkedIn overlay → voice-matched
reply → memory loop works, the backend is LLM-agnostic with live provider switching, there's
a full local dashboard, calendar export, and a cohesive redesigned UI. Packaging is ready and
the hosted architecture is designed in [ROADMAP-HOSTING.md](ROADMAP-HOSTING.md).

This document sequences the **four tracks ahead**. They're largely independent, but Track A
makes the others safe to build, and Track B's platform refactor doubles as hosting work — so
the smart order is _a thin slice of A first, then any feature track_. A concrete
**Next 5 PRs** list is at the bottom.

**Guiding principles (unchanged):** local-first, private by design, copy-never-send,
untrusted-content fencing. New work must not quietly cross these lines.

---

## Track A — Ship & harden the MVP

**Why:** the whole product is verified by hand — there's no automated test suite or CI, and a
LinkedIn DOM change can silently break extraction. More features without stability or real
users is the bigger risk right now. This track gets it dependable and into users' hands.

**Work**

- **A1 — Test foundation.** Add Vitest (pairs with the existing Vite setup). Unit-test the pure
  logic first: `backend/src/prompt.ts` (`buildPrompt`), `insight.ts` (the 3-line parser),
  `envFile.ts` (`writeEnv` round-trip), `presets.ts`, `config.ts` (`reloadConfig`), and
  `memory.ts` CRUD against a temp SQLite file. On the extension side, test the extraction
  parsers (`content/diagnostics.ts`, `content/profile.ts`) with jsdom fixtures built from real
  `data/snapshots/` captures. Add `npm test` at the root.
- **A2 — Selector resilience.** Centralised LinkedIn selectors already live in
  `extension/src/content/selectors.ts` and a forensic snapshot/anomaly system exists
  (`content/snapshot.ts`, `/snapshots`). Wire them into a **mount-time self-check** that
  validates the critical selectors (message list, draft field, thread title) and, on miss,
  shows a clear "LinkedIn layout changed — capture a snapshot" state instead of failing
  silently. Give each selector a fallback chain.
- **A3 — Error & offline UX.** The overlay has an offline banner + retry; extend with an error
  taxonomy (backend down vs. LLM error vs. empty extraction), retry/backoff, and a one-click
  "export diagnostics" for bug reports.
- **A4 — Guided first run.** The dashboard Overview and the overlay both already show a setup
  checklist; close the loop so `npm run setup` finishes by opening the dashboard, and each
  unchecked item links to its fix (missing voice profile → `init-voice`; provider unset →
  Settings).
- **A5 — Chrome Web Store submission.** The upload zip (`npm run package:extension`),
  `PRIVACY.md`, and [PUBLISHING.md](PUBLISHING.md) exist. Remaining: store-listing copy, promo
  assets, and the actual submission (a manual, billed step the maintainer does).

**Definition of done:** green CI on every PR (typecheck + tests + build, both packages); the
overlay degrades gracefully when LinkedIn changes; the listing is submitted.

---

## Track B — Multi-platform (Gmail first)

**Why:** extraction is LinkedIn-hardcoded across `content/{linkedin,profile,selectors,index}.ts`,
with route checks in `background/index.ts` and a LinkedIn-only `manifest.json` match. Abstracting
this unlocks new surfaces — and is the same refactor as hosting **H4**, so it counts twice.

**Work**

- **B1 — `PlatformExtractor` abstraction (non-breaking).** Define the interface and move the
  current LinkedIn logic behind a `linkedinExtractor` with no behaviour change; dispatch via the
  existing `content/detector.ts` and a `Record<Platform, PlatformExtractor>` registry in
  `content/index.ts`. `ConversationContext.platform` already exists.

  ```ts
  interface PlatformExtractor {
    isOnPage(loc: Location): boolean;
    extractConversation(): Promise<ConversationContext>;
    extractProfile?(url: string): Promise<ContactProfile | null>;
    observeChanges?(onChange: () => void): MutationObserver | null;
  }
  ```

- **B2 — Gmail extractor.** Add `mail.google.com` to the manifest, implement `gmailExtractor`
  (thread + composer draft + sender), and per-platform enrichment (`extractProfile` is optional
  — Gmail uses the sender card / Google Contacts, not a LinkedIn profile page).
- **B3 — Platform-aware backend.** Minor only: `backend/src/prompt.ts` adds light per-platform
  tone rules. The dashboard is already platform-agnostic.

**Definition of done:** LinkedIn behaviour is unchanged through the new interface; a Gmail
thread produces a voice-matched draft through the same backend. (Detailed in
[ROADMAP-HOSTING.md](ROADMAP-HOSTING.md) **H4**.)

---

## Track C — Deepen the intelligence

**Why:** drafting is single-shot and voice quality is unmeasured; memory is per-contact and
doesn't learn patterns; calendar is export-only.

**Work**

- **C1 — Voice-quality eval harness.** A new `backend/src/eval/` + `npm run voice:eval`: hold
  out some `raw_corpus/` messages, generate replies for their contexts, and score voice-match
  (LLM-as-judge + simple heuristics — length, opener style, formality). Makes prompt/profile
  changes measurable instead of vibes-based, and catches regressions.
- **C2 — Few-shot grounding for every provider.** `gemini-cli` can already grep
  `linkedin_successful_messages.md`; give `openai-compat` the same lift by retrieving the K
  most-similar past successful messages (keyword first, embeddings later) into the prompt in
  `prompt.ts`. Improves voice fidelity uniformly across providers.
- **C3 — Reply variations.** Regenerate exists; add an optional "show 2 variants, pick one"
  flow and feed the pick back as implicit 👍 to `feedback.md`.
- **C4 — Cross-conversation memory.** Notes are per-contact and confirmed-only today
  (provenance model already supports proposed → confirmed). Add a consolidation pass that
  surfaces recurring topics and relationship stage ("you usually open with…", "3rd exchange,
  still warming up") as trusted, user-confirmable hints.
- **C5 — Real Google Calendar connect (opt-in).** The export link stays the default. As a
  strictly opt-in addition, a backend OAuth flow + token store could create events on confirm.
  **Caveat:** this crosses "copy-never-send", so it must be explicit, off by default, and it
  shares the secret-store work with hosting **H3**.

**Definition of done:** a reported voice-match score that moves with profile changes; a variant
picker; calendar connect available but optional and explicit.

---

## Track D — Hosted, multi-tenant service

**Why:** turn the local tool into an online, per-account service. This is the largest track and
is **fully specified in [ROADMAP-HOSTING.md](ROADMAP-HOSTING.md)** — summarised here for
sequencing.

- **H1 — Tenancy data model.** `tenant_id` on `contacts`/`notes`/`strategy_log` via the existing
  `ensureColumn` pattern; scope every `memory.ts` query; per-tenant voice profiles. _Do this on
  the still-local install first — getting per-tenant scoping right is the hardest part._
- **H2 — Auth.** `/auth/*` + a tenant-resolver middleware in `server.ts`; no data route reachable
  without a valid session.
- **H3 — Configurable backend URL + secrets.** The extension's hardcoded
  `BACKEND_URL` (`extension/src/shared/messages.ts`) becomes configurable; per-tenant LLM keys
  move from `.env` to a secret store (shared with **C5**).
- **H4 — Platform-extractor abstraction.** Same work as **Track B**.
- **H5 — Cost, abuse & ops.** Per-tenant metering, rate limits, backups, export/delete; the
  prompt-injection trust boundary stays.

**Definition of done:** see ROADMAP-HOSTING.md exit criteria per phase.

---

## How the tracks interlock

- **Track A is the enabler.** A test harness + CI makes B, C, and D safe to build. Start with a
  thin slice of A (A1 + CI) before committing to a feature track.
- **B == H4.** The `PlatformExtractor` refactor advances both multi-platform and hosting — do it
  once.
- **C5 shares H3.** A real Calendar connect and per-tenant secrets both need a secret store —
  build it once, when either is prioritised.
- Everything stays **shippable** between steps — no track requires a big-bang rewrite.

---

## Next 5 PRs (small, independent, high-leverage)

1. **Vitest + first unit tests** — `prompt.buildPrompt`, `insight` parser, `envFile.writeEnv`,
   `memory` CRUD on a temp DB; add `npm test`.
2. **GitHub Actions CI** — typecheck + test + build for both `backend/` and `extension/` on push/PR.
3. **Selector self-check** — validate critical LinkedIn selectors at mount; on miss, show a clear
   "layout changed" state wired to the existing snapshot/anomaly path.
4. **`PlatformExtractor` interface** — move LinkedIn behind it with zero behaviour change
   (unlocks Gmail and hosting H4).
5. **Voice-eval harness** — `npm run voice:eval` so voice quality is measurable before any
   prompt tuning.

Each leaves the product green and shippable.
