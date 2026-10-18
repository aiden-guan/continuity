# Continuity — launch film

80 s · 1920×1080 · 60 fps · 120 BPM (one bar = 2 s = 120 frames). No voiceover: the type and the score carry it.
Every email, term, version number and token count on screen is real engine output from the PO-4817 run
(`site/assets/snapshot.json`, `eval/results/scale.json`).

```bash
cd video
npm run launch:score                  # synthesise the score + foley → public/launch/{score,music,foley}.wav
npm run launch:render                 # → out/continuity-launch.mp4 (1080p60, ~9 min on an M3 Pro)
npm run launch:stills -- 0,1200,2400  # contact sheet of chosen frames → out/stills/
npx remotion studio                   # scrub it: composition "Launch", scenes under "Launch-Scenes"
```

Code: `src/launch/` — `timing.ts` (the one clock: every scene's key frames, read by picture and sound),
`theme.ts` (site tokens + easing), `kit.tsx` (Rise, TrackBox, Slabs, Roll, Card…), `DotField.tsx` (the dot grid
that ripples on the big hits), `Hud.tsx`, `briefing.tsx`, and one file per scene in `scenes/`.

## The idea

**One unbroken line.** The brand mark is a thread with a live agent (filled square) and the next agent
(outlined square). The film is that line. It draws on in the first frame and never breaks: it becomes the
email timeline, the strikethrough through a superseded term, the leader lines of the extractor, the edge of the
state stack, and finally contracts back into the logo. Agents (squares) live and die on it; the line carries on.

Look: the site's datasheet system, nothing new. Warm paper, ink, one signal orange that only ever means
"something changed", green only for a passed check, Geist + Geist Mono, hairlines, `+` crop marks.
A persistent corner HUD (story clock, state version, running processes) ties the scenes together.

## References and what each one lends

| Reference | Technique borrowed | Where |
|---|---|---|
| @pitus_ — Generative UI #2 | Live UI on white that changes state in place (conflict → resolving → merged) | 07 Resolve, 10 Close |
| @amirdzm — fomo launch | 2×2 split of simultaneous moments; one-word kinetic type | 03 The deal doesn't wait |
| @AmirMushich — flash cut (human side) | 2–4-frame flash cuts locked to the beat, stacked rectangles, inverted frames | 02 SIGKILL |
| @Varcyyyy — Venmo | Pill wall of tokens, giant tracked numerals, a field collapsing into one mark | 04 Inbox, 11 Proof |
| @dakshpixelup — Replay | Datasheet frame, exploded layer stack with leader-line labels, inverted label blocks | 07 Resolve, HUD |
| @mnowakdesign — tracking test | Hatched tracking boxes + coordinate labels + linking lines over text | 06 Listen |
| Teenage Engineering product films | Paper + ink + one orange; engineering-diagram calm | whole film |
| Vercel Ship / Geist | Grid, crosshair marks, mono metadata | HUD, grid |
| Apple keynote films | Big tight sans, one idea per card, hard cuts on the downbeat | type system |

## Shot list

| # | Bars | Time | Scene | What happens |
|---|---|---|---|---|
| 01 | 0–3 | 0:00 | Mid-deal | Line draws on. Agent A rides it; ev_1–ev_3 drop as nodes with mini email cards. "Your agent is mid-deal." Push into A. |
| 02 | 3–5 | 0:06 | SIGKILL | `kill -9 48121`. Flash cuts on 16ths: inverted SIGKILL, sliced square, dither, exit 137. Dead stop. "Then it dies." |
| 03 | 5–8 | 0:10 | The deal doesn't wait | 2×2 split: finance approves (thread #2) · supplier's correction · PDF injection quarantined · "0 agents running". |
| 04 | 8–10 | 0:16 | An inbox | Agent B spawns with 0 messages in memory. Pill wall of subject lines. "so… where are we?" Pills rush into the line. |
| 05 | 10–12 | 0:20 | Continuity | Drop. Line contracts into the mark; wordmark rises. Push through the outlined square. |
| 06 | 12–16 | 0:24 | 01 Listen | ev_6 on paper. Hatched tracking boxes lock onto each phrase; leader lines carry keys out. "Every email becomes evidence." |
| 07 | 16–21 | 0:32 | 02 Resolve | State diff builds live: the line strikes through the old term, conflict lights, v28→v33. Tilts into an exploded stack. |
| 08 | 21–24 | 0:42 | 03 Brief | `GET /tasks/PO-4817/context` → briefing streams in, every line cited. "One call. The whole picture." |
| 09 | 24–28 | 0:48 | 04 Act | Agent B writes the right email; connectors tie each phrase to the state it came from. "Agent B never saw the conversation." |
| 10 | 28–32 | 0:56 | 05 Close | Rev 2 lands; checks flip ✕→✓ on the beat. Agent C drafts; held for a human; Sam approves. |
| 11 | 32–36 | 1:04 | 06 Results | 1,134 squares (2,769,083 tokens) collapse into one (2,442). 6/6 vs 5/6 vs 3/6. |
| 12 | 36–40 | 1:12 | Finale | The whole thread, three agents. "Agents forget. The thread doesn't." Line → logo. Built on Primitive. |

## Sound

`scripts/launch-score.mts` synthesises everything from the same cue sheet the picture uses (`src/launch/timing.ts`),
so every hit lands on its frame: a minimal 120 BPM electronic bed (sub kick, clock hats, FM plucks, a soft pad) that
cuts to silence at the kill and drops at the title, plus UI foley (ticks, clicks, whooshes) on every on-screen action.
To use a licensed track instead, mix it with `public/launch/foley.wav` (the sound-design stem) into
`public/launch/score.wav`, or set `SCORE_OUT` to write the stems somewhere else first.
