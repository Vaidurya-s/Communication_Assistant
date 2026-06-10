# Comms Assistant

**Reply on LinkedIn in your own voice — without staring at a blank box.**

Comms Assistant is a Chrome extension paired with a small local server that reads the LinkedIn conversation you're looking at, understands who you're talking to, and drafts a reply that actually sounds like *you*. Everything runs on your own machine. Your messages, your contacts, and your writing style never leave your computer.

It's built for people who send a lot of LinkedIn messages — recruiters, founders, job seekers, networkers — and want a thoughtful first draft in seconds instead of a generic template.

---

## Why it's different

- **It writes like you, not like a robot.** You give it a short profile of your own writing style, and every suggestion is matched to that voice.
- **It remembers people.** Notes you confirm about a contact — and the details from their LinkedIn profile — are saved locally and used to make future replies sharper.
- **It stays private by design.** No cloud account, no data collection. The AI runs through your own local setup, and your conversation history is yours alone.
- **It's safe against trickery.** Message content and profile text are treated as untrusted, so a contact can't sneak hidden instructions into a reply.

---

## Features

- **One-click reply suggestions** in a floating, draggable panel that sits right on top of LinkedIn.
- **Four reply modes** — Suggest a fresh reply, write a Follow-up to revive a quiet thread, or make the current draft Shorter or Longer.
- **Keyboard shortcuts** — `Alt+S` Suggest, `Alt+F` Follow-up, `Alt+H` Shorter, `Alt+L` Longer, `Alt+C` Copy.
- **Contact memory** — confirm a fact about someone with one click; it's remembered next time.
- **Profile enrichment** — automatically reads a contact's role, company, and background to ground each reply.
- **Follow-up reminders** — when a conversation suggests "check back in a few days," you get a gentle nudge you can copy into your calendar.
- **Bring your own AI** — use the local `gemini` CLI, or point it at any OpenAI-compatible service (OpenAI, OpenRouter, Ollama, LM Studio, and more).
- **Copy, never auto-send** — you always review and edit before anything is sent.

---

## Getting started

**You'll need:** [Node.js](https://nodejs.org) 18 or newer, Google Chrome, and one AI option — either the `gemini` CLI signed in on your machine, or an API key for an OpenAI-compatible service.

### 1. Set up your writing voice

The assistant needs a short description of how you write.

```bash
cp voice_profile/templates/strategy_analysis.md.template voice_profile/strategy_analysis.md
```

Open that new file and fill in the sections — how you open messages, words you avoid, how you decline things. (The backend won't start until this exists, so you can't forget.)

### 2. Start the local server

```bash
cd backend
npm install
npm run dev          # runs at http://localhost:8000
```

To use an OpenAI-compatible service instead of the `gemini` CLI, copy `backend/.env.example` to `backend/.env` and add your provider details.

### 3. Build and load the extension

```bash
cd extension
npm install
npm run build        # outputs to extension/dist
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and select the `extension/dist` folder

### 4. Use it

1. Open `https://www.linkedin.com/messaging/` and pick a conversation.
2. The Comms Assistant panel appears on the page.
3. **First time only:** click the extension icon and enter your LinkedIn display name (so it knows which messages are yours).
4. Click **Suggest** — your draft appears in seconds. Edit it, click **Copy**, and paste into LinkedIn.

---

## On the roadmap

- Support for more platforms — WhatsApp, Gmail, and others.
- Optional one-click calendar and task reminders for follow-ups.
- Smarter memory that learns patterns across all your conversations.
- A guided first-run setup so getting started is even quicker.

---

## Contributing & feedback

This is an active project, and thoughtful input is always welcome — whether it's a bug report, a feature idea, or a pull request. If something feels confusing or could work better, that's exactly the kind of feedback that helps most. Open an issue or start a discussion, and let's make replying on LinkedIn feel effortless.
