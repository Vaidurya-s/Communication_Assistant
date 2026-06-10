# Roadmap: hosting Comms Assistant online (multi-tenant + multi-platform)

> **Status: design only.** Nothing in this document is built yet. It turns the
> known seams in the current single-user/local codebase into a sequenced,
> executable plan. Today the tool is deliberately local: one Node/Express
> backend on `127.0.0.1:8000`, one SQLite file, one canonical voice profile,
> a LinkedIn-only extension, and no authentication.

The goal is to offer Comms Assistant as a hosted web service — each customer
gets isolated data and secrets — and to extend it beyond LinkedIn (Gmail first).
This is a large effort; the phases below are ordered so each one is shippable
and de-risks the next.

---

## Where we are today (the seams)

| Concern | Current state | File(s) |
|---|---|---|
| Storage | One SQLite file, no tenant column | `backend/src/db.ts` (`DB_PATH = data/memory.sqlite`) |
| Memory queries | Keyed by contact name only | `backend/src/memory.ts` |
| Voice profile | One global `strategy_analysis.md`, cached in memory | `backend/src/voiceProfile.ts`, `server.ts` (`getVoice`) |
| LLM keys | `backend/.env`, one provider for the whole process | `backend/src/config.ts`, `llm/index.ts` |
| Auth | None — anyone who can reach the port has full access | `backend/src/server.ts` |
| Backend address | Hardcoded in the extension | `extension/src/shared/messages.ts` (`BACKEND_URL`) |
| Platform | LinkedIn-only extraction, hardcoded route checks + manifest match | `extension/src/content/{linkedin,profile,selectors,index}.ts`, `manifest.json` |

The good news: `ConversationContext` already carries a `platform` field, and the
notes layer already has a provenance model — so the data shapes are friendlier to
this evolution than the runtime is.

---

## Phase H1 — Tenancy data model

Introduce a tenant (a.k.a. account/user) as the unit of isolation, **before** any
network exposure, so every later phase is built on isolated data.

- Add `tenant_id TEXT NOT NULL DEFAULT 'local'` to `contacts`, `notes`, and
  `strategy_log` using the existing `ensureColumn()` migration pattern in
  `backend/src/db.ts`. The `'local'` default keeps every current install working
  as a single implicit tenant.
- Make `contacts` keyed by `(tenant_id, name)` instead of `name` alone (collisions
  across tenants are expected). This is the one non-trivial migration — a table
  rebuild — so gate it behind a schema-version check.
- Thread `tenantId` through **every** function in `backend/src/memory.ts`
  (`getAllContacts`, `getContact`, `getNotesFor`, `addNote`, `upsertProfile`, …) and
  every `WHERE`/`INSERT`. This is the bulk of the work and the highest-risk surface
  — a missed clause leaks one tenant's data into another's.
- Per-tenant voice profile + feedback: today `voiceProfile.ts` loads one file and
  `server.ts` caches it in a single `cachedVoice`. Replace with a per-tenant
  loader (DB rows or `tenants/<id>/voice_profile/…`) and a keyed cache
  (`Map<tenantId, string>`).
- Per-tenant snapshots and gemini workspace (`backend/src/snapshots.ts`,
  `workspace.ts`) — currently global `data/` paths.

**Exit criteria:** all reads/writes scoped by `tenant_id`; the existing local
install transparently runs as tenant `'local'`; a second tenant's data is
invisible to the first in tests.

---

## Phase H2 — Authentication & tenant resolution

Only after data is isolated do we expose it.

- Add `/auth/*` (signup/login) and session or JWT middleware in
  `backend/src/server.ts`. The natural insertion point is immediately after
  `express.json(...)` and **before** the `/memory`, `/analyze`, and `/config`
  routes, so every handler runs with an authenticated `req.tenantId`.
- A `tenantResolver` middleware: validate the token → set `req.tenantId` → load
  that tenant's voice profile into the keyed cache. Reject unauthenticated
  requests to all data routes (keep `/health` public).
- Replace the loopback bind + `cors({ origin: "*" })` (fine for local, unsafe
  hosted) with a real CORS allowlist and TLS termination at the edge.

**Exit criteria:** no data route is reachable without a valid session; the token's
tenant is the only data the request can touch.

---

## Phase H3 — Configurable backend URL & secret management

- The extension hardcodes `BACKEND_URL = "http://localhost:8000/analyze"`
  (`extension/src/shared/messages.ts`). Make the backend origin configurable in
  the popup and persist it in `chrome.storage` (with the local default preserved).
  The background worker (`extension/src/background/index.ts`) reads it instead of
  the constant, and attaches the auth token from H2.
- Per-tenant LLM keys move out of the single `backend/.env` (the Part-B model) into
  a secrets store (a `tenant_secrets` table encrypted at rest, or a managed secret
  manager). The provider factory in `llm/index.ts` builds a provider **per tenant**
  rather than caching one process-wide instance — the current `getProvider()`
  singleton becomes `getProviderFor(tenantId)`.
- Decide the LLM cost model: customer-supplied keys (BYO, cheapest to operate) vs.
  a platform key with per-tenant metering (simpler onboarding, needs H5).

**Exit criteria:** the extension points at a hosted backend with a token; each
tenant's LLM calls use that tenant's key/secret; no secret is ever returned to a
client in plaintext (extends the existing last-4 masking).

---

## Phase H4 — Platform-extractor abstraction (Gmail first)

Today extraction is LinkedIn-specific and spread across several files with
hardcoded route checks (`content/index.ts` `isLinkedInMessagingRoute`,
`background/index.ts` `tab.url.includes("linkedin.com")`) and a LinkedIn-only
`manifest.json` match. Introduce a small interface so platforms plug in:

```ts
interface PlatformExtractor {
  isOnPage(loc: Location): boolean;
  extractConversation(): Promise<ConversationContext>;
  extractProfile?(url: string): Promise<ContactProfile | null>;
  observeChanges?(onChange: () => void): MutationObserver | null;
}
```

- Move the current LinkedIn logic behind a `linkedinExtractor` implementing this
  interface (no behaviour change — pure refactor of
  `content/{linkedin,profile,selectors}.ts`).
- A registry `Record<Platform, PlatformExtractor>` that `content/index.ts`
  dispatches to via the existing `detector.ts`. `ConversationContext.platform`
  already exists, so the backend prompt path (`backend/src/prompt.ts`) needs only
  minor per-platform tone rules, not restructuring.
- **Gmail first** (`mail.google.com`): threaded conversations, a real composer to
  read the draft from, and contacts to enrich against — it reuses the most of the
  existing reply/voice/memory model. Add the host to `manifest.json` content-script
  matches and implement `gmailExtractor`. Profile enrichment differs (Google
  Contacts / the email's sender card rather than a LinkedIn profile page), so
  `extractProfile` is optional per platform.
- Later platforms (WhatsApp Web, X DMs) implement the same interface; WhatsApp has
  no profile pages and a fast-moving DOM, so it's deliberately *after* Gmail.

**Exit criteria:** LinkedIn behaviour is unchanged through the new interface; a
Gmail thread produces a voice-matched draft through the same backend.

---

## Phase H5 — Cost, abuse, and ops

- Per-tenant LLM cost allocation + rate limiting (needed if H3 uses a platform key).
- Usage metering and quotas; abuse detection on the public endpoints.
- The prompt-injection trust boundary is **unchanged and still essential**:
  conversation and profile text stay fenced as untrusted data
  (`<UNTRUSTED_CONVERSATION>` in `backend/src/prompt.ts`); only the voice profile,
  user-confirmed memory, and the user's own steer act as instructions. Multi-tenancy
  does not relax this — it raises the stakes.
- Backups and per-tenant export/delete (GDPR-style data portability and erasure).

---

## Sequencing rationale

1. **H1 before everything** — isolating data on a still-local install is the
   safest place to get the hardest part (per-tenant scoping of every query) right.
2. **H2 before exposure** — never open a port to data that isn't yet scoped.
3. **H3** makes the client and secrets hosted-ready once the server is safe.
4. **H4 is independent** of H1–H3 and can proceed in parallel — it's an
   extension-side refactor plus Gmail, with no dependency on tenancy. It's listed
   last only because the hosted business case usually prioritises isolation first;
   if the immediate goal is "more platforms" rather than "hosted," do H4 first.
5. **H5** is continuous hardening, started once real traffic exists.
