# Privacy Policy — Comms Assistant

_Last updated: 2026-06-03_

Comms Assistant is built to be private by design. Here is exactly what it does
and does not do with your data.

## The short version

- **Everything runs on your own machine.** The extension talks only to a
  backend you run locally at `http://localhost:8000`. There is no Comms
  Assistant server, account, or cloud.
- **We collect nothing.** No analytics, no telemetry, no tracking, no
  third-party data sharing.
- **Your data stays with you** — your LinkedIn conversations, your contact
  notes, and your writing-style profile never leave your computer, except for
  the AI call you yourself configure (see below).

## What the extension reads

When you have a LinkedIn messaging thread open and ask for a suggestion, the
extension reads the **visible conversation** (messages, your draft, the thread
title) and, optionally, the **public profile** of the person you're talking to.
This is sent to your local backend to generate a reply.

## Where data goes

- **To your local backend** (`localhost:8000`) — on your machine.
- **To the AI provider you choose** — if you configure an external provider
  (e.g. OpenAI, OpenRouter), the conversation text is sent to that provider's
  API to generate the reply, governed by *their* privacy policy. If you use the
  local `gemini` CLI or a local model (Ollama, LM Studio), nothing leaves your
  machine at all.

## What is stored, and where

All local, on your computer only:

- **Voice profile** (`voice_profile/`) — your writing-style notes.
- **Contact memory** (`backend/data/memory.sqlite`) — notes you confirm and
  basic profile facts about contacts.
- **Settings** (browser storage) — your display name, overlay position, etc.

Nothing here is transmitted to us or any third party. You can delete any of it
at any time by removing the files.

## Permissions

- **`activeTab` / host access to `linkedin.com`** — to read the open
  conversation so it can be summarised for a reply.
- **host access to `localhost:8000`** — to talk to your local backend.
- **`storage`** — to remember your settings on your device.
- **`scripting`** — to show the assistant panel on the page.

## Contact

This is an open-source project. Questions or concerns: open an issue on the
GitHub repository.
