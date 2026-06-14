# agent-eval

A lightweight TypeScript framework for testing and evaluating AI agent outputs.

Think: **Jest/Vitest but for agent outputs** instead of functions.

## Features

- 🤖 **Live agent evaluation** — run agents against real LLMs, capture tool calls, evaluate output
- 🔺 **3-tier eval pyramid** — deterministic → heuristic → model-as-judge, auto short-circuit
- ⚖️ **LLM-as-judge** — structured rubrics, calibration, consensus judging, adversarial probes
- 🔍 **Hallucination detection** — flag fabricated facts, broken links, invented references
- 📐 **Drift monitoring** — catch when an agent sidetracks from its assigned task
- 🛰️ **Ground-truth verification** — cross-check a transcript's self-reported outcome/duration against trusted orchestrator metadata; catch a run that *claims* it passed but actually errored
- 🔁 **Repetition/loop detection** — catch stuck agents and saturated output
- 🚦 **CI quality gate** — gate a GitHub Action on agent output quality (deterministic, offline)
- ✅ **Clear pass/fail** — results with evidence for what went wrong

## Philosophy

**Research-time safety ≠ Production-time safety.**

AI safety research (interpretability, RLHF, Constitutional AI) happens during model development. But once a model ships and agents run autonomously in CI pipelines, code reviews, and customer workflows — who's watching?

agent-eval is built on an **independence-first** hierarchy:

| Tier | Name | Why it works |
|------|------|-------------|
| 1 | **Externally Observable** | Agent cannot forge the result. A JSON parse failure is a JSON parse failure. |
| 2 | **Statistically Observable** | Agent didn't produce the baseline being compared against. Embeddings, distributions, patterns. |
| 3 | **Shared-Substrate Judgment** | Model-as-judge. Least independent, most forgeable. Last resort only. |

Most agent failures (stale runs, crashes, format violations, hallucinated paths, incomplete output) are catchable with Tier 1+2 alone. Model-as-judge handles the remaining ~20% — genuine subjective quality calls.

### Two axes: independence *and* gate-vs-grade

The tier table above is the **independence** axis (can the agent forge the result?). There's a second, orthogonal axis that matters just as much — whether a signal **gates** or **grades**:

| | **Gate** | **Grade** |
|---|---|---|
| Question | *Did the agent do the thing?* | *How well does the output match the task?* |
| Output | binary — `pass` / `fail` | a score on a 0–1 gradient |
| Right verdict | `fail` is meaningful | a low score is **information, not a failure** |
| Examples | non-empty, valid JSON, not-abandoned, meaningful diff, **verification** | judge rubric scores (relevance, quality, depth) |

A grade answering *"how well"* should never be coerced into a *"did it / didn't it"* — a 0.00 judge-rubric relevance score against a vague prompt is a real, low **grade**, not a failed gate.

**Who decides a signal is a gate matters more than its tier.** The same Tier-2 check behaves differently depending on the surface:

- **You assert on it** (`tier2(toContainKeywords(topics))` via [`runTiered`](#tiered-runner-cost-pyramid)) → it **gates**. You opted in; a binary pass/fail is what you asked for. Here "tier" is a *cost ordering* (run cheap checks first, short-circuit) — failures are expected and intended.
- **The system auto-scores it** (the Tier-3 [judge rubric](#llm-judge-tier-3)) → it **grades**. You didn't opt in; the scorer reports a 0–1 score, so a low grade is information and never silently inflates the failure count. (Tier 1 auto-scores still gate — they're forge-proof and unambiguous.)

So: *gate when the author chose this signal as a bar to clear; grade when the system is scoring quality the author didn't single out.*

## Benchmark Results

We ran 10 adversarial scenarios (64 assertions, all 3 tiers) against 5 models via Groq:

| Rank | Model | Score | Passed |
|------|-------|-------|--------|
| 🥇 | **Llama 3.3 70B** | **62.5%** | 40/64 |
| 🥈 | **GPT-OSS 120B** | **51.6%** | 33/64 |
| 🥉 | **Qwen3 32B** | **48.4%** | 31/64 |
| 4 | **Llama 4 Scout 17B** | **46.9%** | 30/64 |
| 5 | **Llama 3.1 8B** | **34.4%** | 22/64 |

**No model scored above 63%.** Three universal failure modes:
- 🪞 **Sycophancy** — every model praised terrible code when told "my CTO loves it"
- ⚓ **Anchoring bias** — every model deferred to a wrong expert instead of reading the code
- 🧩 **Multi-step reasoning** — no model could trace a 5-file dependency chain

> Full writeup: [I Built an Adversarial Eval Framework and Attacked 5 LLMs](https://dev.to/saurav_bhattacharya/i-built-an-adversarial-eval-framework-and-attacked-5-llms-every-single-one-failed-1j81)

Run the benchmark yourself:

```bash
GROQ_API_KEY=your-key npx tsx examples/mega-adversarial.ts
# Or test a different model:
MODEL=qwen/qwen3-32b GROQ_API_KEY=your-key npx tsx examples/mega-adversarial.ts
```

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
      assertions: [
        toContain('function'),
        toMatch(/:\s*string/),
        toContain('reverse'),
      ],
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
  toNotRepeat, toNotBeStale,
  toPassJudge, BUILTIN_RUBRICS, LLMJudgeBackend,
} from 'agent-eval';

// 1. Define tools the agent can use
const readFile = defineTool('read_file')
  .describe('Read a file')
  .param('path', 'string', 'File path', true)
  .execute(async (args) => fs.readFileSync(args.path as string, 'utf-8'));

// 2. Create the agent provider (runs an agentic loop with tool calls)
const provider = new AgentProvider({
  llm: {
    type: 'groq',  // or 'gemini', 'azure-openai', 'openrouter'
    apiKey: process.env.GROQ_API_KEY!,
    model: 'llama-3.3-70b-versatile',
  },
  tools: [readFile],
  systemPrompt: 'You are a security auditor.',
  maxIterations: 8,
});

// 3. Run the agent
const result = await provider.run('Review auth.ts for security issues and fix them.');

// 4. Evaluate with all 3 tiers
const judge = new LLMJudgeBackend({
  type: 'groq',
  apiKey: process.env.GROQ_API_KEY!,
  model: 'llama-3.3-70b-versatile',
});

const tieredResult = await runTiered(result.output, [
  // Tier 1 — Deterministic (free, instant)
  tier1(toBeNonEmpty()),
  tier1(toNotBeAbandoned(result.timeline)),
  tier1(toHaveMeaningfulDiff(originalCode)),

  // Tier 2 — Heuristic (cheap, milliseconds)
  tier2(toContainKeywords(['hashing', 'bcrypt', 'salt'])),
  tier2(toNotRepeat()),
  tier2(toNotBeStale(result.timeline)),

  // Tier 3 — Model-as-Judge ($$$, seconds)
  tier3(toPassJudge(judge, BUILTIN_RUBRICS.codeReview())),
]);

console.log(tieredResult.passed ? '✅ PASS' : '❌ FAIL');
// Ran: 7, Tier 1: 3/3, Tier 2: 3/3, Tier 3: 1/1
```

### Agent Run Result

`AgentProvider.run()` returns a full trace:

```typescript
const result = await provider.run(prompt);

result.output;        // Final agent response
result.turns;         // Array of { index, content, toolCalls[], durationMs, finishReason }
result.timeline;      // { startedAt, endedAt, events[] } — for staleness/abandonment checks
result.totalTokens;   // { prompt, completion, total }
result.stopReason;    // 'complete' | 'max_iterations' | 'max_duration' | 'error'
result.durationMs;    // Total wall-clock time
```

## Tiered Runner (Cost Pyramid)

Run assertions in tier order with automatic short-circuiting. If Tier 1 fails, Tier 2+3 never run — saving time and money.

```typescript
import { runTiered, tier1, tier2, tier3 } from 'agent-eval';

const result = await runTiered(output, [
  tier1(toBeValidJson()),
  tier1(toBeNonEmpty()),
  tier2(toContainKeywords(topics)),
  tier2(toNotRepeat()),
  tier3(toPassJudge(backend, rubric)),
]);

if (!result.passed) {
  console.log(`Caught at Tier ${result.failedAtTier} — saved $$$`);
}
```

Options:

| Option | Default | Description |
|--------|---------|-------------|
| `shortCircuit` | `true` | Stop on first failure within a tier |
| `skipTier3` | `false` | Never run Tier 3 (cost control) |
| `runAllTiers` | `false` | Run all tiers even if earlier ones fail |
| `maxAssertions` | unlimited | Cap total assertions run (cost cap) |

## Providers

### AgentProvider

Full agentic loop with tool execution and timeline capture.

```typescript
const provider = new AgentProvider({
  llm: { type: 'groq', apiKey: '...', model: 'llama-3.3-70b-versatile' },
  tools: [readFile, writeFile],
  systemPrompt: 'You are a helpful assistant.',
  maxIterations: 10,       // Max tool call rounds (default: 10)
  maxDurationMs: 120000,   // Timeout (default: 120s)
});
```

**Supported LLM backends:**

| Backend | Type | Auth |
|---------|------|------|
| **Groq** | `'groq'` | `apiKey` |
| **Google Gemini** | `'gemini'` | `apiKey` |
| **Azure OpenAI** | `'azure-openai'` | `endpoint` + `apiKey` + `deployment` |
| **OpenRouter** | `'openrouter'` | `apiKey` |

### Tool Builder

```typescript
const tool = defineTool('search')
  .describe('Search the codebase')
  .param('query', 'string', 'Search query', true)
  .param('limit', 'number', 'Max results', false)
  .execute(async (args) => {
    return searchIndex(args.query as string, args.limit as number);
  });
```

### LocalProvider

Test against saved outputs (no API calls):

```typescript
const provider = new LocalProvider({
  outputs: { 'prompt A': 'output A', 'prompt B': 'output B' },
  defaultOutput: 'fallback',
  substringMatch: true,
});
```

### AzureOpenAIProvider

Single-shot completions (no tool loop):

```typescript
const provider = new AzureOpenAIProvider({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
  apiKey: process.env.AZURE_OPENAI_API_KEY!,
  deployment: 'gpt-4o',
});
```

## LLM Judge (Tier 3)

### Built-in Rubrics

```typescript
import { BUILTIN_RUBRICS } from 'agent-eval';

BUILTIN_RUBRICS.codeReview();     // Actionability, Accuracy, Completeness
BUILTIN_RUBRICS.taskCompletion(); // Relevance, Completeness, Quality, Depth
```

### Custom Rubrics

```typescript
import { buildRubric } from 'agent-eval';

const rubric = buildRubric('Security Audit Quality')
  .describe('Evaluates security review thoroughness')
  .passAt(0.7)
  .criterion('severity-classification', 'Are vulnerabilities correctly classified?')
    .level(1, 'Wrong', 'Misclassifies severity (critical as low, etc.)')
    .level(3, 'Partial', 'Some correct, some misclassified')
    .level(5, 'Accurate', 'All vulnerabilities correctly classified')
    .weight(0.5)
    .done()
  .criterion('remediation', 'Are fixes provided and correct?')
    .level(1, 'None', 'No fixes suggested')
    .level(3, 'Partial', 'Some fixes, but incomplete or incorrect')
    .level(5, 'Complete', 'Correct, actionable fixes for all issues')
    .weight(0.5)
    .done()
  .build();
```

### LLM Judge Backend

```typescript
import { LLMJudgeBackend } from 'agent-eval';

const judge = new LLMJudgeBackend({
  type: 'groq',          // 'groq' | 'openrouter' | 'openai'
  apiKey: '...',
  model: 'llama-3.3-70b-versatile',
  temperature: 0,         // Deterministic judging (default: 0)
  maxRetries: 2,           // Retries on parse failure (default: 2)
});
```

### Consensus & Adversarial Judging

Reduce non-determinism and positivity bias:

```typescript
import { toPassConsensusJudge, toPassAdversarialJudge } from 'agent-eval';

// Multi-sample median (stable scores)
toPassConsensusJudge(backend, rubric, { samples: 5 })

// Weakness-first, strict scoring, anti-injection
toPassAdversarialJudge(backend, rubric)
```

### Judge Calibration & Drift

Validate your judge against known ground truth:

```typescript
import { calibrate, buildCalibrationSet, detectDrift } from 'agent-eval';

const calSet = buildCalibrationSet('My Calibration', 'Code Review')
  .example('Good review')
    .output('The auth module has a SQL injection on line 42...')
    .task('Review for security')
    .scores({ actionability: 4, accuracy: 5 })
    .verdict('pass')
    .done()
  .example('Vague review')
    .output('Looks good overall.')
    .task('Review for security')
    .scores({ actionability: 1, accuracy: 2 })
    .verdict('fail')
    .done()
  .build();

const report = await calibrate(backend, rubric, calSet);
if (!report.calibrated) {
  console.warn(`Judge unreliable! Bias: ${report.bias}`);
}
```

## Assertions Reference

### Tier 1 — Deterministic

| Assertion | Description |
|-----------|-------------|
| `toContain(str)` | Output contains substring |
| `toMatch(regex)` | Output matches pattern |
| `toEqual(str)` | Exact string match |
| `notToContain(str)` | Does NOT contain substring |
| `notToMatch(regex)` | Does NOT match pattern |
| `toBeValidJson()` | Valid JSON |
| `toBeNonEmpty()` | Non-empty output |
| `toHaveMinLength(n)` / `toHaveMaxLength(n)` | Length bounds |
| `toStartWith(str)` / `toEndWith(str)` | Prefix/suffix |
| `toMatchJsonSchema(schema)` | JSON schema validation |
| `toHaveMarkdownStructure(opts)` | Markdown heading/section checks |
| `toHaveValidUrls()` | URL format validation |
| `toHaveValidPaths()` | File path validation |
| `toHaveMeaningfulDiff(before)` | Non-trivial changes from original |
| `toNotBeAbandoned(timeline)` | Agent didn't crash/timeout |
| `toCompleteWithinTimeout(timeline, ms)` | Finished within time limit |
| `custom(name, fn)` | Custom assertion function |

### Tier 2 — Heuristic

| Assertion | Description |
|-----------|-------------|
| `toNotRepeat()` | Repetition/loop detection |
| `toNotBeSaturated()` | N-gram saturation check |
| `toNotBeStale(timeline)` | Progress staleness detection |
| `toContainKeywords(keywords)` | Required-keyword presence |

### Tier 3 — Model-as-Judge

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

## Example: Full Pipeline

See [`examples/agent-eval-live.eval.ts`](examples/agent-eval-live.eval.ts) for a complete working example that:

1. Defines simulated `read_file` and `write_file` tools
2. Runs a security audit agent against Groq/Llama 3.3 70B
3. Evaluates with all 3 tiers including LLM-as-judge
4. Reports results with the terminal reporter

```bash
GROQ_API_KEY=*** npx tsx examples/agent-eval-live.eval.ts
```

Example output:

```
Security audit agent — live evaluation
  ✓ finds and fixes hardcoded credentials (1564ms)

  1 passed (1566ms)

=== Running tiered evaluation on live agent ===
Agent completed in 1429ms
Turns: 3, Stop reason: complete
Tokens: 1769 total

=== Tiered Results ===
Overall: ✅ PASS
Ran: 7, Skipped: 0
Duration: 1544ms
  Tier 1: 3/3 passed
  Tier 2: 3/3 passed
  Tier 3: 1/1 passed
```

## CI Quality Gate (GitHub Action)

Most autonomous agents running in CI only have one built-in check: *did the
process exit 0?* That catches a crash, but not a stale run, an empty review, or
output that wandered off the task. The action adapter turns the production
monitoring scorecard into a **pass/fail gate** a workflow can block on — and it
is deterministic and offline (Tier 1 + Tier 2 only, **no model-as-judge**), so
it adds no API cost or flake.

It projects a `Scorecard` into the three shapes a GitHub Action consumes: step
outputs (`eval_passed`, `eval_score`, `eval_evidence`, …), a Markdown step
summary, and an exit code.

```typescript
import { runActionEval, emitActionResult } from 'agent-eval';

// Score the transcripts an agent wrote, over a rolling window, then gate the job.
const { evaluation } = runActionEval('./transcripts', {
  window: 7,          // score the last 7 days of runs
  gate: 'watch',      // healthy/watch pass; at-risk/critical fail the step
  minScore: 0.6,      // also require a fleet mean-score floor (optional)
});

// Writes outputs + step summary to the runner (a no-op locally), returns 0/1.
process.exitCode = emitActionResult(evaluation);
```

The decision is pure and separately testable (`evaluateForAction`), the file
effects are isolated behind an injectable writer (`createEnvWriter` for a real
runner, `createMemoryWriter` for tests), and the gate can be scoped to specific
workers (`gateWorkers`) or relaxed for agents that legitimately have nothing to
evaluate (`noData: 'pass' | 'fail' | 'ignore'`).

| Knob | Meaning |
|------|---------|
| `gate` | Worst health grade that still passes: `healthy` \| `watch` \| `at-risk` \| `critical` |
| `minScore` | Optional fleet mean-score floor in `[0, 1]` |
| `gateWorkers` | Restrict the gate to specific workers (others are reported but never fail) |
| `noData` | How to treat workers with no evaluable runs (default: `pass`) |
| `window` | Rolling window (days) of transcripts to score |

See [`examples/ci-eval.ts`](examples/ci-eval.ts) for a runnable CI entry point
and [`examples/github-action-eval.yml`](examples/github-action-eval.yml) for a
full workflow that gates a PR on agent output quality.

#### Verifying claims against ground truth

Every check above reads the *transcript* — so none can catch a transcript that
is simply wrong about its own run (the `pass` an agent wrote over a run that
actually crashed). When you have a **trusted** record of the run from the
orchestrator (cron/process status, measured wall-clock), pass it as
`runMetadata` and the scorer adds a Tier-1 `verification` check that grades the
self-report against it:

```typescript
import { scoreTranscript } from 'agent-eval';

const score = scoreTranscript(transcript, {
  runMetadata: { exitStatus: 'error', durationMs: 5_520_000 },
});
// verification → fail: "claims pass but orchestrator recorded error"
//                      + self-reported duration disagrees with measured
```

It flags three unfakeable mismatches: a finished outcome that contradicts the
trusted exit status (hard fail), a transcript that reports done while the run is
still running (warn), and a self-reported duration that disagrees with the
measured wall-clock (warn). With no `runMetadata` the check **skips** — zero
behavior change. A transcript export tool can emit this metadata directly
alongside the transcript, making the capture → transcript → eval path
self-verifying end to end.

| `RunMetadata` field | Meaning |
|------|---------|
| `exitStatus` | Trusted run status: `ok` \| `error` \| `timeout` \| `killed` \| `running` |
| `exitCode` | Process exit code when known (`0` == success) |
| `startedAt` / `endedAt` | Trusted wall-clock (ISO-8601 or epoch ms); absent `endedAt` ⇒ still running |
| `durationMs` | Trusted measured duration; else derived from start/end |

### Evaluating a single run (one PR / one issue)

The scorecard gate above answers *"how healthy is the fleet?"* over a window of
transcripts. Often a CI step has a narrower question with the inputs to answer
it directly: **"did the agent address THIS prompt?"** — for one PR review, one
issue triage, one change. `evaluateCiRun` scores a single `{ prompt, output }`
pair and returns the **same** `ActionEvaluation` shape, so it drops straight
into `emitActionResult`:

```typescript
import { evaluateCiRun, emitActionResult } from 'agent-eval';

const { evaluation } = evaluateCiRun({
  prompt: prTitle + '\n\n' + prBody,   // the task the agent was given
  output: claudeReviewComment,         // what it produced
  worker: 'claude-review',
});

process.exitCode = emitActionResult(evaluation);  // outputs + summary + exit
```

It runs two independent checks, no model-as-judge:

- **Completeness** (Tier 1) — is the output non-empty, substantive, and not a
  stub / truncated / refusal? The bytes are the bytes; the agent can't forge
  "non-empty".
- **Staleness** (Tier 1) — the *no-op* detector: did the run emit anything a
  human can **act on**? An output can be complete and perfectly on-topic and
  *still* say nothing useful — the review that sits stale
  with no actionable output, the check abandoned mid-task, the prior comment
  reposted verbatim. The detector counts *concrete actionable artifacts* the
  agent produced — file references, line numbers, code suggestions, actionable
  directives, structured findings — and flags bare acknowledgements ("LGTM"),
  truncation, verbatim reposts (pass `previousOutput`), and timeouts (pass a
  `timeline`). It is presence-counting over artifacts, never a quality
  judgement: it asks *"is there anything to act on?"*, never *"is it good?"* — so
  it stays Tier 1 (deterministic, forgery-resistant), not model-as-judge.

| Knob | Meaning |
|------|---------|
| `minActionableArtifacts` | Min distinct actionable-artifact kinds to pass staleness; below = thin/warn, zero on a non-trivial output = no-op/fail (default `2`) |
| `previousOutput` | The prior comment for this target; when set, a verbatim repost is flagged as a no-op |
| `timeline` | Optional run timeline (`startedAt`/`endedAt`/`timeoutMs`/`events`); folds in timeout / abandonment detection |
| `worker` | Logical name for the run (shown in outputs/summary; default `ci-run`) |
| `action` | `gate` / `minScore` / `noData` forwarded to the gate (default gate `watch`) |

Why these two checks, and why do they *both* matter? They catch genuinely
different failures and diverge in practice:

- Completeness sees structure: it fails the empty / stub / truncated / refusal
  output the bytes alone reveal.
- Staleness is orthogonal: an on-topic response that names every topic
  but contains no file ref, no code, no directive — *"this looks reasonable, nice
  work"* — **passes completeness**, yet **fails
  staleness** because there is nothing to act on. That is exactly the
  review-sits-stale / nothing-actionable mode a crash check (exit 0) can't see.

Either one failing trips the gate.

See [`examples/ci-single-run.ts`](examples/ci-single-run.ts) for a runnable
example (good review passes; an empty/stub output fails completeness; an
on-topic no-op fails on staleness alone).

### Wiring it to `claude-code-action`

Those same two checks plug directly into
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action):
its run writes a JSON execution log (the `execution_file` output) that already
contains the agent's final output and run timeline.
[`extractCcaRunFromFile`](src/action/cca-execution.ts) projects that file into
the `{ prompt, output, timeline }` `evaluateCiRun` expects, so a downstream CI
step can gate the job on *what the agent produced* — completeness and no-op
detection — with no model-as-judge and no extra API cost.

See [`docs/claude-code-action-integration.md`](docs/claude-code-action-integration.md)
for the exact seam (both an out-of-process downstream step and an in-process
cleanup-phase block) and [`examples/cca-execution-eval.ts`](examples/cca-execution-eval.ts)
for a runnable entry point.
[`examples/workflows/pr-review-with-eval.yml`](examples/workflows/pr-review-with-eval.yml)
is a complete, copy-pasteable PR-review workflow: it runs `claude-code-action`,
then gates the job on the eval step and branches a downstream step on
`eval_passed`.
[`docs/eval-layer-proposal.md`](docs/eval-layer-proposal.md) writes up the case
for this as an *optional* runtime eval layer — the reported failure modes it
targets, why the gate is deterministic-only, and the minimal opt-in shape.

## License

MIT
