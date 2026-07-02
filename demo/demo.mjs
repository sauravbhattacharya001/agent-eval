/**
 * demo.mjs — the 3-minute client demo, end to end, offline (no API key).
 *
 * Story:
 *   1. Three production trace files, three different tools/formats.
 *   2. ONE triage pass ingests all of them → ranked table of wasted spend + failure mode.
 *   3. Promote the single worst run into a permanent, runnable regression case.
 *   4. That case now lives in the suite forever — the loop is closed.
 *
 * Run:  npm run build && node demo/demo.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseOtlp, parseLangSmith, parseAgentLens,
  triageBuilt, renderTriageTable,
} from '../dist/index.js';

const TRACES = [
  { file: 'otlp-trace.real-schema.json',       format: 'otlp',       parse: parseOtlp,       tool: 'OpenTelemetry (Phoenix / Traceloop / OpenLLMetry)' },
  { file: 'langsmith-export.real-schema.json',  format: 'langsmith',  parse: parseLangSmith,  tool: 'LangSmith / LangGraph' },
  { file: 'agentlens-export.real-schema.json',  format: 'agentlens',  parse: parseAgentLens,  tool: 'AgentLens' },
];

const OPTS = { dollarsPerMillionTokens: 9, costlyTokenThreshold: 100_000 };
const bar = (c = '─') => c.repeat(64);

console.log('\n' + bar('═'));
console.log(' agent-eval — unified trace triage demo');
console.log(bar('═'));

// ── STEP 1+2: ingest every format into ONE triage pass ───────────────────────
console.log('\n[1] Three teams, three trace formats. Ingesting all of them:\n');
const allSessions = [];
for (const t of TRACES) {
  const text = readFileSync(join('demo', 'traces', t.file), 'utf8');
  const sessions = t.parse(text);
  allSessions.push(...sessions);
  console.log(`    ✓ ${t.tool}`);
  console.log(`        ${t.file} → ${sessions.length} sessions`);
}

console.log('\n[2] ONE deterministic triage pass over all ' + allSessions.length + ' sessions');
console.log('    (no API key, no model — Tier 1 proof the agent can\'t forge):\n');
const report = triageBuilt(allSessions, { ...OPTS, staleOnly: false });
console.log(renderTriageTable(report, 15));
console.log(`\n    Projected waste across flagged runs: $${report.projectedCostUsd.toFixed(0)}`);
console.log(`    Breakdown by failure kind: ${JSON.stringify(report.byKind)}`);

// ── STEP 3: promote the worst run into a real regression case ────────────────
console.log('\n' + bar());
console.log('[3] Promote the WORST run into a permanent regression case.');
console.log(bar());
const worst = report.rows[0];
if (!worst) {
  console.log('\n    Fleet is clean — nothing to promote. (In prod, this is the good day.)');
  process.exit(0);
}
// Find which source file that worst run came from, to feed the promoter.
const owner = TRACES.find((t) => t.parse(readFileSync(join('demo', 'traces', t.file), 'utf8'))
  .some((s) => s.meta.sessionId === worst.id));
console.log(`\n    Worst offender: ${worst.id}  (${worst.kind}, ~$${worst.projectedCostUsd.toFixed(2)})`);
console.log(`    Source: ${owner.tool}\n`);

const promoteOut = execFileSync(process.execPath,
  ['demo/promote.mjs', join('demo', 'traces', owner.file), owner.format],
  { encoding: 'utf8' });
console.log(promoteOut.split('\n').map((l) => '    ' + l).join('\n'));

// ── STEP 4: prove the case is real by running the suite headlessly ───────────
console.log('\n' + bar());
console.log('[4] The frozen case is a REAL runnable eval. Running it now:');
console.log(bar() + '\n');
console.log('    (It replays the ORIGINAL bad output, so it FAILS on purpose —');
console.log('     that red IS the captured incident. Point the provider at your');
console.log('     fixed agent and it goes green.)\n');
try {
  const runOut = execFileSync(process.execPath,
    ['dist/cli/index.js', 'run', 'demo/goldens/'],
    { encoding: 'utf8', stdio: 'pipe' });
  console.log(runOut.split('\n').map((l) => '    ' + l).join('\n'));
} catch (e) {
  // Non-zero exit is EXPECTED (the replayed incident fails). Show its output.
  const out = (e.stdout || '') + (e.stderr || '');
  console.log(out.split('\n').map((l) => '    ' + l).join('\n'));
  console.log('    ↑ Expected red: the incident is now frozen as a test. Loop closed. ✅');
}

console.log('\n' + bar('═'));
console.log(' Recap: 3 formats → 1 triage pass → worst run → permanent eval case.');
console.log(' AgentLens records it · agent-eval grades it · adapters read any stack.');
console.log(bar('═') + '\n');
