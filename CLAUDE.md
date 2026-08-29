# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Comms Assistant drafts LinkedIn (and now Gmail) replies in the user's own voice. Two pieces, both running on the user's machine:

- **`extension/`** — a Chrome MV3 extension (React + TypeScript, built with Vite + `@crxjs/vite-plugin`). Content scripts scrape the open conversation; an overlay (Shadow DOM React) drafts the reply.
- **`backend/`** — a local Express + TypeScript server (ESM, `tsx`/`tsc`, `better-sqlite3`). Builds the prompt, calls the LLM, persists per-contact memory, and serves a vanilla-HTML dashboard from `backend/public/`.

The project is shifting from a single-user local tool toward an optionally **multi-tenant** hosted service. Most code is now tenant-scoped even though the default install runs as the single implicit `local` tenant.

## Commands

Run from the repo root unless noted. Both workspaces are driven from root scripts in `package.json`.

```bash
npm run setup            # install deps (backend + extension), build extension, scaffold config
npm start                # start backend (delegates to backend `dev`: tsx watch, :8000)
npm run build:extension  # rebuild extension → extension/dist (tsc --noEmit && vite build)
npm test                 # backend vitest + extension vitest
npm run init-voice       # distill voice_profile/raw_corpus/ → strategy_analysis.md
npm run voice:eval       # voice-quality eval harness
npm run doctor           # environment health check (scripts/doctor.mjs)
```

Per-workspace (cd into `backend/` or `extension/`):

```bash
# backend
npm run dev              # tsx watch src/server.ts (:8000)
npm test                 # vitest run
npx vitest run src/auth.test.ts          # a single test file
npx vitest run -t "rejects revoked token" # a single test by name
npm run build            # tsc → dist/  (start prod with `npm start` = node dist/server.js)

# extension
npm run build            # type-check + vite build → dist/
npm test                 # vitest run (jsdom)
```

Tests are **vitest** in both workspaces (`*.test.ts` colocated with source). The backend points `COMMS_DB_PATH` at a throwaway SQLite file per test — never against `backend/data/memory.sqlite`.

### Tenant admin CLI (hosted mode)

```bash
cd backend
npm run tenant:create -- <id> [label...]              # mint a bearer token (printed ONCE)
npm run tenant:list
npm run tenant:llm    -- <id> <gemini-cli|openai-compat> [model] [baseUrl]
# API key passed via COMMS_TENANT_KEY env (kept out of shell history);
# storing it requires COMMS_SECRET_KEY to be set.
```

## Architecture

### Request flow (one reply)

`extension content script` extracts `{messages, draft, contact_profile, page_metadata}` → `background` forwards to `POST /analyze` → backend fires **two LLM calls in parallel** (`Promise.allSettled`):

1. **reply** (`prompt.ts` `buildPrompt` → `runLLM`) — the user-facing draft.
2. **insight** (`insight.ts` `generateInsight`) — proposes a memory note, a free-form strategy line, and a follow-up date. Best-effort: if it fails, the reply is still returned.

The reply is returned with `stats`; confirmed memory and strategy are persisted to SQLite. `server.ts` is the single source of routing truth — read it first.

### The trust boundary (security-critical, do not weaken)

Conversation/profile text is **attacker-controlled** (a contact can write "ignore previous instructions" in a message or their LinkedIn About). `prompt.ts` serializes all of it as JSON inside `<UNTRUSTED_CONVERSATION>` tags and instructs the model to treat it as data. Only three things are **trusted instructions**, kept *outside* that boundary: the voice profile, user-confirmed memory notes, and the user's own steer. Memory notes are trusted **only because** the overlay's "Save" click is the confirmation gate — if you ever auto-persist notes without user confirmation, that assumption breaks (see the NOTE in `prompt.ts`). Profile enrichment fields go *inside* the untrusted boundary even though they're structured.

### LLM providers (`backend/src/llm/`)

Two providers behind one `LLMProvider` interface (`types.ts`):
- **`gemini-cli`** — spawns the local `gemini` CLI as a subprocess with cwd set to the **workspace sandbox** (`workspace.ts`), stdin-only, so the model can only `grep`/`Read` allowlisted corpus files — never `voice_profile/` or project source. This is the only provider that can grep the raw corpus on demand.
- **`openai-compat`** — any OpenAI-compatible Chat Completions endpoint (OpenAI, Anthropic, Gemini API, OpenRouter, Mistral, Groq, Ollama, LM Studio — see `presets.ts`).

`llm/index.ts` resolves the provider **per tenant**: the `local` tenant uses the process-global provider built from `.env`; a tenant with stored config gets a provider built from its own (encrypted) key. Providers are cached and busted by `resetProvider()` / `resetProviderFor(tenant)`. Provider/model/key can be switched **live from the dashboard** (`POST /config` writes `.env` *and* mutates `process.env`, then busts caches — no restart). `config.ts`'s loader only fills env keys that are **missing** from `process.env`, which is why the live switch must mutate `process.env` directly.

### Config & secrets

- `config.ts` — hand-rolled `.env` loader (no dotenv dep) + typed `Config`. Cached; `reloadConfig()` rebuilds it. Key env vars: `LLM_PROVIDER`, `OPENAI_*`, `LLM_TIMEOUT_MS`, `COMMS_REQUIRE_AUTH`, `COMMS_CORS_ORIGINS`, `COMMS_RATE_LIMIT_PER_MIN`, `COMMS_BIND_HOST`, `COMMS_DB_PATH`, `COMMS_SECRET_KEY`.
- `secretBox.ts` — AES-256-GCM (scrypt-derived per-blob key from `COMMS_SECRET_KEY`) for per-tenant API keys at rest. Blob format `v1.<salt>.<iv>.<tag>.<ct>`. Keys are **never** stored plaintext.

### Multi-tenancy & auth

- **Local mode (default, `requireAuth=false`)**: unauthenticated requests act as the `local` tenant. The backend binds to `127.0.0.1` and refuses to boot if the local voice profile is missing/empty (`validateVoiceProfile()`).
- **Hosted mode (`COMMS_REQUIRE_AUTH=1`)**: every data route needs `Authorization: Bearer <token>`. The auth guard in `server.ts` runs *after* the public routes (static dashboard + `/health`) so the console can load to paste a token. Tokens are stored as SHA-256 hashes only (`auth.ts`, `tenants` table).
- **Every** DB row is scoped by `tenant_id`. `memory.ts` / `tenantData.ts` always take a `tenantId` first arg. When adding a query, thread the tenant through — never query without it.

### Database (`backend/src/db.ts`)

Single SQLite file, schema applied idempotently on every boot. Tables: `contacts` (composite PK `(tenant_id, name)` with enrichment columns), `notes` (composite FK → contacts, `ON DELETE CASCADE`, with provenance columns `proposed_by`/`confirmed_by_user`), `strategy_log`, `tenants`, `tenant_secrets`. Structural rebuilds are gated by `PRAGMA user_version` (`SCHEMA_VERSION`) so they run once; additive columns use the `ensureColumn` helper. If you add an enrichment column, add it both in the `CREATE` block **and** as an `ensureColumn` call (for upgraded DBs), and — if it belongs in a rebuilt table — in `migrateToCompositePk`.

### Extension internals (`extension/src/`)

- **`platforms/`** — `PlatformExtractor` abstraction. `registry.ts` picks the extractor for the current URL (content-script only — pulls in DOM code). `urls.ts` is the pure URL-matching half used by the background worker. Add a platform here (`linkedin.ts`, `gmail.ts`).
- **`content/selectors.ts`** — single source of truth for DOM selectors, written as **semantically diverse fallback chains** (class / ARIA / data-*). **First place to look when extraction breaks.**
- **`content/snapshot.ts` + `/snapshots` endpoint** — first-class debugging workflow: when extraction looks anomalous, a forensic DOM capture is armed (or captured manually from the debug pane) and POSTed to the backend (`data/snapshots/`) so selectors can be fixed against **real DOM**, not guesses.
- **`content/diagnostics.ts`** — `ExtractionDiagnostics` + anomaly tags; new anomaly types go here.
- **`overlay/Overlay.tsx`** — Shadow-DOM React UI: reply modes (`Suggest / Follow-up / Shorter / Longer`), memory card, strategy line, follow-up chip, debug pane. Never auto-sends — copy only.
- **`background/index.ts`** — service worker; auto-injects the content script via `chrome.scripting.executeScript`, forwards mode/seed to the backend. `profileFetcher.ts` fetches contact profiles.

### Voice profile (`voice_profile/`, gitignored)

`strategy_analysis.md` is the **single canonical compiled artifact** injected at inference time. The other files (`tone.md`, `vocabulary.md`, …) are editable *source inputs* that `init-voice` distills into it — do not inject them individually. `feedback.md` collects overlay 👍/👎; `init-voice` folds the corrections back in on regeneration. The backend's `voiceProfile.ts` allowlist controls which files load. Everything here stays on the user's machine.

## Conventions

- **ESM throughout the backend** — relative imports use `.js` extensions (`./config.js`) even though sources are `.ts`. Match this.
- **TypeScript strict.** Express handlers cast the tenant via the `tenant(req)` helper (`RequestWithTenant`).
- Keep code style matching the surrounding files — these are heavily commented with *why* (rationale, security tradeoffs, migration gating). When you touch tenant-scoping, the trust boundary, or DB migrations, preserve and update those comments.

## Local-only / gitignored (don't expect in a fresh clone)

`voice_profile/*`, `backend/.env`, `backend/data/` (SQLite + `gemini_workspace/` sandbox + snapshots). The sandbox and DB are rebuilt on boot; the voice profile is not — a fresh clone needs `npm run setup` + `npm run init-voice` (or a hand-written `strategy_analysis.md`) before the backend will start in local mode.
