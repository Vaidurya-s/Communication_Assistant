# Setup guide

Everything you need to go from a fresh clone to a working assistant. Takes
about 5–10 minutes.

> **Stack note:** this is a Node.js project (not Python), so there's no
> `requirements.txt` or `venv`. The equivalent is `package.json` +
> `npm install`, and the `npm run setup` command below wraps all of it into one
> step.

---

## 1. Prerequisites

You need three things:

- **[Node.js](https://nodejs.org) 18 or newer** — check with `node --version`.
- **Google Chrome** (or any Chromium browser that loads unpacked extensions).
- **One AI option** — either:
  - the **`gemini` CLI** installed and signed in (run it once interactively to
    complete login), **or**
  - an **API key** for any OpenAI-compatible service (OpenAI, OpenRouter, or a
    local server like Ollama / LM Studio).

---

## 2. One-command setup

From the project root:

```bash
npm run setup
```

This installs the backend and extension dependencies, builds the extension, and
scaffolds the local files you'll fill in. It's safe to re-run — it never
overwrites anything you've already edited. When it finishes it prints your next
steps; the rest of this guide is the detailed version.

---

## 3. Choose your AI

Open **`backend/.env`** (created for you by setup) and pick a provider.

### Option A — local `gemini` CLI (default, no key)

Leave it as is:

```ini
LLM_PROVIDER=gemini-cli
```

Nothing else to do, as long as `gemini` is installed and signed in. This is the
only option that can also grep your raw message corpus on demand.

### Option B — any OpenAI-compatible API

```ini
LLM_PROVIDER=openai-compat
OPENAI_BASE_URL=https://api.openai.com/v1      # or your provider's URL
OPENAI_API_KEY=sk-...                          # your key goes here
OPENAI_MODEL=gpt-4o-mini
```

Common `OPENAI_BASE_URL` values:

| Provider | Base URL | Key needed? |
|----------|----------|-------------|
| OpenAI | `https://api.openai.com/v1` | yes |
| OpenRouter | `https://openrouter.ai/api/v1` | yes |
| Ollama (local) | `http://localhost:11434/v1` | any non-empty string |
| LM Studio (local) | `http://localhost:1234/v1` | any non-empty string |

**Where keys live:** only in `backend/.env`, which is gitignored. They never
get committed, and with `gemini-cli` or a local Ollama/LM Studio, nothing leaves
your machine at all.

---

## 4. Teach it your voice

This is the most important step — it's what makes replies sound like *you*
instead of a generic bot. The assistant reads a single file,
`voice_profile/strategy_analysis.md`. You can create it two ways.

### Easiest — distill it from your real messages

1. Gather a sample of messages **you have written**: exported LinkedIn DMs, a
   few sent emails, Slack messages — anything in your natural voice. The more
   varied, the better (20–100 messages is plenty).
2. Save them as plain-text or Markdown files in **`voice_profile/raw_corpus/`**
   (created for you by setup).
3. Run:

   ```bash
   npm run init-voice
   ```

   This uses your configured AI to analyse the samples and write a first draft
   of `strategy_analysis.md` for you. Open it, fix anything that feels off, and
   you're done. (If the file already exists, it writes
   `strategy_analysis.draft.md` instead so nothing is clobbered.)

### Or — write it by hand

`setup` pre-fills `voice_profile/strategy_analysis.md` from a template. Open it
and replace the placeholder sections (how you open messages, words you avoid,
how you decline things, etc.) with your own notes.

> The backend **refuses to start** until this file exists and is non-empty —
> that's intentional, so you never get bad replies from an empty profile.

Everything under `voice_profile/` is gitignored — your writing style and raw
messages stay on your machine.

---

## 5. Start the backend

```bash
npm start
```

It runs at `http://localhost:8000`. Leave it running. Sanity check in another
terminal:

```bash
curl http://localhost:8000/health
# {"ok":true,"voiceProfileChars":<N>,"provider":"gemini-cli"}
```

---

## 6. Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and select the **`extension/dist`** folder

(If you change extension source later, rebuild with `npm run build:extension`
and hit the reload icon on the extension card.)

---

## 7. First run

1. Open `https://www.linkedin.com/messaging/` and pick a conversation.
2. The Comms Assistant panel appears on the page.
3. **First time only:** click the extension's toolbar icon and enter your
   LinkedIn display name (so it knows which messages are yours).
4. Click **Suggest** — your draft appears in a few seconds. Edit it, click
   **Copy**, and paste into LinkedIn.

---

## Command reference

Run these from the project root:

| Command | What it does |
|---------|--------------|
| `npm run setup` | Install deps, build extension, scaffold config |
| `npm start` | Start the backend (http://localhost:8000) |
| `npm run init-voice` | Draft your voice profile from `raw_corpus/` |
| `npm run build:extension` | Rebuild the extension after source changes |

---

## Troubleshooting

- **Backend won't start, complains about the voice profile** — you skipped
  step 4. Create `voice_profile/strategy_analysis.md` (template or
  `init-voice`).
- **Overlay says "Backend offline"** — the backend isn't running, or isn't on
  `localhost:8000`. Start it with `npm start` and click **Retry**.
- **`init-voice` fails** — check `backend/.env`: with `openai-compat` you need a
  valid key and reachable `OPENAI_BASE_URL`; with `gemini-cli`, make sure
  `gemini` runs and is signed in.
- **Extension panel doesn't appear** — reload the LinkedIn tab after loading the
  extension; content scripts don't inject into tabs that were already open.
- **Replies don't sound like me** — improve `voice_profile/strategy_analysis.md`
  (more specific observations help), then restart the backend.
