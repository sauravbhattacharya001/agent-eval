import { readFileSync } from 'node:fs';
import { parseOtlp, triageOtlp, renderTriageTable } from '../dist/index.js';

const text = readFileSync(new URL('./fixtures/wild/otlp-trace.real-schema.json', import.meta.url), 'utf8');

const sessions = parseOtlp(text);
console.log('PARSED SESSIONS:', sessions.length, '(expect 3 conversations from 5 spans)');
for (const s of sessions) {
  console.log(`  ${s.meta.sessionId}  clean=${s.meta.endedCleanly}  tok=${s.meta.tokenUsage}  timeout=${s.meta.trajTimedOut}  aborted=${s.meta.abortedAny}  err=${s.meta.errorEvents}`);
}

console.log('\n================ TRIAGE (real OTel SDK export) ================');
const report = triageOtlp(text, { dollarsPerMillionTokens: 9, costlyTokenThreshold: 100_000 });
console.log(renderTriageTable(report, 10));
console.log('\nscanned:', report.scanned, '| flagged:', report.flagged, '| costly:', report.costly);
console.log('byKind:', JSON.stringify(report.byKind));

let fails = 0;
const assert = (cond, msg) => { if (!cond) { console.log('  ✗ FAIL:', msg); fails++; } else { console.log('  ✓', msg); } };
console.log('\n================ ASSERTIONS ================');
assert(sessions.length === 3, '3 sessions grouped by gen_ai.conversation.id');
const byId = Object.fromEntries(sessions.map(s => [s.meta.sessionId, s.meta]));
assert(byId['conv-a'] && byId['conv-a'].endedCleanly === true, 'conv-a clean');
assert(byId['conv-b'] && byId['conv-b'].trajTimedOut === true, 'conv-b flagged timeout (finish_reason=length)');
assert(byId['conv-b'] && byId['conv-b'].tokenUsage === 1250000, 'conv-b tokens summed = 1.25M');
assert(byId['conv-c'] && byId['conv-c'].abortedAny === true && byId['conv-c'].errorEvents >= 1, 'conv-c flagged (tool exception)');
assert(report.flagged === 1, 'under staleOnly default, 1 stale run flagged (conv-b timeout); conv-a clean, conv-c errored-but-ended');
assert(report.byKind.timeout >= 1, 'timeout kind present');
const worst = report.rows[0];
assert(worst && worst.kind === 'timeout' && worst.tokenUsage === 1250000, 'worst row = the 1.25M timeout');
assert(report.rows.every(r => r.projectedCostUsd > 0), 'every flagged row priced');

// With staleOnly:false, the errored-but-finished tool run (conv-c) also surfaces.
const full = triageOtlp(text, { dollarsPerMillionTokens: 9, costlyTokenThreshold: 100_000, staleOnly: false });
assert(full.flagged === 2, 'staleOnly:false surfaces conv-c too (2 flagged)');
assert(full.rows.some(r => r.id === 'conv-c'), 'conv-c present when staleOnly:false');

// ---- tool-call signatures now carry the semantic tool name + args (OTel GenAI) ----
console.log('\n--- tool-call signatures ---');
for (const s of sessions) {
  if (s.meta.toolCallSignatures.length) console.log(`  ${s.meta.sessionId}:`, JSON.stringify(s.meta.toolCallSignatures));
}
const sigA = (byId['conv-a']?.toolCallSignatures) ?? [];
assert(sigA.some(x => x.startsWith('send_email(')), 'conv-a tool sig uses gen_ai.tool.name (send_email), not the raw span name');
assert(sigA.some(x => x.includes('ops@example.com') && x.includes('deploy done')), 'conv-a tool sig includes the recorded arguments (gen_ai.tool.call.arguments)');
const sigC = (byId['conv-c']?.toolCallSignatures) ?? [];
assert(sigC.length === 0, 'conv-c web_search threw (exception event) -> recorded as an ERROR, not a tool-loop signature');
assert(byId['conv-c']?.errorEvents >= 1, 'conv-c surfaces via the error channel instead');

console.log(fails === 0 ? '\nALL ASSERTIONS PASSED ✅ — OTLP adapter works on real OTel-emitted spans' : `\n${fails} FAILED ❌`);
process.exit(fails === 0 ? 0 : 1);
