# Comms Assistant — LinkedIn MVP

Chrome extension that extracts conversational context from LinkedIn messaging and POSTs it to a local backend. The backend runs your `gemini` CLI as a child process, prompting it with the conversation + your `voice_profile/` so suggested replies sound like you.

## Prerequisites

- Node 18+
- `gemini` CLI on PATH, signed in (run it once interactively first to complete auth)

## Layout

- `extension/` — MV3 Chrome extension (TypeScript + Vite + React popup)
- `backend/` — local Node + Express server (`POST /analyze` → gemini)

## Run

In two terminals:

```bash
# terminal 1
cd backend
npm install
npm run dev      # listens on http://localhost:8000
```

```bash
# terminal 2
cd extension
npm install
npm run build    # outputs to extension/dist
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `extension/dist`
4. Open `https://www.linkedin.com/messaging/`, pick a thread
5. Click the extension icon
6. **First-time setup**: enter your LinkedIn display name in the popup (used to mark which messages are yours) → Save
7. Click **Suggest a reply**

`npm run dev` in the extension folder runs Vite in watch mode if you want hot rebuilds — the unpacked extension reloads on its own.

## Icons

No icons are shipped. Chrome uses a default puzzle-piece icon. To add your own, drop `16.png`, `48.png`, `128.png` into `extension/public/icons/` and add an `"icons"` block to `extension/manifest.json`.

## What this MVP does

- Detects LinkedIn messaging pages.
- On the popup's **Suggest a reply** button: auto-scrolls the message list to load older messages (capped, jittered, max ~8s), reads the rendered DOM, extracts `{conversation_title, participants, messages[], current_draft, page_metadata}`, POSTs to `http://localhost:8000/analyze`.
- Backend loads `voice_profile/*.md` once at startup, builds a prompt (voice profile + conversation transcript + draft if any), pipes it to `gemini` on stdin, returns the model's reply as `suggested_reply`.
- If you've started typing a reply, the model is asked to **continue/rewrite your draft** instead of starting from scratch.
- A passive `MutationObserver` scoped to the message list also re-extracts on DOM changes and caches the latest context in the service worker (no backend POST on observer fires).
- SPA route changes are detected by hooking `history.pushState/replaceState` — no document-wide observer.

## What it explicitly does not do (yet)

- No vector DB / persistent memory across conversations
- No WhatsApp / Gmail / X extractors
- No auto-sending replies
- No group thread participant resolution

## Key files when something breaks

- `extension/src/content/selectors.ts` — every LinkedIn DOM selector lives here. Fix breakage here first.
- `extension/src/content/linkedin.ts` — extractor, scroll backfill, observer wiring, `isSelf` resolution.
- `extension/src/background/index.ts` — message router; only place that talks to the backend.
- `backend/src/prompt.ts` — prompt assembly. Tune wording, recency window, etc. here.
- `backend/src/gemini.ts` — `gemini` subprocess wrapper. Swap models via `GEMINI_BIN` env or extra CLI args.
- `voice_profile/*.md` — edit your style; backend re-reads on restart.
