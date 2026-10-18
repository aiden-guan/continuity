# Demo walkthrough (2–3 minutes)

Setup: run `npm install`, open http://localhost:4100 next to the terminal, and choose one of these:

- **Live on Primitive (recommended):** `npm run demo:live -- --step`. Every email genuinely travels through Primitive.
  With Claude the run takes roughly 1.5 minutes; each beat holds until the mail is both delivered *and* interpreted.
  If the network or the API is slow on the day, add `--fast` to skip Claude (rule-based extraction and agents).
  Agent C's acceptance is held for a human; the script approves it at beat 9 with its own approver token.
- **Offline fallback:** `npm run demo -- --step`. The same story on the local mail simulator. It finishes in seconds and
  needs no keys.

Press Enter to move to the next beat.

---

**0:00 — The problem (20s).**
"Primitive gives an agent an inbox. But after a restart, all the inbox can tell the agent is *which messages exist*. It
can't say whether we're waiting on someone, whether we owe someone a reply, or whether the quote in hand still holds.
Continuity turns that mail into state."

**0:20 — The task (15s).** Point to the header: *Buy 500 AX-200 boards for PO-4817, all by Friday Oct 23, ≤ $11.50/unit.*
The badges show the transport (local simulation or live Primitive), the extractor in use, and whether webhook
signatures are being verified.

**0:35 — History (30s).** In the left column, top to bottom:
- Agent A sends the RFQ (thread #1) and a budget request (thread #2).
- The supplier offers *500 Friday at $11.40* with a quote PDF attached. The chips show terms pulled from the email
  **and** from the PDF, our questions marked **answered**, and the PDF's "note to automated assistants"
  **quarantined**.
- An unrelated promo email comes in and stays **unlinked** (similarity never merges anything).
- The agent-sessions panel shows agent-a choosing to wait for finance. **Then Agent A is killed.**

**1:05 — With nothing running (30s).**
- In the **other** thread, finance approves *up to $11.50*. The budget is recorded.
- The supplier corrects delivery: *300 Friday + 200 Wednesday Oct 28; I'll send a revised quote.*

In the middle column:
- **Conflicts:** "All units by Fri Oct 23 — 200 units arrive Wed Oct 28."
- **Superseded:** ~~500 units Fri Oct 23~~ → 300 + 200 (*explicit correction by supplier in ev_6*). Click
  `delivery.schedule` to bring up the chain of evidence.
- **Documents:** the quote is **partially stale**. Price, payment and validity remain current; only delivery is stale.
- **Open loops:** the supplier owes a revised quote, and the loop *closes only when a quote document arrives*.

**1:35 — Cold handoff (35s).** Click **agent-b** under Agent sessions:
- "A new process, pid ___, **prior messages in process memory: 0**. It was handed ~1.4k tokens of compiled state."
  Scroll through the briefing: next actor US, suggested actions, superseded terms, the do-not-re-ask list.
- The email it wrote is at the bottom. It names the late 200 units and the Oct 28 date, keeps the Friday requirement,
  doesn't ask about price again, and reminds the supplier about the revised quote.
- **"The agent that just sent that email never saw the original conversation."**

**2:10 — Closing the loop (20s).** The supplier expedites and attaches quote rev 2. The commitment flips to
**fulfilled**, v1 to **superseded**, and the conflict to **resolved**. **agent-c**, one more fresh process, accepts.
Point out the send guard: it refuses binding language as long as any requirement is failing.
Once every check passes, the acceptance still waits for a person: beat 9 prints the approval card and a named human
(*Sam, ops lead*) approves it; the sent email records who approved. "Agents propose, a human decides."

**2:30 — Proof (20s).**
- `npm test` (56 tests offline, 78 with local Supabase) and `npm run eval` (42/42 state assertions).
- Fresh-context LLM results: on a long backlog the recency-window agent missed the delivery problem, and the
  compiled-state agent caught it.
- `node eval/scale.ts`: the briefing stays around 1–2k tokens while the transcript climbs into the millions.
- Finish with: "Primitive delivers the messages. Continuity keeps the place in the conversation."

---

## Step-through mode (recommended when presenting)

```bash
npm run demo -- --step
```

Before every beat the demo stops and waits for Enter, while the UI at http://localhost:4100 refreshes live as each
message is ingested. That lets you talk through each state change as it shows up: the correction arriving, the quote
going partially stale, the conflict appearing, and agent-b's run being added.

To present with a real Primitive account, follow README → "Live Primitive". Outside the demo scripts, approving a
held card takes a separate approver token (`npm run token -- --kind approver --label "<name>"`): the operator token
cannot approve, and agents never can.

## Presenting from the website (demo day)

```bash
npm run stage        # then open http://localhost:4000 full-screen
```

1. **Story (localhost:4000), roughly 90 seconds.** Scroll at whatever pace suits you: hero → problem (“so… where are
   we?”) → idea (hovering an underlined phrase lights up the state it produced) → Listen / Resolve / Brief → “Watch an
   agent die”, the scroll replay in which the board on the left is the engine's real compiled state at each beat →
   proof.
2. **Live engine (Live engine →).** Press **→** (or Space) once per beat. Beats 3, 6 and 8 take over the full screen:
   SIGKILL, a new process with zero memory, and the closing card. The tabs are **1** evidence & transitions, **2** agent
   handoff (it opens by itself when B and C write), and **3** the live briefing. **Shift+R** resets the engine.
3. **You are in the loop.** At beat 8 Agent C's order confirmation is held as an approval card until you press **A**
   to approve (or **R** to reject). Agents can't approve their own commitments.
4. With Claude keys a beat takes ~5–15 s ("Claude is working…"); keep talking through it. `npm run stage -- --offline`
   makes each beat instant and deterministic.
5. If the laptop can't run the stage, any static copy of `site/` still works, because the console falls back to
   replaying the recorded run.
