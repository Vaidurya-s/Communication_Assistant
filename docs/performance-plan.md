# LLM latency & "keep it primed" — performance plan

**Status:** Phases A–E shipped. Phase A (decouple insight), B (native Anthropic
provider + caching, `staticPrefix`/`variable` split), C (SSE streaming + overlay
Port relay), D (cache warm-up: `buildStaticPrefix` + `provider.warm` + `/warm` +
boot/overlay prewarm), and E (speculative prefetch behind `COMMS_PREFETCH`, off by
default) are all in. **Deferred:** §3c gemini-cli plan-mode drop — needs the mode
plumbed to the provider plus gemini-CLI flag semantics that can't be verified
without risking the working free fallback. Live token-streaming / caching / prefetch
only activate with an HTTP provider key (the default gemini-cli has no streaming or
cache, so those paths fall back gracefully to a single JSON batch).
**Decisions captured (2026-06-17):** fast HTTP API the default for drafting, with
prompt caching on the static voice prefix + streaming to the overlay; keep
`gemini-cli` as the free/offline fallback. All four latency fixes are in scope:
(1) don't block the reply on insight, (2) stream the reply, (3) warm-up call,
(4) speculative prefetch on thread open.

Pairs with `CLAUDE.md` (architecture) and `voice-onboarding-plan.md` (the
"compile to a lean single file" work, which directly shrinks the cached prefix).

---

## 1. Diagnosis — why it's slow today

Every `/analyze` does this, and it's the worst case for latency:

1. **`gemini-cli` is an agentic CLI, not a model endpoint.** `gemini-cli.ts`
   spawns a fresh `gemini` subprocess **through a shell** with
   `--approval-mode plan`, so each draft boots a whole agent runtime, authenticates,
   and runs an **agentic planning loop** (it can Read/Grep tools). The ~30s we
   measured is mostly cold-start + agent overhead, not generation.
2. **Per call, ×2.** Reply + insight each spawn their own subprocess, competing
   for CPU/model.
3. **The response blocks on the *slower* of the two.** `server.ts` does
   `await Promise.allSettled([replyPromise, insightPromise])` before responding,
   so the user waits for insight even though it's "best-effort."
4. **The whole ~15 KB context is re-sent and re-processed every call** — nothing
   cached.

**"Keep it primed" can't be done with the CLI.** It's invoked one-shot
(`spawn → stdin → close`), stateless, with no session to prime and no
context-cache support. *Primed = prompt caching, which lives on the HTTP APIs.*
So the fix is: move drafting onto an HTTP provider (`openai-compat.ts` already
exists), which removes the subprocess/agent cold-start **and** unlocks caching +
streaming.

---

## 2. Prompt caching mechanics (grounded)

The cached thing here is the **static voice profile** sitting in front of a small,
variable conversation — the ideal caching shape. Key rules (Anthropic Messages API):

- **Prefix match.** Any byte change anywhere in the prefix invalidates everything
  after it. Render order is `tools → system → messages`. **Stable content first
  (voice profile), volatile last (mode instruction, steer, conversation).**
- **`cache_control: {type: "ephemeral"}`** marks a breakpoint — **5-minute TTL**;
  `{type: "ephemeral", ttl: "1h"}` for an hour. Max **4 breakpoints** per request.
- **Minimum cacheable prefix is model-dependent** — below it, nothing caches (no
  error, just `cache_creation_input_tokens: 0`):
  - Opus 4.8 / Haiku 4.5: **4096 tokens**
  - Sonnet 4.6: **2048 tokens**
- **Economics:** cache reads ≈ 0.1× input price; writes 1.25× (5-min) / 2× (1h).
  Break-even at ~2 requests for the 5-min TTL.
- **Verify** with `usage.cache_read_input_tokens` — if it stays 0 across identical
  prefixes, a silent invalidator is at work (a timestamp/UUID in the prefix,
  non-deterministic JSON ordering, a varying tool list).

### ⚠️ The two caveats that shape the design

1. **Caching is a *native* Messages-API feature.** `cache_control` is **not** part
   of the OpenAI `/chat/completions` shape, so it **cannot** be sent through the
   current `openai-compat.ts` shim. To cache with Claude we need a **native
   Anthropic provider** (the `@anthropic-ai/sdk`). The three real caching paths:
   - **Anthropic native** — explicit `cache_control` on the voice block. Cleanest
     realization of "keep the voice primed." *(needs a new provider)*
   - **OpenAI** — **automatic** prefix caching for prompts ≥ ~1024 tokens; no code,
     but requires static-first ordering. Works through `openai-compat.ts`.
   - **Gemini API** — explicit context caching (upload once, reference by handle);
     a Gemini-native feature, **not** reachable through the OpenAI-compat shim.
2. **Our voice profile is ~3.7K tokens** (14,743 chars ≈ 3.5–4 chars/token) —
   **below Haiku 4.5's 4096-token minimum.** So on Haiku the profile alone may
   **silently not cache**. Mitigations (pick per phase): (a) include the standing
   instructions + corpus pointers in the same cached prefix to push it over 4096,
   (b) use **Sonnet 4.6** (2048 min) where caching is guaranteed, or (c) accept
   that caching only kicks in once the profile/context grows. The
   voice-onboarding "ABOUT ME" context layer pushes the prefix up naturally.

### Prompt restructuring this requires
`buildPrompt()` currently returns one `context` blob (voice + memory +
conversation concatenated) and an `instruction`. For caching we must **separate
the static prefix from the variable remainder** so a provider can place a
breakpoint between them:

```
context → { staticPrefix: <voice profile (+ standing instructions)>,
            variable:     <memory + ABOUT ME + UNTRUSTED_CONVERSATION + mode + steer> }
```

- **Anthropic provider:** `staticPrefix` → a `system` block with `cache_control`;
  `variable` → the user message. Mode instruction goes *after* the breakpoint.
- **OpenAI provider:** put `staticPrefix` **first** in the prompt and keep it
  byte-stable so OpenAI's automatic prefix cache hits.

---

## 3. Provider work

### 3a. New native Anthropic provider (`backend/src/llm/anthropic.ts`)
- Uses `@anthropic-ai/sdk` `messages.stream()` / `messages.create()`.
- Voice profile in a `system` block with `cache_control: {type: "ephemeral"}`;
  conversation in `messages`. Mode instruction after the cached block.
- Default drafting model **`claude-haiku-4-5`** (fast, cheap, 64K output) — or
  **`claude-sonnet-4-6`** when guaranteed caching + a quality bump is wanted (see
  the min-token caveat). No `effort`/thinking for short drafts (Haiku rejects
  `effort`; drafts don't need thinking).
- Streaming supported (Phase B).
- Slots into the existing `LLMProvider` interface and the **per-tenant provider**
  resolution already in `llm/index.ts` (`getProviderFor`) — H3 per-tenant encrypted
  keys already exist, so an Anthropic key per tenant is "free" infra-wise.

### 3b. `openai-compat.ts` — streaming + caching-friendly ordering
- Add `stream: true` support (parse SSE `choices[].delta.content`).
- Send `staticPrefix` first and byte-stable so OpenAI **automatic** caching hits.
  (No explicit cache API on this path.)

### 3c. `gemini-cli.ts` — make the fallback less slow
- Drop `--approval-mode plan` for non-tool modes (suggest/shorter/follow_up/
  cold_open) so it isn't running the agentic loop; keep the tool path only for the
  "longer" mode that actually greps the corpus.
- Keep it as the **free/offline default fallback**; it can't be primed.

### Config (`config.ts` / `.env`)
- New provider value `anthropic`; `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
  (default `claude-haiku-4-5`).
- `COMMS_STREAM` (default on for HTTP providers), `COMMS_PREFETCH` (default off).
- Dashboard Settings gains an "Anthropic (cached)" preset (presets.ts).

---

## 4. The four latency fixes

### Fix A — don't block the reply on insight *(do first; provider-independent)*
- Return the draft as soon as `replyPromise` resolves. Run insight in the
  background; persist memory/strategy when it lands.
- **Contract change:** the overlay currently gets `memory_proposal` + `strategy` in
  the same response. Deliver them as a **second event** (fits the streaming work in
  Fix B: stream reply tokens, then emit an `insight` event), or — interim — a small
  `GET /analyze/insight?id=` the overlay polls once. Pure latency win when insight
  is the slower call.

### Fix B — stream the reply to the overlay
- **Backend:** `/analyze` supports SSE (`Accept: text/event-stream`); provider
  streams tokens. Event shape:
  `token` (reply delta) → `reply_done` (full text + stats) → `insight`
  (memory_proposal + strategy) → `done` / `error`.
- **Extension transport:** `chrome.runtime` messaging is request/response — for a
  token stream, open a long-lived **`chrome.runtime.connect` Port**: background
  fetches the SSE stream and relays chunks over the Port to the overlay.
- **Overlay:** render the preview incrementally as `token` events arrive; apply
  `insight` when it comes. Perceived latency collapses even when total time is
  similar.

### Fix C — warm-up call (kill cold start)
- On backend boot and when the overlay opens, fire a tiny warm-up to the configured
  provider. For **Anthropic caching specifically**, the canonical warm-up is a
  **`max_tokens: 0`** request with the voice profile + `cache_control` — it runs
  prefill (writes the cache) and returns immediately, so the first *real* draft is
  a cache **read**. (Rejected with `stream:true`/thinking — send it non-streaming.)
- Re-warm under the 5-min TTL only if traffic has gaps; continuous use keeps it warm.

### Fix D — speculative prefetch on thread open
- When a thread opens (content script extracts), background pre-fires a `suggest`
  draft keyed by `(threadUrl, messageCount, draftLen)`. On click, return the cached
  draft if the key still matches; invalidate on new message / draft change.
- Guarded: prefetch **once per thread state**, and only when a fast HTTP provider is
  active (don't prefetch onto the slow CLI). Trades tokens for instant response —
  `COMMS_PREFETCH` off by default; document the cost.

---

## 5. Model recommendation (drafting)

| Model | Why | Caching | Notes |
|------|-----|---------|-------|
| **`claude-haiku-4-5`** (recommended reply model) | Fastest + cheapest Claude ($1/$5 per MTok), 64K output | 4096-token min — our ~3.7K profile may not cache until the prefix grows | No `effort`/thinking; ideal for short drafts |
| **`claude-sonnet-4-6`** | Quality bump, still fast | 2048-token min — **caches our profile reliably** | Use when caching ROI matters more than raw speed |
| Gemini Flash / `gpt-4o-mini` (via openai-compat) | Fast, cheap, no Anthropic key | OpenAI auto-cache (Flash needs native API for explicit cache) | Good free-API alternatives |
| `gemini-cli` | Free, offline, no key | none (can't prime) | Fallback only; drop plan-mode |

Insight (the secondary call) can stay on a cheaper/slower path since it's now
off the user's critical path (Fix A).

---

## 6. Phased roadmap (each ships value)

### Phase A — decouple insight (fastest win, no new dependency)
- Return reply immediately; persist insight in the background; deliver insight as a
  follow-up (interim poll or, once Phase B lands, a stream event).
- **Done when:** reply latency no longer includes the insight call's time.

### Phase B — fast HTTP provider + caching
- `buildPrompt()` splits `staticPrefix` / `variable`.
- New `anthropic.ts` provider with `cache_control` on the voice block; Settings
  preset + `.env` keys. `openai-compat.ts` reordered for auto-caching.
- `gemini-cli.ts` plan-mode dropped for non-tool modes; stays the fallback.
- **Done when:** with an Anthropic key, a second draft on the same thread shows
  `cache_read_input_tokens > 0` and drafts return in ~1–3s.

### Phase C — streaming reply
- SSE from `/analyze`; provider streaming; background Port relay; overlay
  incremental render; `insight` delivered as a stream event (completes Fix A).
- **Done when:** tokens appear in the overlay as they generate.

### Phase D — warm-up
- Boot/overlay-open warm-up; `max_tokens: 0` cache-prewarm for the Anthropic path.
- **Done when:** the first draft after a cold start is a cache read, not a cold write.

### Phase E — speculative prefetch
- Prefetch a `suggest` on thread open behind `COMMS_PREFETCH`; cache-key invalidation.
- **Done when:** clicking Suggest on a freshly-opened thread is near-instant (cache hit).

---

## 7. Constraints & risks
- **Cost vs. free.** `gemini-cli` is free but slow and un-primable; HTTP APIs are
  fast/cacheable but need a key (usually paid). Keep the CLI as the default fallback;
  speed is opt-in by configuring a key — infra already supports it (openai-compat,
  dashboard switcher, per-tenant encrypted keys).
- **Caching is native-API only.** Don't expect `cache_control` to work through the
  OpenAI shim — that's why Phase B adds a real Anthropic provider.
- **Min-token caveat.** A short voice profile may not cache on Haiku 4.5; use Sonnet
  4.6 or let the context layer grow the prefix. Always verify with
  `cache_read_input_tokens`, never assume.
- **Prefetch cost.** Speculative drafts spend tokens the user may never use — off by
  default, `log()` what's spent.
- **Trust boundary unchanged.** Splitting static/variable doesn't move profile/
  conversation across the `<UNTRUSTED_CONVERSATION>` boundary; the voice profile
  stays the trusted, cached prefix and the conversation stays untrusted.
- **Multi-tenant.** New provider resolves per tenant via the existing
  `getProviderFor` path; warm-up and prefetch are per-tenant.

---

## 8. Touch map
- Backend: `llm/anthropic.ts` (new), `llm/openai-compat.ts` (streaming + ordering),
  `llm/gemini-cli.ts` (drop plan mode), `llm/index.ts` + `llm/types.ts` (streaming in
  the interface), `prompt.ts` (static/variable split), `server.ts` (SSE `/analyze`,
  decouple insight, warm-up, prefetch), `config.ts` + `presets.ts` + `.env.example`.
- Extension: `background/index.ts` (SSE fetch + Port relay, prefetch cache),
  `shared/messages.ts` (stream/port message types), `overlay/Overlay.tsx`
  (incremental render, insight-as-second-event).
