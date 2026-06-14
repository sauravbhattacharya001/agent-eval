# agent-eval

A lightweight TypeScript framework for testing and evaluating AI agent outputs.

Think: **Jest/Vitest but for agent outputs** instead of functions.

## Features

- 🤖 **Live agent evaluation** - run agents against real LLMs, capture tool calls, evaluate output
- 🔺 **3-tier eval pyramid** - deterministic → heuristic → model-as-judge, auto short-circuit
- ⚖️ **LLM-as-judge** - structured rubrics, calibration, consensus & adversarial judging
- 🔍 **Hallucination detection** - flag fabricated facts, broken links, invented references
- 📐 **Drift & staleness** - catch agents that sidetrack, stall, or produce nothing actionable
- 🛰️ **Ground-truth verification** - cross-check a transcript's self-reported outcome against trusted orchestrator metadata
- 🚦 **CI quality gate** - gate a GitHub Action on agent output quality (deterministic, offline)
- ✅ **Clear pass/fail** - results with evidence for what went wrong

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
  // Tier 3 - Model-as-Judge ($$$, seconds)
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

Run assertions in tier order with automatic short-circuiting. If Tier 1 fails, Tier 2+3 never run - saving time and money.

```typescript
import { runTiered, tier1, tier2, tier3 } from 'agent-eval';

const result = await runTiered(output, [
  tier1(toBeValidJson()),
  tier1(toBeNonEmpty()),
  tier2(toContainKeywords(topics)),
  tier3(toPassJudge(backend, rubric)),
]);

if (!result.passed) console.log(`Caught at Tier ${result.failedAtTier} - saved $$$`);
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
npx agent-eval run ./specs/
npx agent-eval --version
npx agent-eval --help
```

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

10 adversarial scenarios (64 assertions, all 3 tiers) against 5 models via Groq - **no model scored above 63%**:

| Rank | Model | Score | Passed |
|------|-------|-------|--------|
| 🥇 | **Llama 3.3 70B** | **62.5%** | 40/64 |
| 🥈 | **GPT-OSS 120B** | **51.6%** | 33/64 |
| 🥉 | **Qwen3 32B** | **48.4%** | 31/64 |
| 4 | **Llama 4 Scout 17B** | **46.9%** | 30/64 |
| 5 | **Llama 3.1 8B** | **34.4%** | 22/64 |

Three universal failure modes: **sycophancy** (praised bad code when told "my CTO loves it"), **anchoring bias** (deferred to a wrong expert instead of reading the code), and **multi-step reasoning** (couldn't trace a 5-file dependency chain).

```bash
GROQ_API_KEY=your-key npx tsx examples/mega-adversarial.ts
```

Full writeup: [I Built an Adversarial Eval Framework and Attacked 5 LLMs](https://dev.to/saurav_bhattacharya/i-built-an-adversarial-eval-framework-and-attacked-5-llms-every-single-one-failed-1j81).

## License

MIT
