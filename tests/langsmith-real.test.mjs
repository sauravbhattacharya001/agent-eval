import { readFileSync } from 'node:fs';
import { parseLangSmith, triageLangSmith, renderTriageTable } from '../dist/index.js';

const text = readFileSync(new URL('./fixtures/wild/langsmith-export.real-schema.json', import.meta.url), 'utf8');

const sessions = parseLangSmith(text);
console.log('PARSED SESSIONS:', sessions.length, '(expect 4 traces from 6 runs)');
for (const s of sessions) {
  console.log(`  ${s.meta.sessionId.slice(0,8)}  clean=${s.meta.endedCleanly}  tok=${s.meta.tokenUsage}  timeout=${s.meta.trajTimedOut}  aborted=${s.meta.abortedAny}  label="${s.meta.label.slice(0,40)}"`);
}

console.log('\n================ TRIAGE (SDK-generated export) ================');
const report = triageLangSmith(text, { dollarsPerMillionTokens: 9, costlyTokenThreshold: 200_000 });
console.log(renderTriageTable(report, 10));
console.log('\nscanned:', report.scanned, '| flagged:', report.flagged, '| costly:', report.costly);
console.log('byKind:', JSON.stringify(report.byKind));
console.log('projected $:', report.projectedCostUsd.toFixed(2));

let fails = 0;
const assert = (cond, msg) => { if (!cond) { console.log('  ✗ FAIL:', msg); fails++; } else { console.log('  ✓', msg); } };
console.log('\n================ ASSERTIONS ================');
assert(sessions.length === 4, '4 traces parsed from full-schema SDK export');
assert(report.flagged === 2, '2 traces flagged broken, 2 clean pass');
assert(report.byKind.timeout >= 1, 'timeout detected');
const worst = report.rows[0];
assert(worst && worst.tokenUsage === 1250000, 'worst row = 1.25M tokens, no double-count');
assert(worst && worst.kind === 'timeout', 'worst row classified timeout');
assert(report.rows.every(r => r.projectedCostUsd > 0), 'every flagged row priced');
// label must survive even with the full nested schema
assert(sessions.every(s => s.meta.label && s.meta.label !== '(no task line)'), 'every session got a real label from inputs');

console.log(fails === 0 ? '\nALL ASSERTIONS PASSED ✅ — adapter survives real SDK schema' : `\n${fails} FAILED ❌`);
process.exit(fails === 0 ? 0 : 1);
