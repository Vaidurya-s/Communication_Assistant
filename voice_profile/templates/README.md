# voice_profile/templates/

The single canonical file the backend reads is
`voice_profile/strategy_analysis.md`. That file is gitignored (your voice
distillation is personal data), so a fresh clone of this repo arrives with
the directory empty.

To set it up:

1. Copy the template into place:

   ```sh
   cp voice_profile/templates/strategy_analysis.md.template \
      voice_profile/strategy_analysis.md
   ```

2. Open `voice_profile/strategy_analysis.md` and replace the placeholder
   sections with your own distillation of how you write — opening moves,
   sentence rhythm, vocabulary you avoid, how you decline things, etc.
   The template's section headers are starting suggestions, not a contract.

3. Boot the backend. If the file is missing or empty, the backend refuses
   to start with a pointer back to this README.

## Optional source files

You may keep companion files in `voice_profile/` while you work
(`boundaries.md`, `tone.md`, `writing_patterns.md`, `vocabulary.md`,
`registers.md`, `examples.md`, raw chat corpus). The backend does **not**
inject these — they are editable sources that you periodically compile down
into `strategy_analysis.md`. Keeping the runtime profile single-file avoids
prompt bloat and trust-boundary confusion.

The companion files are also gitignored; templates for them are not
shipped because their structure depends entirely on how you work.

## Raw corpus

`voice_profile/linkedin_successful_messages.md` (a corpus of your real past
messages) is the one other file the system uses, but only when the
`gemini-cli` provider is selected — it copies the file into an isolated
workspace and lets gemini grep it on demand. The openai-compat provider
cannot use tools and ignores it. Allowlist is at the top of
`backend/src/workspace.ts`.
