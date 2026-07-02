# agent-eval — Client Demo

A 3-minute, **offline** (no API key) demo of the full loop:

> **Three trace formats → one triage pass → promote the worst run → a permanent regression case.**

Everything here runs against **real SDK-emitted traces** (OpenTelemetry, LangSmith, and
AgentLens exports produced by each tool's own SDK — not hand-authored mocks).

---

## Run it

```bash
npm run build
node demo/demo.mjs
```

That's the whole demo. It prints four labeled steps.

---

## What each step shows (the narration)

**[1] The pain: format fragmentation.**
Three teams, three tracers — OpenTelemetry (Phoenix/Traceloop/OpenLLMetry), LangSmith,
and AgentLens. Normally that's three silos and three parsers. Here, one ingest layer reads
all of them.

**[2] One deterministic triage pass.**
All 10 sessions ranked in a single table by **wasted spend + failure mode** — timeouts,
abandoned runs, token bonfires. No model, no API key: this is **Tier 1** evidence the agent
can't forge (did it finish? did it error? how many tokens did it actually burn?). The table
shows ~$40 of waste the operator didn't know about.

**[3] Promote the worst run.**
The single most expensive failure (a 1.3M-token LangSmith timeout — *"Scrape all 400 product
pages…"*) gets frozen into a **real, runnable** eval spec under `demo/goldens/`. Every case
carries `sourceTraceId` provenance back to the incident.

**[4] The loop is closed.**
That generated case actually runs through the agent-eval CLI. It replays the original bad
output, so it **fails on purpose** — that red *is* the captured incident, now a permanent
regression test. Point the provider at the **fixed** agent and it turns green; the failure
can never silently return.

---

## The one honest caveat (say it out loud)

These traces are **real in shape** (emitted by each tool's real SDK) but were generated
offline — there's no live-LLM run here because this box has no API key. The last mile is
pointing step 3's promoted case at a **live provider** to test a real fixed agent. Swap
`LocalProvider` for a live one in the generated `.eval.mjs` and it's a live regression gate.

Nothing in this demo is faked: the triage numbers, the promotion, and the eval verdict are
all produced by the real, shipped package (`dist/`).

---

## Files

| File | Role |
|---|---|
| `demo.mjs` | The scripted 3-minute flow (steps 1–4). |
| `promote.mjs` | The net-new closed-loop step: worst triaged run → real `.eval.mjs`. |
| `traces/` | Real SDK-emitted trace exports (OTLP, LangSmith, AgentLens). |
| `goldens/` | Where promoted regression cases land (generated; safe to delete + re-run). |

## Reset

```bash
rm demo/goldens/*.eval.mjs   # clear generated cases; re-run demo.mjs to regenerate
```

---

## Doing this for real (not just the demo)

The demo wires the steps together by hand. In production, three CLI commands do it:

```bash
# 1. Scaffold a PRIVATE corpus (gitignore + SCRUBBING.md + secret scanner + CI gate):
agent-eval init-corpus ./my-corpus

# 2. Triage real traces and freeze the worst runs into regression cases:
agent-eval triage ./raw/export.json --format otlp --promote-top 5 --to ./my-corpus/cases

# 3. Sanitize each case (SCRUBBING.md), then gate on them forever:
agent-eval run ./my-corpus/cases/
```

`init-corpus` also drops `.github/workflows/eval-gate.yml`, so once the corpus is a
private repo, every push replays the whole corpus and a still-broken failure blocks
the merge. That is the CI gate pointed at the corpus.

