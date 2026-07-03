# agent-eval — Client Demo

A 2-minute, **offline** (no API key) demo of the core loop:

> **Three trace formats → one deterministic triage pass → one ranked, legible report.**

Everything here runs against **real SDK-emitted traces** (OpenTelemetry, LangSmith, and
AgentLens exports produced by each tool's own SDK — not hand-authored mocks).

---

## Run it

```bash
npm run build
node demo/demo.mjs
```

That's the whole demo. It prints three labeled steps.

---

## What each step shows (the narration)

**[1] The pain: format fragmentation.**
Three teams, three tracers — OpenTelemetry (Phoenix/Traceloop/OpenLLMetry), LangSmith,
and AgentLens. Normally that's three silos and three parsers. Here, one ingest layer reads
all of them.

**[2] One deterministic triage pass.**
All 10 sessions ranked in a single report by **wasted spend + failure mode** — timeouts,
abandoned runs, token bonfires. No model, no API key: this is **Tier 1** evidence the agent
can't forge (did it finish? did it error? how many tokens did it actually burn?). The report
shows ~$40 of waste the operator didn't know about.

**[3] The report is the deliverable — a human closes the loop.**
`agent-eval` is **post-hoc and report-only**. It stops at the report: it never edits your
agent and never blocks a build. A human reads the findings, decides the fix (a code change
or a prompt change), and feeds it back to the agent — which then emits new traces, and the
loop continues. The report is legible on purpose, so a human (or an agent) can act on it.

---

## The one honest caveat (say it out loud)

These traces are **real in shape** (emitted by each tool's real SDK) but were generated
offline — there's no live-LLM run here because this box has no API key. The Tier-1/2 triage
you see is the deterministic, offline part and runs for real. Tier 3 (the model-as-judge)
would need a live model, which this box can't run.

Nothing in this demo is faked: the triage numbers and the ranked report are all produced by
the real, shipped package (`dist/`).

---

## Beyond "did it break?" — the finished-but-over-budget tier

The demo's 10 sessions are all **process-broke** (timeouts + abandons — that's what these real
exports happen to contain). But triage catches a second family a crash check is blind to *by
construction*: runs that **ended cleanly** (exit status OK) yet **wasted resources**. Four kinds:

| Kind | Fires when a cleanly-ended run… | Default |
|---|---|---|
| `over-cost` | burned too many tokens | ≥ 1,000,000 |
| `over-latency` | ran too long wall-clock | ≥ 30m |
| `excessive-steps` | took too many turns | ≥ 400 events |
| `loop-without-progress` | repeated itself / thrashed | ratio ≥ 0.5 |

A clean run is invisible to a staleness/crash check, so these budgets are the *only* thing
that can catch it. The most interesting one is **`loop-without-progress`** — an agent that
never times out and never errors, but spins. It scans **two** channels, and the evidence
quotes the exact repeat (real output, from the test corpus — not from the 3 demo exports
above):

```text
# repeated ASSISTANT TEXT — same sentence, cycling
loop-without-progress: loop/repetition ratio 1.00 ≥ 0.5 over 6 segments
  — cycle ×2 (3-segment) — "Let me check the build configuration to find the root cause "

# repeated TOOL CALL — same failing command, fired back-to-back
loop-without-progress: loop/repetition ratio 1.00 ≥ 0.5 over 7 segments
  — tool `exec({"command":"npm test -- flaky.spec.ts"})` called ×6 of 6 (×6 back-to-back)
```

Two things make this trustworthy rather than noisy:

- **Arg-level, not name-level.** Tool signatures are `name(args)`, so six `edit()` calls to
  six *different* files read as real work — **not** a loop. Only genuinely repeated calls flag.
- **Honest cost accounting.** A cheap looper is a **quality** flag (`completedBad`), *not*
  counted as costly — so it never inflates the projected-dollar figure. The `$` stays about
  real burned spend.

Toggle it off with `includeCompleted: false` to get broken-only triage. It's fully additive:
defaults sit high enough that ordinary clean runs pass untouched.

---

## Files

| File | Role |
|---|---|
| `demo.mjs` | The scripted 2-minute flow (steps 1–3). |
| `traces/` | Real SDK-emitted trace exports (OTLP, LangSmith, AgentLens). |

## Doing this for real (not just the demo)

In production it's one CLI command per trace export — analyze, read, act:

```bash
# Analyze real traces. Deterministic Tier 1/2 — no model, no cost, offline.
# Add --json to pipe the report into your own tooling.
agent-eval triage ./raw/export.json --format otlp
```

`triage` always exits 0. It is a report, not a gate: it surfaces the process failures,
worst-first, with `sourceTraceId` provenance back to each real run. What you do about them —
a code change or a prompt change — is your call. That open loop is the design.
