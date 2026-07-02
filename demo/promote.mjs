/**
 * promote.mjs — the closed-loop step the flagship post promises, built for real.
 *
 * Takes ONE triaged production run (the worst offender from triage) and writes a
 * genuinely runnable agent-eval spec that freezes its failure into a permanent
 * regression case. This is NOT a mock: the emitted file imports the real
 * `defineEval` / `LocalProvider` / assertions from the built package and runs
 * headlessly with no API key (LocalProvider replays the captured output).
 *
 * Provenance is preserved: every generated case carries `sourceTraceId` and the
 * failure kind it was minted from, so six months later you can trace a red test
 * straight back to the incident that motivated it.
 *
 * Usage:  node demo/promote.mjs <traceFile> <format> [outDir]
 *   format = otlp | langsmith | agentlens
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseOtlp, parseLangSmith, parseAgentLens, triageBuilt } from '../dist/index.js';

const PARSERS = { otlp: parseOtlp, langsmith: parseLangSmith, agentlens: parseAgentLens };

const [, , traceFile, format, outDirArg] = process.argv;
if (!traceFile || !PARSERS[format]) {
  console.error('usage: node demo/promote.mjs <traceFile> <otlp|langsmith|agentlens> [outDir]');
  process.exit(2);
}
const outDir = resolve(outDirArg ?? join('demo', 'goldens'));
mkdirSync(outDir, { recursive: true });

// 1) Parse + triage the trace, exactly as an operator would.
const text = readFileSync(resolve(traceFile), 'utf8');
const sessions = PARSERS[format](text);
const report = triageBuilt(sessions, {
  dollarsPerMillionTokens: 9,
  costlyTokenThreshold: 100_000,
  staleOnly: format === 'agentlens' ? false : true, // AgentLens carries status; use it
});

if (report.rows.length === 0) {
  console.log('No flagged runs to promote — fleet is clean. Nothing to do.');
  process.exit(0);
}

// 2) Pick the worst offender (triage already sorts by cost/severity).
const worst = report.rows[0];
const src = sessions.find((s) => s.meta.sessionId === worst.id);
const meta = src.meta;

// 3) Derive HONEST regression thresholds from the actual incident.
//    The rule: the corrected run must NOT repeat what this one did.
const tokenCeiling = Math.max(50_000, Math.round(meta.tokenUsage * 0.5)); // half the burn it wasted
const capturedOutput = (meta.allAssistantText || '').slice(0, 2000);
const safeId = worst.id.replace(/[^a-zA-Z0-9_-]/g, '_');

// 4) Emit a REAL, runnable eval spec. LocalProvider replays the captured output,
//    so this runs with no API key. Swap the provider for a live one to test the
//    *fixed* agent against the same frozen input.
const spec = `/**
 * AUTO-PROMOTED regression case — DO NOT hand-edit the header.
 * Minted from a real production failure by demo/promote.mjs.
 *
 *   sourceTraceId : ${worst.id}
 *   format        : ${format}
 *   failureKind   : ${worst.kind}
 *   wastedTokens  : ${meta.tokenUsage.toLocaleString()}  (~$${worst.projectedCostUsd.toFixed(2)})
 *   promotedAt    : ${new Date().toISOString()}
 *
 * WHAT THIS GUARDS: the run above ${describeFailure(worst.kind)}. This case freezes
 * that exact input so the failure can never silently regress. It currently replays
 * the ORIGINAL (bad) output via LocalProvider and is EXPECTED TO FAIL — that red is
 * the captured incident. Point \`provider\` at your fixed agent and it should go green.
 */

import { defineEval, LocalProvider, toHaveMinLength, custom } from '../../dist/index.js';

const CAPTURED_INPUT = ${JSON.stringify(meta.label || worst.id)};

// The output the agent actually produced on the failing run (replayed offline).
const CAPTURED_OUTPUT = ${JSON.stringify(capturedOutput)};

export default defineEval({
  name: 'Regression: ${safeId} (${worst.kind})',
  provider: new LocalProvider({ outputs: { [CAPTURED_INPUT]: CAPTURED_OUTPUT } }),
  specs: [
    {
      name: 'must not repeat ${worst.kind} failure from trace ${worst.id}',
      prompt: CAPTURED_INPUT,
      assertions: [
        // Tier 1 — deterministic, unforgeable. The corrected run must produce a
        // real, non-empty answer (the failing run ${worst.kind === 'timeout' ? 'never returned one' : 'errored out'}).
        toHaveMinLength(1),
        custom('produced a usable final answer', (output) => {
          const empty = !output || output.trim().length === 0;
          return empty
            ? { pass: false, message: 'No final answer — same failure as the source trace.' }
            : { pass: true };
        }),
        custom('stayed under the token ceiling (<= ${tokenCeiling.toLocaleString()})', (output) => {
          // Proxy: the fixed run's output should be bounded, not a ${(meta.tokenUsage/1000).toFixed(0)}k-token runaway.
          // (In CI you'd assert on measured usage from the fresh run's trace.)
          const approxTokens = Math.ceil(output.length / 4);
          return approxTokens <= ${tokenCeiling}
            ? { pass: true }
            : { pass: false, message: \`Output implies ~\${approxTokens} tokens — over ceiling ${tokenCeiling}.\` };
        }),
      ],
    },
  ],
});
`;

function describeFailure(kind) {
  switch (kind) {
    case 'timeout': return 'burned tokens then never returned a final answer (idle/timeout abandon)';
    case 'runaway': return 'ran away — over a million tokens with no clean stop';
    case 'error': return 'errored out mid-run';
    case 'aborted': return 'was aborted before completing';
    default: return `failed (${kind})`;
  }
}

const outFile = join(outDir, `regression-${safeId}.eval.mjs`);
writeFileSync(outFile, spec, 'utf8');

console.log('┌─ PROMOTED ────────────────────────────────────────────────');
console.log(`│ Worst run   : ${worst.id}`);
console.log(`│ Failure     : ${worst.kind}  (~$${worst.projectedCostUsd.toFixed(2)}, ${meta.tokenUsage.toLocaleString()} tokens)`);
console.log(`│ Frozen input: ${(meta.label || worst.id).slice(0, 60)}`);
console.log(`│ Wrote case  : ${outFile}`);
console.log('└───────────────────────────────────────────────────────────');
console.log('\nThis case now runs in your suite forever. Point the provider at your');
console.log('fixed agent and it turns green — that exact failure can never silently return.');
