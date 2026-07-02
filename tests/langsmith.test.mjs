import { readFileSync } from 'node:fs';
import { parseLangSmith, triageLangSmith } from '../dist/index.js';
import { renderTriageTable } from '../dist/index.js';

const text = readFileSync(new URL('./fixtures/wild/langsmith-export.synthetic.json', import.meta.url), 'utf8');

const sessions = parseLangSmith(text);
console.log('PARSED SESSIONS:', sessions.length, '(expect 5 traces)');
for (const s of sessions) {
  console.log(`  ${s.meta.sessionId.slice(0,8)}  cleanly=${s.meta.endedCleanly}  tok=${s.meta.tokenUsage}  timeout=${s.meta.trajTimedOut}  aborted=${s.meta.abortedAny}  rtMs=${s.meta.runtimeMs}`);
}

console.log('\n================ TRIAGE ================');
const report = triageLangSmith(text, { dollarsPerMillionTokens: 9, costlyTokenThreshold: 200_000 });
console.log(renderTriageTable(report, 10));
console.log('\nscanned:', report.scanned, '| flagged:', report.flagged, '| costly:', report.costly);
console.log('byKind:', JSON.stringify(report.byKind));
console.log('projected $:', report.projectedCostUsd.toFixed(2));

// ---- assertions ----
let fails = 0;
const assert = (cond, msg) => { if (!cond) { console.log('  ✗ FAIL:', msg); fails++; } else { console.log('  ✓', msg); } };
console.log('\n================ ASSERTIONS ================');
assert(sessions.length === 4, '4 traces parsed (child runs share parent trace_id)');
assert(report.flagged === 2, '2 traces flagged as broken (2 clean pass)');
const kinds = report.rows.map(r => r.kind);
assert(kinds.includes('timeout'), 'timeout trace detected');
assert(report.byKind.timeout >= 1, 'byKind.timeout >= 1');
const worst = report.rows[0];
assert(worst && worst.tokenUsage === 1250000, 'worst row is the 1.25M-token timeout run (no double-count)');
assert(worst && worst.kind === 'timeout', 'worst row classified as timeout');
assert(report.rows.every(r => r.projectedCostUsd > 0), 'every flagged row has a $ cost');

console.log(fails === 0 ? '\nALL ASSERTIONS PASSED ✅' : `\n${fails} ASSERTION(S) FAILED ❌`);
process.exit(fails === 0 ? 0 : 1);
