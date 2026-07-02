# agent-eval

A lightweight, zero-dependency TypeScript toolkit for evaluating AI agent outputs - in tests, across a production fleet, and as a CI gate.

Every surface is built on one idea - an **[independence-first tier pyramid](#the-tier-pyramid)**: prefer checks the agent *cannot forge* (did it crash? did it stall? does its claim match the real exit status?) and fall back to a model-as-judge only for genuine quality calls. The result is mostly deterministic, offline, and free, with paid judging reserved for the ~20% that needs it.

## What you can do with it

| Surface | Question it answers | Cost |
|---------|---------------------|------|
| **[Eval framework](#live-agent-evaluation)** | *Did this agent run do the thing?* - Jest/Vitest-style assertions over a live agent's output, run in tier order with auto short-circuit. | free → paid |
| **[Fleet monitoring](#fleet-monitoring)** | *Is worker X healthy over time?* - score a directory of transcripts, track trends, roll up a health grade. | free |
| **[Fleet triage](#fleet-triage-rank-failed-runs-by-cost)** | *Which runs failed expensively, worst first?* - rank broken runs by burned tokens and projected dollars, straight off raw `.jsonl` logs. | free |
| **[Fleet judge](#fleet-judge-offline-tier-3-second-opinion)** | *Did the finished runs actually do good work?* - a cost-capped Tier-3 second opinion over a fleet database. | paid |
| **[CI quality gate](#ci-quality-gate-github-action)** | *Should this job block?* - fail a GitHub Action on empty / stale / off-task output, or output that contradicts the run's real outcome. | free |

It reads hand-authored transcripts *and* raw agent logs: an [OpenClaw session adapter](#fleet-triage-rank-failed-runs-by-cost) turns on-disk `.jsonl` sessions into evaluable timelines.

> **Triage vs. judge** - the two fleet tools are complementary: *triage* is free and catches **process** failure (the run broke, stalled, or ran away); *judge* is its paid counterpart for **correctness** (a run that finished cleanly but did the wrong thing). Use triage to find the wreckage, judge to grade the survivors.

## Features

- **Live agent evaluation** - run agents against real LLMs, capture tool calls and a timeline, evaluate the output
- 🔺 **3-tier eval pyramid** - deterministic → heuristic → model-as-judge, with automatic short-circuit
- ⚖️ **LLM-as-judge** - structured rubrics, calibration, consensus & adversarial judging
- 🔍 **Hallucination detection** - flag fabricated facts, broken links, invented references
- 📐 **Drift & staleness** - catch agents that sidetrack, stall, or produce nothing actionable
- 🛰️ **Ground-truth verification** - cross-check a transcript's self-reported outcome against trusted orchestrator metadata
- 🔌 **Raw-log adapter** - evaluate on-disk OpenClaw `.jsonl` sessions directly, not just curated transcripts
- 💸 **Fleet triage** - rank the runs that failed expensively (abandoned / timed-out / runaway) by burned tokens and projected dollar cost
- 🧑‍⚖️ **Fleet judge** - cost-capped offline Tier-3 second opinion over a fleet DB; weighs the recorded outcome so a polished-but-failed run can't score `pass` (signal, never a gate)
- 🚦 **CI quality gate** - gate a GitHub Action on agent output quality (deterministic, offline)
- ✅ **Clear pass/fail** - results carry evidence for what went wrong

## The Tier Pyramid

agent-eval is built on an **independence-first** hierarchy - prefer checks the agent can't forge:

| Tier | Name | Why it works |
|------|------|-------------|
| 1 | **Externally Observable** | Agent cannot forge the result. A JSON parse failure is a JSON parse failure. |
| 2 | **Statistically Observable** | Agent didn't produce the baseline being compared against. Embeddings, distributions, patterns. |
| 3 | **Shared-Substrate Judgment** | Model-as-judge. Least independent, most forgeable. Last resort only. |

Most agent failures (stale runs, crashes, format violations, hallucinated paths, incomplete output) are catchable with **Tier 1+2 alone**. Model-as-judge handles the remaining ~20% - genuine subjective quality calls.

> **Gate vs. grade:** a check either *gates* (binary "did the agent do the thing?") or *grades* (a 0–1 "how well?" score). A low grade is **information, not a failure** — never coerce a grade into a gate.

## Install

```bash
npm install agent-eval
```

## Quick Start

```typescript
import { defineEval, toContain, toMatch, LocalProvider, runSuite, TerminalReporter } from 'agent-eval';

const provider = new LocalProvider({
  outputs: {
    'Write a function that reverses a string': `
      function reverseString(input: string): string {
        return input.split('').reverse().join('');
      }
    `,
  },
});

const suite = defineEval({
  name: 'Code generation quality',
  provider,
  specs: [
    {
      name: 'generates valid TypeScript',
      prompt: 'Write a function that reverses a string',
      assertions: [toContain('function'), toMatch(/:\s*string/), toContain('reverse')],
    },
  ],
});

const reporter = new TerminalReporter({ verbose: true });
const result = await runSuite(suite, { reporters: [reporter] });
console.log(reporter.format([result]));
```

## Live Agent Evaluation

Run a real agent against a real LLM, capture tool calls and timeline, then evaluate with all 3 tiers:

```typescript
import {
  AgentProvider, defineTool, runTiered,
  tier1, tier2, tier3,
  toBeNonEmpty, toNotBeAbandoned, toHaveMeaningfulDiff,
  toContainKeywords, toNotRepeat, toNotBeStale,
  toPassJudge, BUILTIN_RUBRICS, LLMJudgeBackend,
} from 'agent-eval';

// 1. Define tools the agent can use
const readFile = defineTool('read_file')
  .describe('Read a file')
  .param('path', 'string', 'File path', true)
  .execute(async (args) => fs.readFileSync(args.path as string, 'utf-8'));

// 2. Create the agent provider (runs an agentic loop with tool calls)
const provider = new AgentProvider({
  llm: { type: 'groq', apiKey: process.env.GROQ_API_KEY!, model: 'llama-3.3-70b-versatile' },
  tools: [readFile],
  systemPrompt: 'You are a security auditor.',
  maxIterations: 8,
});

// 3. Run the agent
const result = await provider.run('Review auth.ts for security issues and fix them.');

// 4. Evaluate with all 3 tiers
const judge = new LLMJudgeBackend({ type: 'groq', apiKey: process.env.GROQ_API_KEY!, model: 'llama-3.3-70b-versatile' });

const tieredResult = await runTiered(result.output, [
  // Tier 1 - Deterministic (free, instant)
  tier1(toBeNonEmpty()),
  tier1(toNotBeAbandoned(result.timeline)),
  tier1(toHaveMeaningfulDiff(originalCode)),
  // Tier 2 - Heuristic (cheap, milliseconds)
  tier2(toContainKeywords(['hashing', 'bcrypt', 'salt'])),
  tier2(toNotRepeat()),
  tier2(toNotBeStale(result.timeline)),
  // Tier 3 - Model-as-Judge (paid, seconds)
  tier3(toPassJudge(judge, BUILTIN_RUBRICS.codeReview())),
]);

console.log(tieredResult.passed ? '✅ PASS' : '❌ FAIL');
```

`AgentProvider.run()` returns a full trace:

```typescript
result.output;        // Final agent response
result.turns;         // [{ index, content, toolCalls[], durationMs, finishReason }]
result.timeline;      // { startedAt, endedAt, events[] } - for staleness/abandonment checks
result.totalTokens;   // { prompt, completion, total }
result.stopReason;    // 'complete' | 'max_iterations' | 'max_duration' | 'error'
result.durationMs;    // Total wall-clock time
```

## Tiered Runner (Cost Pyramid)

Run assertions in tier order with automatic short-circuiting. If Tier 1 fails, Tier 2+3 never run - saving time and cost.

```typescript
import { runTiered, tier1, tier2, tier3 } from 'agent-eval';

const result = await runTiered(output, [
  tier1(toBeValidJson()),
  tier1(toBeNonEmpty()),
  tier2(toContainKeywords(topics)),
  tier3(toPassJudge(backend, rubric)),
]);

if (!result.passed) console.log(`Caught at Tier ${result.failedAtTier} - later tiers skipped`);
```

| Option | Default | Description |
|--------|---------|-------------|
| `shortCircuit` | `true` | Stop on first failure within a tier |
| `skipTier3` | `false` | Never run Tier 3 (cost control) |
| `runAllTiers` | `false` | Run all tiers even if earlier ones fail |
| `maxAssertions` | unlimited | Cap total assertions run (cost cap) |

## Providers

**`AgentProvider`** - full agentic loop with tool execution and timeline capture:

```typescript
const provider = new AgentProvider({
  llm: { type: 'groq', apiKey: '...', model: 'llama-3.3-70b-versatile' },
  tools: [readFile, writeFile],
  systemPrompt: 'You are a helpful assistant.',
  maxIterations: 10,       // Max tool call rounds (default: 10)
  maxDurationMs: 120000,   // Timeout (default: 120s)
});
```

| Backend | Type | Auth |
|---------|------|------|
| **Groq** | `'groq'` | `apiKey` |
| **Google Gemini** | `'gemini'` | `apiKey` |
| **Azure OpenAI** | `'azure-openai'` | `endpoint` + `apiKey` + `deployment` |
| **OpenRouter** | `'openrouter'` | `apiKey` |

**`LocalProvider`** - test against saved outputs (no API calls): `{ outputs, defaultOutput, substringMatch }`.
**`AzureOpenAIProvider`** - single-shot completions (no tool loop): `{ endpoint, apiKey, deployment }`.

Tool builder:

```typescript
const tool = defineTool('search')
  .describe('Search the codebase')
  .param('query', 'string', 'Search query', true)
  .param('limit', 'number', 'Max results', false)
  .execute(async (args) => searchIndex(args.query as string, args.limit as number));
```

## LLM Judge (Tier 3)

The last-resort tier: a model grades the output against a structured rubric. This is the per-assertion judge used inside a suite; to run the same judging engine over a whole fleet database, see [Fleet Judge](#fleet-judge-offline-tier-3-second-opinion).

```typescript
import { BUILTIN_RUBRICS, buildRubric, LLMJudgeBackend } from 'agent-eval';

BUILTIN_RUBRICS.codeReview();     // Actionability, Accuracy, Completeness
BUILTIN_RUBRICS.taskCompletion(); // Relevance, Completeness, Quality, Depth

const rubric = buildRubric('Security Audit Quality')
  .describe('Evaluates security review thoroughness')
  .passAt(0.7)
  .criterion('severity-classification', 'Are vulnerabilities correctly classified?')
    .level(1, 'Wrong', 'Misclassifies severity').level(5, 'Accurate', 'All correct').weight(0.5).done()
  .criterion('remediation', 'Are fixes provided and correct?')
    .level(1, 'None', 'No fixes').level(5, 'Complete', 'Correct, actionable fixes').weight(0.5).done()
  .build();

const judge = new LLMJudgeBackend({
  type: 'groq',          // 'groq' | 'openrouter' | 'openai'
  apiKey: '...',
  model: 'llama-3.3-70b-versatile',
  temperature: 0,         // Deterministic judging (default: 0)
  maxRetries: 2,
});
```

**Consensus & adversarial judging** - reduce non-determinism and positivity bias:

```typescript
import { toPassConsensusJudge, toPassAdversarialJudge } from 'agent-eval';

toPassConsensusJudge(backend, rubric, { samples: 5 })  // multi-sample median
toPassAdversarialJudge(backend, rubric)                // weakness-first, anti-injection
```

**Calibration** - validate your judge against known ground truth with `calibrate`, `buildCalibrationSet`, and `detectDrift`; `report.calibrated` flags an unreliable judge.

## Assertions Reference

**Tier 1 - Deterministic**

| Assertion | Description |
|-----------|-------------|
| `toContain(str)` / `notToContain(str)` | Substring presence |
| `toMatch(regex)` / `notToMatch(regex)` | Pattern match |
| `toEqual(str)` | Exact string match |
| `toBeValidJson()` / `toMatchJsonSchema(schema)` | JSON validity / schema |
| `toBeNonEmpty()` | Non-empty output |
| `toHaveMinLength(n)` / `toHaveMaxLength(n)` | Length bounds |
| `toStartWith(str)` / `toEndWith(str)` | Prefix / suffix |
| `toHaveMarkdownStructure(opts)` | Markdown heading/section checks |
| `toHaveValidUrls()` / `toHaveValidPaths()` | URL / file path validation |
| `toHaveMeaningfulDiff(before)` | Non-trivial changes from original |
| `toNotBeAbandoned(timeline)` | Agent didn't crash/timeout |
| `toCompleteWithinTimeout(timeline, ms)` | Finished within time limit |
| `custom(name, fn)` | Custom assertion function |

**Tier 2 - Heuristic**

| Assertion | Description |
|-----------|-------------|
| `toNotRepeat()` | Repetition/loop detection |
| `toNotBeSaturated()` | N-gram saturation check |
| `toNotBeStale(timeline)` | Progress staleness detection |
| `toContainKeywords(keywords)` | Required-keyword presence |

**Tier 3 - Model-as-Judge**

| Assertion | Description |
|-----------|-------------|
| `toPassJudge(backend, rubric)` | Full rubric evaluation |
| `toScoreOnCriterion(backend, rubric, id, min)` | Single criterion score |
| `toPassConsensusJudge(backend, rubric, opts)` | Multi-sample consensus |
| `toPassAdversarialJudge(backend, rubric)` | Adversarial probing |

## CLI

```bash
npx agent-eval run ./specs/                     # run eval specs (*.eval.ts / *.eval.js)
npx agent-eval run ./specs/ --bail --filter "hallucination"
npx agent-eval validate ./transcripts/          # validate transcript(s) against the contract
npx agent-eval validate ./run.md --finished     # require a FINISHED transcript
npx agent-eval --version
npx agent-eval --help
```

`run` options: `--bail/-b`, `--filter/-f <regex>`, `--reporter/-r terminal|json`, `--timeout/-t <ms>` (default 30000), `--concurrency/-c <n>` (default 1). `validate` options: `--json`, `--finished`.

## Fleet Monitoring

Point it at a directory of agent run transcripts and get per-run scores, score trends over time, and a rolled-up health grade - the same Tier 1+2 signals as the eval framework, applied to real production runs (no model-as-judge, so it's deterministic and free).

```typescript
import {
  discoverTranscripts, scoreTranscripts, writeScores,
  scoreHistory, detectTrendsFromDisk, buildScorecard,
} from 'agent-eval';

// 1. Discover + score every transcript in a directory
const transcripts = discoverTranscripts('./transcripts');
const scores = scoreTranscripts(transcripts);
writeScores('./scores', scores);              // append to the score store

// 2. Track how scores move over a rolling window
const history = scoreHistory('./scores', { window: 14 });
const trends = detectTrendsFromDisk('./scores', { window: 14 });
// trends => per-worker direction: improving | flat | regressing

// 3. Roll the window up into one health grade
const card = buildScorecard('./scores', { window: 7 });
console.log(card.grade);  // healthy | watch | at-risk | critical
```

| Entry point | What it does |
|-------------|--------------|
| `discoverTranscripts(dir)` | Find transcript files under a directory |
| `scoreTranscript(t)` / `scoreTranscripts(ts)` | Score one / many runs (Tier 1+2) |
| `writeScores(dir, scores)` | Append scores to an on-disk store |
| `scoreHistory(dir, opts)` | Per-run score series over a window |
| `detectTrendsFromDisk(dir, opts)` | Per-worker trend direction over a window |
| `buildScorecard(dir, opts)` | Fleet health grade for the window |

`scoreTranscript` also accepts `runMetadata` to cross-check a run's self-reported outcome against trusted orchestrator data - see [Verifying claims against ground truth](#ci-quality-gate-github-action).

## Fleet Triage (rank failed runs by cost)

The scorecard answers *"is worker X healthy on average?"*. Triage answers the operational question: ***"which specific runs failed expensively, worst first?"*** It walks a directory of agent sessions, runs the deterministic staleness check on each, and emits one ranked row per run that broke - abandoned, timed-out, runaway, or stalled - annotated with the tokens it burned and a projected dollar cost on usage-based pricing. Deterministic and offline (no model-as-judge).

Where transcripts are hand-authored `.md`, real fleets write raw `.jsonl` session logs. The **OpenClaw adapter** (`buildAllSessions` / `buildSession` / `listSessions`) converts those - reconciling bare logs, `.trajectory.jsonl` companions, and checkpoint snapshots into one `RunTimeline` per logical session - so triage runs straight off disk.

Triage isn't OpenClaw-only. The **LangSmith adapter** (`triageLangSmith` / `parseLangSmith`) accepts a LangSmith run export - the JSON array of `Run` records emitted by `client.list_runs(...)` or the LangSmith UI's *Export* - and triages any LangChain / LangGraph agent with zero code changes. Runs sharing a `trace_id` collapse into one session; token usage is summed from leaf `llm` runs (avoiding the parent-chain rollup double-count); an unset `end_time` marks a run that never finished, and timeout/deadline language in `error` flags it as a `timeout`.

```typescript
import { triageLangSmith, renderTriageTable } from 'agent-eval';
import { readFileSync } from 'node:fs';

// A LangSmith export: `json.dump([r.dict() for r in client.list_runs(...)], f)`
const report = triageLangSmith(readFileSync('./langsmith-export.json', 'utf8'), {
  dollarsPerMillionTokens: 9,
});
console.log(renderTriageTable(report, 15));
```

```text
Scanned 4 sessions — 2 failed (2 costly). Projected waste: $14 @ $9/M tokens.

| # | Session  | Kind      | Duration | Tokens | ~$  | What went wrong |
|---|----------|-----------|----------|--------|-----|-----------------|
| 1 | 046893a4 | timeout   | 9m       | 1.3M   | $11 | idle/timeout abandon — never finished |
| 2 | 55da498e | abandoned | 4m       | 305K   | $3  | aborted with no clean end |
```

```typescript
import { triageSessions, renderTriageTable } from 'agent-eval';

const report = triageSessions('./sessions', { dollarsPerMillionTokens: 9 });
console.log(renderTriageTable(report, 15));
console.log(`Projected waste: $${report.projectedCostUsd.toFixed(0)}`);
```

```text
Scanned 2968 sessions — 88 failed (67 costly). Projected waste: $1826 @ $9/M tokens.

| # | Session    | Kind    | Duration | Tokens | ~$   | What went wrong |
|---|------------|---------|----------|--------|------|-----------------|
| 1 | 17dc8997   | timeout | 59m      | 19.3M  | $174 | idle/timeout abandon — never finished |
| 2 | dc0f2ecd   | timeout | 60m      | 14.1M  | $127 | idle/timeout abandon — never finished |
| 3 | b53a4550   | timeout | 10h36m   | 8.8M   | $79  | idle/timeout abandon — never finished |
```

| Entry point | What it does |
|-------------|--------------|
| `triageSessions(dir, opts)` | Scan a sessions dir → ranked {@link TriageReport} |
| `triageBuilt(sessions, opts)` | Triage already-built sessions (pure, no I/O) |
| `triageOne(session, opts)` | One session → a {@link TriageRow}, or `null` if it ran clean |
| `renderTriageTable(report, n)` | Render the top-N failures as a Markdown table |
| `buildAllSessions(dir)` | OpenClaw adapter: raw `.jsonl` → evaluable sessions |
| `triageLangSmith(text, opts)` | LangSmith adapter: run-export JSON → ranked {@link TriageReport} |
| `parseLangSmith(text)` | LangSmith run export → `BuiltSession[]` (one per trace) |

| Option | Default | Description |
|--------|---------|-------------|
| `dollarsPerMillionTokens` | `9` | Blended rate for the cost projection |
| `costlyTokenThreshold` | `200_000` | Tokens at/above which a failure is "costly" vs. a trivial error |
| `costlyRuntimeMs` | `600_000` | Runtime (10m) that also marks a failure costly |
| `staleOnly` | `true` | Only `isStale` runs (vs. any run that didn't end cleanly) |

Each `TriageRow` carries `id`, `label`, `kind` (`timeout` \| `abandoned` \| `runaway` \| `stalled` \| `errored`), `tokenUsage`, `runtimeMs`, `projectedCostUsd`, a `costly` flag, and a one-line `summary`. **Scope:** triage catches *process* failure (the run broke or ran away), not *correctness* (a run that finished cleanly but did the wrong thing) - that needs the Tier-3 judge.

## Fleet Judge (offline Tier-3 second opinion)

Triage and judge are the two halves of fleet review (see [Triage vs. judge](#what-you-can-do-with-it)): triage is free and catches *process* failure; this is its paid counterpart for *correctness*. It runs the same [Tier-3 judging engine](#llm-judge-tier-3) used inside a suite, but at fleet scale: `fleet-judge` walks the sessions in an **AgentLens SQLite DB**, renders each to a transcript document, runs the model-as-judge, and writes a **labeled, non-scoring** annotation (`[Tier-3 judge - opinion, not evidence]`) back into the `annotations` table. It is a **signal, never a gate** - these annotations must never feed the real-time Tier-1+2 gate.

```bash
# DRY-RUN by default - estimates tokens/cost, judges nothing, writes nothing
node dist/scripts/fleet-judge.js --db fleet.db --limit 20

# Actually judge + write annotations (OpenRouter, with a hard cost ceiling)
JUDGE_API_KEY=sk-... node dist/scripts/fleet-judge.js --db fleet.db \
  --execute --provider openrouter --model meta-llama/llama-3.3-70b-instruct \
  --max-cost-usd 1 --delay-ms 3000
```

Why it doesn't get snowed by a *polished-but-false* final message (a run that timed out after burning $3 but whose deliverable reads as finished): the harness-recorded outcome (status / duration / abandon markers) is passed to the judge as **objective evidence** (`artifacts.execution_record`) - kept out of the deliverable/task so judge independence holds - and the default fleet rubric's dominant **`execution_integrity`** criterion (weight 0.45) means *a recorded timeout/abandon/error cannot score `pass`*, no matter how clean the output looks. The agent's own `(decision)` reasoning is stripped before the model ever sees it. The rubric still grades quality, so a **completed** run with off-task output also fails - it discriminates on quality, not just status.

**Safety rails (all on by default):** dry-run unless `--execute`; a hard `--max-cost-usd` ceiling that aborts *before* exceeding; a per-session `--max-input-tokens` cap; resume (already-judged sessions are skipped); a request `--delay-ms` for rate-limit pacing with 429 backoff. Re-judging a session **replaces** its prior annotation from the same provider (idempotent), so recovery passes don't accumulate duplicates.

| Flag | Default | Description |
|------|---------|-------------|
| `--db <path>` | *(required)* | AgentLens SQLite DB to read sessions / write annotations |
| `--execute` | off (dry-run) | Actually call the judge and write annotations |
| `--limit <N>` | all | Only the N most-recent sessions |
| `--provider <p>` | `groq` | `groq` \| `openrouter` \| `openai` |
| `--model <m>` | provider default | Judge model override |
| `--max-cost-usd <n>` | `5` | Hard ceiling; aborts before exceeding |
| `--max-input-tokens <n>` | `8000` | Per-session input cap |
| `--delay-ms <n>` | `25000` | Pause between sessions (rate-limit pacing) |
| `--dollars-per-mtok-in/-out` | `0.59` / `0.79` | Price for the cost projection |

The API key is read from `JUDGE_API_KEY` (preferred), else `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY` by provider. Uses Node's built-in `node:sqlite` - no external deps.

## CI Quality Gate (GitHub Action)

Most autonomous agents in CI only check *did the process exit 0?* - that catches a crash, but not a stale run, an empty review, or output that wandered off-task. The action adapter turns the monitoring scorecard into a **pass/fail gate**, deterministic and offline (Tier 1 + 2 only, **no model-as-judge**), so it adds no API cost or flake.

**Fleet gate** - score a rolling window of transcripts, then block the job:

```typescript
import { runActionEval, emitActionResult } from 'agent-eval';

const { evaluation } = runActionEval('./transcripts', {
  window: 7,          // score the last 7 days of runs
  gate: 'watch',      // healthy/watch pass; at-risk/critical fail
  minScore: 0.6,      // optional fleet mean-score floor
});
process.exitCode = emitActionResult(evaluation);  // outputs + step summary + exit code
```

| Knob | Meaning |
|------|---------|
| `gate` | Worst health grade that still passes: `healthy` \| `watch` \| `at-risk` \| `critical` |
| `minScore` | Optional fleet mean-score floor in `[0, 1]` |
| `gateWorkers` | Restrict the gate to specific workers (others reported, never fail) |
| `noData` | Treat workers with no evaluable runs: `pass` \| `fail` \| `ignore` (default `pass`) |
| `window` | Rolling window (days) of transcripts to score |

**Single-run gate** - *"did the agent address THIS prompt?"* for one PR / issue. `evaluateCiRun` scores a `{ prompt, output }` pair and returns the same `ActionEvaluation` shape:

```typescript
import { evaluateCiRun, emitActionResult } from 'agent-eval';

const { evaluation } = evaluateCiRun({
  prompt: prTitle + '\n\n' + prBody,   // the task the agent was given
  output: claudeReviewComment,         // what it produced
  worker: 'claude-review',
});
process.exitCode = emitActionResult(evaluation);
```

It runs two independent Tier-1 checks (no model-as-judge), and **either failing trips the gate**:

- **Completeness** - is the output non-empty, substantive, and not a stub / truncation / refusal?
- **Staleness** (the *no-op* detector) - did the run emit anything a human can **act on**? Counts concrete actionable artifacts (file refs, line numbers, code suggestions, directives) and flags bare acknowledgements ("LGTM"), verbatim reposts, and timeouts. It asks *"is there anything to act on?"*, never *"is it good?"*.

| Knob | Meaning |
|------|---------|
| `minActionableArtifacts` | Min distinct artifact kinds to pass staleness (default `2`) |
| `previousOutput` | Prior comment for this target; a verbatim repost is flagged as a no-op |
| `timeline` | Optional run timeline; folds in timeout / abandonment detection |
| `worker` | Logical name for the run (default `ci-run`) |
| `action` | `gate` / `minScore` / `noData` forwarded to the gate (default gate `watch`) |

**Verifying claims against ground truth** - transcript checks can't catch a transcript that is simply *wrong about its own run*. Pass a trusted orchestrator record as `runMetadata` and the scorer adds a Tier-1 `verification` check:

```typescript
import { scoreTranscript } from 'agent-eval';

const score = scoreTranscript(transcript, {
  runMetadata: { exitStatus: 'error', durationMs: 5_520_000 },
});
// verification → fail: "claims pass but orchestrator recorded error"
```

It flags three unfakeable mismatches: a finished outcome that contradicts the trusted exit status (hard fail), a "done" report while the run is still running (warn), and a self-reported duration that disagrees with measured wall-clock (warn). With no `runMetadata` the check **skips**.

| `RunMetadata` field | Meaning |
|------|---------|
| `exitStatus` | `ok` \| `error` \| `timeout` \| `killed` \| `running` |
| `exitCode` | Process exit code (`0` == success) |
| `startedAt` / `endedAt` | Trusted wall-clock (ISO-8601 or epoch ms); absent `endedAt` ⇒ still running |
| `durationMs` | Trusted measured duration; else derived from start/end |

**`claude-code-action`** - the [action](https://github.com/anthropics/claude-code-action) writes a JSON execution log (`execution_file`); [`extractCcaRunFromFile`](src/action/cca-execution.ts) projects it into the `{ prompt, output, timeline }` `evaluateCiRun` expects, so a CI step can gate on what the agent produced.

See the runnable examples in [`examples/`](examples/): `ci-eval.ts`, `ci-single-run.ts`, `cca-execution-eval.ts`, `github-action-eval.yml`, and [`workflows/pr-review-with-eval.yml`](examples/workflows/pr-review-with-eval.yml) (a copy-pasteable PR-review workflow that runs `claude-code-action`, gates the job on the eval step, and branches on `eval_passed`).

## Benchmark

The `mega-adversarial.ts` example runs 10 adversarial scenarios (all 3 tiers) against 5 models via Groq. Example results from one run:

| Rank | Model | Score | Passed |
|------|-------|-------|--------|
| 1 | Llama 3.3 70B | 62.5% | 40/64 |
| 2 | GPT-OSS 120B | 51.6% | 33/64 |
| 3 | Qwen3 32B | 48.4% | 31/64 |
| 4 | Llama 4 Scout 17B | 46.9% | 30/64 |
| 5 | Llama 3.1 8B | 34.4% | 22/64 |

The scenarios target recurring failure modes including sycophancy (praising bad code when told "my CTO loves it"), anchoring bias (deferring to a wrong expert instead of reading the code), and multi-step reasoning (tracing a 5-file dependency chain).

```bash
GROQ_API_KEY=your-key npx tsx examples/mega-adversarial.ts
```

Scores will vary by model, prompt, and run.

## License

MIT
