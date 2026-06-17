# Voice profile — onboarding & editing overhaul (plan)

**Status:** Phases 1–4 shipped (editable voice tab, sectioned authoring, personal-
context layer + contact-matched retrieval, cold-start flows). Phase 5 in progress:
`feedback/apply`, **structured 👎 chips** (overlay chips route a thumbs-down to a
specific voice section; stored in feedback.md + shown in the console inbox), and
**voice lint** (deterministic, no-LLM check flagging draft words the profile says to
avoid — `voiceLint.ts` + `POST /voice/lint` + overlay heads-up), and **edit-mining**
(opt-in: the diff between a suggestion and what the user copies is captured as a
candidate correction — `editMining.ts` + `POST /voice/edits` + popup toggle, folded
into `feedback/apply`), and **profile versioning + revert** (every destructive
op — compile/distill/apply — auto-snapshots the prior profile; `voiceVersions.ts` +
`GET /voice/versions` + `POST /voice/versions/:id/restore` + console version history)
are done. **Explainability** (deterministic slice) is also done: `/analyze` returns
an `explain` block (which ABOUT ME items were injected + memory-note count + voice
size) in stats, and the overlay shows a "Why this draft?" expander. Remaining Phase 5
(all LLM-harness-dependent): dashboard `voice:eval` + A/B, golden-thread guard.
**Owner decisions captured (2026-06-17):** one unified system (voice + personal
context); edited in the dashboard; cold-start via guided interview + paste corpus
+ infer-from-LinkedIn; runtime model = compile voice to a single file, context as
a separate trusted store (recommended below).

This doc pairs with `CLAUDE.md` (architecture) and `session.md` (current state).

---

## 1. Why

The voice profile is the single biggest lever on output quality, and today it's
the roughest surface in the product:

- Onboarding is terminal-bound: drop files into `voice_profile/raw_corpus/`, run
  `npm run init-voice`, hand-edit a ~15 KB `strategy_analysis.md`.
- The dashboard **Voice profile** tab (`#voiceContent`) is **read-only**.
- Editing is "open one big markdown blob," with no way to iterate on a single
  aspect ("my closings sound stiff") without touching everything.
- There is **no place for personal substance** — projects, achievements, bio.
  Replies are grounded in voice + the contact's info + the conversation, never in
  real facts about *the user*. This especially starves the new **cold-open
  first-message** feature, which is the user selling themselves.

Goals: **easier, faster, interactive, better** — and in-dashboard (which is also a
prerequisite for hosted mode, since hosted tenants have no CLI).

---

## 2. Core concept: two layers, not one

The current "voice profile" blurs two different things. We separate them:

| Layer | Question it answers | Role in the prompt | Lifecycle |
|------|--------------------|--------------------|-----------|
| **Voice** | *How* do I write? | Shapes **style** | Distilled once, refined |
| **Context** | *What* can I truthfully reference? | Provides **substance** | Added/edited over time |

- **Voice**: openers, rhythm, how I disagree, vocabulary, closings, register
  shifts. This is what `strategy_analysis.md` already captures.
- **Context (new)**: projects, achievements, bio, what I'm looking for. Does not
  exist today. Trusted facts the assistant can weave into replies.

"Previous chats" is **voice** raw material (corpus). "Projects / achievements" is
**context** substance. Keeping them distinct drives every decision below.

---

## 3. Runtime model (decided: recommendation)

**Voice → compiles down into the existing single `strategy_analysis.md`.**
Sections are an *authoring convenience*; a **Compile** action assembles them into
the one runtime artifact. The runtime contract is **unchanged** —
`voiceProfile.ts` / `prompt.ts` still load exactly one file — so all voice work is
**additive and low-risk** to the hot path.

**Context → a separate, structured, tenant-scoped store**, injected as a **trusted
"ABOUT ME" block** in `prompt.ts`, parallel to the existing confirmed-memory block
("WHAT I ALREADY KNOW ABOUT THIS PERSON"). Start **inject-all**; add **retrieval**
(top 2–3 relevant items) only when item counts grow.

Why not "inject sections directly at request time": it would reopen prompt-size
and trust-boundary questions the codebase has already settled. Compile-to-file
keeps the clean single-file/single-trust-boundary design and reuses the existing
trusted-injection pattern. Voice and context then evolve independently.

**Trust:** voice + user-authored context are **trusted** (the user wrote them) →
injected *outside* the `<UNTRUSTED_CONVERSATION>` boundary. Anything auto-imported
(e.g. inferred from LinkedIn) is **proposed, not trusted**, until the user
confirms it in the dashboard — mirroring how memory notes require a Save click.

---

## 4. Data model

### 4.1 Voice sections
Stored as structured JSON in the tenant's voice dir (filesystem, matching the
existing `voice_profile/` pattern; human-inspectable; co-located with corpus and
compiled output):

```
voice_profile/sections.json        # local tenant
backend/data/tenants/<id>/voice_profile/sections.json   # other tenants
```

```jsonc
{
  "version": 1,
  "updatedAt": "2026-06-17T...",
  "sections": {
    "openers":        { "body": "...", "source": "distilled|manual|interview" },
    "rhythm":         { "body": "...", "source": "..." },
    "disagreeing":    { ... },
    "questions":      { ... },
    "closings":       { ... },
    "registers":      { ... },
    "vocabulary":     { ... },   // use / avoid
    "declining":      { ... }
  }
}
```

`Compile` renders `sections.json` → `strategy_analysis.md` (the runtime artifact).
**Backwards compatible:** if `sections.json` is absent, the existing
`strategy_analysis.md` is used as-is, so current installs keep working and can be
"adopted" into sections later (a one-time split-from-existing action).

The dead companion files (`tone.md`, `vocabulary.md`, `registers.md`,
`writing_patterns.md`, `boundaries.md`, `examples.md`) are superseded by
`sections.json`; migrate any real content out of them during Phase 2, then leave
them or delete.

### 4.2 Personal context (new)
SQLite, tenant-scoped (matches the `memory` pattern; enables future retrieval):

```sql
CREATE TABLE context_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL DEFAULT 'local',
  type         TEXT NOT NULL CHECK (type IN ('project','achievement','bio','looking_for')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  tags         TEXT,                         -- comma-separated, for future retrieval
  confirmed    INTEGER NOT NULL DEFAULT 1,   -- 0 for auto-proposed (e.g. from LinkedIn) until user confirms
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_context_tenant ON context_items(tenant_id, type);
```

Schema added via the existing gated-migration mechanism in `db.ts`
(`ensureColumn` / `user_version`).

---

## 5. Prompt assembly

`buildPrompt()` gains an `aboutMe?: ContextItem[]` input. New **trusted** block,
outside the untrusted boundary, next to the memory section:

```
=== ABOUT ME (trusted — facts about myself I can reference) ===
Projects:
- <title>: <body>
Achievements:
- <title>: <body>
Bio: <...>
Looking for: <...>
```

- Only `confirmed = 1` items are injected (proposed items stay out until the user
  confirms — same trust gate as memory).
- `server.ts /analyze` loads confirmed context for the tenant and passes it.
- **Cold-open especially** benefits: the first-message instruction already
  references the contact's profile; now it can also lean on the user's real
  projects/achievements.
- Size control: Phase 3 = inject-all; add a `selectRelevantContext(items, ctx)`
  retrieval pass later (tag/keyword match against the conversation/contact).

---

## 6. Backend endpoints (new / changed)

All tenant-scoped via the existing `tenant(req)` helper; all behind the auth guard.

**Voice**
- `GET  /voice/sections` → `{ sections, compiledAt, compiledChars }`
- `PUT  /voice/sections/:key` → save one section's body (manual edit)
- `POST /voice/sections/:key/regenerate` → re-distill one section from corpus (LLM)
- `POST /voice/compile` → assemble `sections.json` → `strategy_analysis.md`; **bust `voiceCache`** in `server.ts`
- `POST /voice/distill` → paste a corpus in-browser → full distill (the in-dashboard `init-voice`); reuses `initVoice.ts` `INSTRUCTION` + `runLLM`
- `POST /voice/corpus` → append pasted messages to `raw_corpus/`
- `GET  /voice/preview` → run a sample draft on a fixed example thread with the current profile (live "see the effect")
- *(existing)* `GET /voice` stays for the read view / feedback history

**Context**
- `GET    /context` → items grouped by type (confirmed + proposed)
- `POST   /context` → create `{type,title,body,tags}`
- `PUT    /context/:id` / `DELETE /context/:id`
- `POST   /context/:id/confirm` → confirm a proposed item

**Cold-start**
- `POST /onboarding/interview` → `{ step, answers }` → next question, or final
  `{ sections, contextItems }` to review
- `POST /onboarding/from-linkedin` → `{ profile }` (the user's **own** scraped
  profile, posted by the extension) → proposed sections + proposed context items
  (all `confirmed = 0`)

**Feedback loop**
- `POST /voice/feedback/apply` → fold `feedback.md` corrections into a regenerate
  (one-click version of re-running `init-voice`)

Refactor note: extract the distill logic from `initVoice.ts` into a shared module
(e.g. `voiceDistill.ts`) so the CLI **and** the `/voice/distill` + per-section
regenerate endpoints share one implementation.

---

## 7. Dashboard UI (the editing experience)

The **Voice profile** view (`#voiceContent`, vanilla HTML/JS in
`backend/public/`) becomes interactive. Layout:

- **Top: status + Compile.** Compiled size, "last compiled" time, eval score
  (Phase 5), and a prominent **Compile** button (dirty-state aware: highlight when
  sections changed since last compile).
- **Voice section cards.** One card per section. Each: editable textarea +
  **Regenerate from my messages** + Save. Collapsed by default, expand to edit.
- **About me (context) cards.** Grouped Projects / Achievements / Bio / Looking
  for. Add/edit/delete items inline. Proposed items (from LinkedIn/interview) show
  a **Confirm** affordance.
- **Live preview panel.** A fixed example thread + "Draft with current profile"
  so edits show their effect immediately.
- **Onboarding entry points** (shown prominently when the profile is empty/thin):
  *Start interview* · *Paste my messages* · *Use my LinkedIn*.
- **Feedback inbox.** Pending 👎 corrections with **Apply to profile**.

No build step (matches the existing console). New `fetch` calls follow the
existing `app.js` patterns.

---

## 8. Cold-start flows (all three feed the same stores)

1. **Paste corpus** — textarea → `POST /voice/corpus` then `POST /voice/distill`
   → review/edit → Compile. (Today's flow, minus file-dropping and the terminal.)
2. **Guided interview** — `POST /onboarding/interview` drives 4–6 questions:
   - "Paste 2 messages you're proud of."
   - "How do you open with someone senior vs. a peer?"
   - "Words/phrases you never use?"
   - "Name 2–3 projects you'd mention when introducing yourself."
   - "A recent achievement you're proud of?"
   The LLM maps answers → voice sections **and** context items (proposed). User
   reviews and confirms.
3. **Infer from LinkedIn** — reuse the **profile extractor we just fixed**
   (`extension/src/content/profile.ts`) against the user's **own** profile:
   experience → Projects, headline/about → Bio, posts (if read) → a voice sample.
   Extension posts it to `POST /onboarding/from-linkedin`; everything lands as
   **proposed** for confirmation. Lowest-friction start.

---

## 9. Feedback loop improvements

- Today: 👍/👎 → `feedback.md` → user must manually re-run `init-voice`. Make it
  one-click (`POST /voice/feedback/apply`) and route a 👎 + reason toward the most
  relevant **section**.
- **Edit-mining (high value, later):** the diff between a suggestion and what the
  user actually sends (after editing in the overlay before Copy) is the most
  honest voice signal we have, and it's currently discarded. Capture it
  (on-device, opt-in) as candidate corrections. Privacy-preserving by default,
  consistent with the product posture.

---

## 10. Phased roadmap (execute in order; each ships value)

### Phase 1 — Editable voice tab (kill the terminal)
- `GET /voice` already returns content; add `PUT /voice` to save the compiled
  file, and `POST /voice/distill` + `POST /voice/corpus` for in-browser paste.
- Make `#voiceContent` an editable textarea + Save + "Paste messages → Distill".
- Bust `voiceCache` on save/distill.
- **Enhancements (brainstorm):**
  - **Onboard by correction** — first run drafts *one* message in a neutral voice
    on a sample thread → "make this sound like you"; that edit is the first, highest-signal sample.
  - **Paste-anything ingestion** — LLM segments a messy paste (full chat export,
    quoted email thread) into *sent* vs *received*; no curation required.
  - **Multi-channel corpus, auto-tagged** (LinkedIn / email / WhatsApp / Slack) —
    the tags feed the register-shifts section directly.
  - **Voice strength meter** — replace the binary boot check with a strength score
    + "the single best next thing to add." Turns onboarding from a wall into a ladder.
- **Done when:** a user can onboard and edit their voice entirely in the browser,
  no terminal. CLI still works.

### Phase 2 — Sectioned voice authoring
- `sections.json` model + `voiceSections.ts` (load/save/compile).
- Extract distill into `voiceDistill.ts`; add per-section regenerate.
- Endpoints: `GET/PUT /voice/sections*`, `POST /voice/sections/:key/regenerate`,
  `POST /voice/compile`. "Adopt existing `strategy_analysis.md` into sections" action.
- Dashboard: section cards.
- **Enhancements (brainstorm):**
  - **Provenance per section** — each card shows the 2–3 sample fragments that
    produced the observation. Builds trust *and* fights the LLM laundering its own
    generic style in (an observation must be quotable).
  - **Confidence + coverage radar** — the LLM flags thin sections ("only 2 examples
    of how you decline") so effort goes where the voice is weak.
  - **Layered overrides + pin/lock** — distilled base + manual overrides on top, so
    re-distilling never clobbers a section you've perfected; lock sections to exclude
    them from regenerate.
  - **Diff-on-regenerate** — show before/after and accept/reject; no blind overwrites.
- **Done when:** a user edits/regenerates one section and compiles to the runtime file.

### Phase 3 — Personal-context layer (the new capability)
- `context_items` table + `context.ts` (CRUD, tenant-scoped) + gated migration.
- `buildPrompt()` gains the trusted **ABOUT ME** block; `/analyze` loads context.
- Endpoints: `GET/POST/PUT/DELETE /context`, `/context/:id/confirm`.
- Dashboard: About-me cards. Wire into **cold-open** first.
- **Enhancements (brainstorm):**
  - **Mine context from the same corpus** — while distilling voice, also extract
    "facts about me" the user stated ("I led the X migration") → *proposed* context
    items. One paste, both layers.
  - **Contact-matched retrieval** — rank context items against the contact's
    **scraped profile** (reuses the extractor we just fixed): surface *your*
    distributed-systems project when messaging a distributed-systems person. The
    single biggest cold-open lift.
  - **"When to use" + audience tags** — e.g. "lead with this for recruiters";
    distinguish *reference-this* (things you'd say) from *be-aware-of-this* (shapes
    tone, never stated).
  - **Usage tracking + freshness** — which proof points actually get used; prefer
    recent achievements; flag a stale bio.
- **Done when:** a reply (esp. a cold-open) references a real project/achievement.

### Phase 4 — Cold-start flows
- `POST /onboarding/interview` (stateful Q&A → sections + proposed context).
- `POST /onboarding/from-linkedin` + extension posts the user's own profile.
- Dashboard onboarding entry points + proposed-item confirm UX.
- **Enhancements (brainstorm):**
  - **"Steal my voice from one great message"** — true-MVP onboarding: bootstrap
    from a single high-signal message the user wrote, grow later.
  - **Own LinkedIn posts/comments** as first-person public voice samples (richer
    than the About text); the extension can collect a few.
- **Done when:** a new user reaches a usable profile via any of the three paths,
  no corpus required.

### Phase 5 — Feedback automation & iteration tooling
- `POST /voice/feedback/apply`; route corrections to sections.
- Edit-mining capture (opt-in).
- Run `voice:eval` from the dashboard; show score; A/B two profile versions;
  profile version/snapshot + revert.
- **Enhancements (brainstorm):**
  - **Structured 👎 chips** ("too formal / too long / not my opener / wrong vibe")
    map a vague thumbs-down straight to a *specific section* correction.
  - **👍 + Copy grows the corpus** — accepted drafts quietly become good samples;
    the profile improves just from use.
  - **Correction-diff preview** — show how the profile would change before applying.
  - **Golden-thread regression guard** — keep a few threads with *your approved*
    replies; after any profile change, re-draft them and flag divergence (catches a
    regeneration that fixed one thing and broke another).
  - **Voice lint (no LLM)** — deterministic checks against your own stated rules
    ("you said you avoid 'circle back' — this draft used it").
  - **Explainability** — "why did it write this?" → which sections + context items drove the draft.
- **Done when:** the profile improves from use with minimal manual work.

---

## 11. Open decisions (not blocking; revisit per phase)
- **Context injection:** inject-all (Phase 3) → retrieval (later, when items grow).
- **Interview:** one-time onboarding vs. a re-runnable "refine my voice."
- **Context storage:** SQLite (recommended) vs. per-tenant JSON. Leaning SQLite
  for queryability + retrieval; revisit if it complicates the file-based voice dir.
- **Voice sections storage:** JSON file (recommended, co-located) vs. SQLite. JSON
  keeps voice human-inspectable and matches the existing `voice_profile/` model.
- **Edit-mining:** default on (opt-out) vs. opt-in. Lean opt-in for privacy.

---

## 12. Constraints to honor
- **Trust boundary:** voice + confirmed context are trusted (outside
  `<UNTRUSTED_CONVERSATION>`). Auto-imported/proposed content is untrusted until
  the user confirms — same gate as memory notes.
- **Multi-tenant:** every new store/endpoint is `tenant_id`-scoped via
  `tenant(req)`; voice dirs already resolve per tenant (`voiceDirFor`).
- **Hosted mode:** in-dashboard onboarding is required there (no CLI) — this work
  advances the hosting roadmap.
- **Backwards compatibility:** `strategy_analysis.md` remains the runtime artifact;
  installs without `sections.json` / context keep working unchanged.
- **No build step** for the console; **bust `voiceCache`** whenever the compiled
  profile changes (mirror the `/config` cache-busting pattern).

---

## 13. Touch map (where the work lands)
- Backend: `voiceProfile.ts`, new `voiceSections.ts` / `voiceDistill.ts` /
  `context.ts`, `prompt.ts` (ABOUT ME block), `server.ts` (new routes + cache
  bust), `db.ts` (context table), `initVoice.ts` (refactor to share distill).
- Extension: `content/profile.ts` + a "use my LinkedIn" path posting the user's
  own profile to `/onboarding/from-linkedin`; overlay edit-mining capture (Phase 5).
- Console: `backend/public/index.html` + `app.js` + `style.css` (Voice view).

---

## 14. Cross-cutting reframes (apply across phases)

These aren't single phases — they're lenses that shape several.

- **G. Voice as a *living thing*, not a setup wizard.** The profile continuously
  learns from every accepted edit, 👍/👎, and corpus drop. The Voice tab becomes
  "your evolving voice," not a config screen. Informs Phases 1 and 5.
- **Voice-strength model.** A single strength score + per-section coverage radar +
  "next best thing to add." Replaces the binary boot check, gates quality messaging
  ("your voice is thin — replies may sound generic"), and drives onboarding. Spans
  Phases 1–2.
- **H. Multi-voice / registers as first-class.** You don't have one voice
  (recruiter ≠ friend, LinkedIn ≠ Gmail). A lightweight learned tone-dial per
  context, or named presets, feeding the register-shifts section. **Defer — watch
  complexity;** candidate Phase 6.
- **I. Privacy as a visible onboarding feature.** Surface "voice never leaves your
  machine," one-click export/delete (reuse `/export`, `/data/purge`), and
  proposed-items-need-confirmation — exactly when asking the user to paste personal
  data. It's a differentiator and it earns the trust the paste requires. Phases 1/4.
- **J. Unify "confirm a fact" across self and contacts.** A confirmed context item
  (about you) and a confirmed contact note are symmetric — share the confirm-UX,
  and let the insight pipeline propose context items the way it proposes contact
  notes. Phase 3.
- **K. Behavior-driven nudges.** Use real usage to drive improvement ("5 drafts,
  no project referenced — add one?"; "recruiter replies keep getting heavily edited
  — tune your formal register"). The product notices its own gaps. Phase 5.

---

## 15. Tensions to manage

- **"Easier/faster" vs. "sectioned/better" pull opposite ways.** Eight voice
  sections + context types + confidence + provenance can make onboarding feel like
  *more* work. Structure must be **available, not required** — progressive
  disclosure + onboard-by-correction.
- **Always-injected context → every reply reads like a humble-brag.** Retrieval +
  restraint + an explicit "reference context only when natural" instruction.
- **Small corpus → bland or over-fit voice.** The strength meter and
  provenance-grounding guard both failure modes.
- **The distilling LLM launders its own generic style in.** Require *quotable*
  provenance per observation so "friendly and professional" can't survive.

---

## 16. Priority unlocks (highest value-per-effort)

1. **Contact-matched context retrieval** (Phase 3) — highest quality-per-effort,
   and it directly supercharges the cold-open feature we just shipped.
2. **Onboard-by-correction + grow-corpus-from-accepted-drafts** (Phases 1 + 5) —
   kills cold-start *and* makes the profile self-improving with no extra user work.
3. **Provenance + confidence per section** (Phase 2) — makes editing feel
   trustworthy and fast instead of like staring at a wall of AI text.
