/**
 * demo.mjs — the 2-minute client demo, end to end, offline (no API key).
 *
 * Story:
 *   1. Three production trace files, three different tools/formats.
 *   2. ONE triage pass ingests all of them → ranked report of wasted spend + failure mode.
 *   3. That report is the product. A human reads it and decides the fix.
 *
 * Run:  npm run build && node demo/demo.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// ── STEP 3: the report is the product — the human closes the loop ────────────
console.log('\n' + bar());
console.log('[3] That report is the deliverable. The loop is closed by a human.');
console.log(bar());
const worst = report.rows[0];
if (!worst) {
  console.log('\n    Fleet is clean — nothing flagged. (In prod, this is the good day.)');
  process.exit(0);
}
console.log(`\n    Worst offender: ${worst.id}  (${worst.kind}, ~$${worst.projectedCostUsd.toFixed(2)})`);
console.log('\n    agent-eval stops here, on purpose. It is post-hoc and report-only:');
console.log('    it never edits your agent and never blocks a build. A human reads');
console.log('    this, decides the fix (a code change or a prompt change), and feeds');
console.log('    it back to the agent — which emits new traces, and the loop continues.');
console.log('\n    The report is legible on purpose, so a human (or an agent) can act on it.');

console.log('\n' + bar('═'));
console.log(' Recap: 3 formats → 1 triage pass → one ranked, legible report.');
console.log(' agent-eval reports the process failures · a human decides the fix.');
console.log(bar('═') + '\n');
