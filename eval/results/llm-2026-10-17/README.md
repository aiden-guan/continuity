# Fresh-context LLM handoff runs — 2026-10-17 (manual)

**Why manual:** no `ANTHROPIC_API_KEY` was available to the app overnight, so `npm run eval -- --llm` could not run.
Instead, each condition was run as a *fresh* Claude subagent (no prior conversation, no tools except reading exactly two
files: the agent system prompt in `eval/inputs/SYSTEM.*.txt` and one input file in `eval/inputs/<scenario>.<condition>.txt`).
The JSON decisions are saved here verbatim except where noted, and graded with the same rubric code as the automated eval:

```
node eval/grade.ts eval/results/llm-2026-10-17
```

| Scenario | compiled briefing | recent-3 inbox messages | full transcript | generic LLM summary |
|---|---|---|---|---|
| canonical-handoff (see `../handoff-canonical-2026-10-17.md`; recent-2 used there) | PASS | PASS | PASS | — |
| long-backlog (10 more emails after the correction) | **PASS** | **FAIL** — never mentions the late 200 units / Oct 28 or the owed revised quote; asks the supplier to re-confirm price | PASS | PASS |
| contested-claims (forwarder contradicts supplier) | PASS | PASS | (not run) | — |

Generic-summary baseline: one fresh Claude context summarized the full long-backlog transcript ("concise summary so a
colleague can catch up", ≤250 words; saved as `long-backlog.summary-input.txt`), a second fresh context acted on it.

Observations
- A good LLM summary of a *short* transcript is enough to act correctly — this is the honest result. What it does not
  give: provenance (no evidence ids), guarantees (if the summarizer drops the open commitment, nothing notices), or
  bounded cost (it must re-read the whole transcript on every wake, and the transcript grows without bound). The compiled
  state is produced deterministically from the log: interpretation cost is paid once per email at ingestion (one
  extraction call with the LLM extractor, none with the rule extractor) and nothing at wake time.
- The recency baseline fails exactly when operationally critical state (a correction, an open commitment) is older than
  the window: its last 3 messages were a promo, an office-closure notice and a truck booking, so it treated the deal as on
  track and asked for re-confirmation of terms that were already established.
- The full-transcript baseline is correct here but grows without bound (see `../scale.json`: ~2.7M tokens at 267 messages
  with mail-client quoting, vs ~2.4k for the briefing). It also misattributed the quote PDF to the last email in an earlier
  run because attachments were appended at the end of the transcript; the baseline formatter was fixed to put attachment
  text inline (re-exported inputs are the fixed version; the saved decision is from the earlier input).
- Compiled-state agents cited evidence ids for every fact they relied on and explicitly ignored the quarantined injection.
- In long-backlog the compiled agent also replied to finance about a "cost center" request that the rule-based extractor
  had (wrongly) recorded as an obligation we owed (keyword "cost" matched the price topic). Fixed after this run by
  tightening topic keywords; the saved decision reflects the pre-fix briefing.

Caveats (honest)
- n=1 per cell; these are illustrations, not statistics. Run `npm run eval -- --llm` with a key for repeatable numbers.
- The rubric for contested-claims was widened after seeing results (it missed the phrasing "doesn't match your update");
  the recent-3 agent did ask both parties to reconcile, so the corrected grade is PASS.
- The secondary forwarder emails in the contested-claims JSONs were shortened when saved (supplier emails are verbatim).
