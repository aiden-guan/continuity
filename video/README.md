# Continuity demo video

The submission video is generated from a real run of the system. No part of it is mocked.

1. **Record** (`npm run record`). Boots the Continuity stage (the engine plus real agent processes), opens the site in
   Chrome, lets the landing hero play, then presses → through all eight beats of the live presenter view. Every
   repaint comes from Chrome's DevTools screencast and is encoded to 1080p/30 in `public/recording/`, alongside
   `timeline.json`, which marks when each beat started and finished.
2. **Narrate** (`npm run narrate`). Speaks each line of `src/script.json` into `public/voice/`. It uses ElevenLabs
   when `ELEVENLABS_API_KEY` is set (optionally `ELEVENLABS_VOICE_ID`), otherwise OpenAI when `OPENAI_API_KEY` is
   set, otherwise the built-in macOS voice (`SAY_VOICE=…`). Keys are loaded from `../.env`.
3. **Edit and render** (`npm run render`). Remotion assembles the cut from `src/plan.ts`. Each beat keeps its real
   footage, sped up only as much as needed to match its narration, so the "Claude is working" waits get shorter but
   are never removed. The result is `out/continuity-demo.mp4`.

```bash
npm install
npm run make                          # record → narrate → render (Claude agents if ANTHROPIC_API_KEY is in ../.env)
RECORD_FLAGS=--offline npm run make   # rule extractor + policy agents: quick and deterministic
npm run dev                           # Remotion Studio for adjusting timing and text
```

To change the wording, edit `src/script.json` and run `npm run narrate && npm run render`. You don't need to record
again.
