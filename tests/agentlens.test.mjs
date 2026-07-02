import { readFileSync } from 'node:fs';
import { parseAgentLens, triageAgentLens, renderTriageTable } from '../dist/index.js';

const text = readFileSync(new URL('./fixtures/wild/agentlens-export.real-schema.json', import.meta.url), 'utf8');

const sessions = parseAgentLens(text);
console.log('PARSED SESSIONS:', sessions.length, '(expect 3)');
for (const s of sessions) {
  console.log(`  ${s.meta.sessionId}  clean=${s.meta.endedCleanly}  tok=${s.meta.tokenUsage}  timeout=${s.meta.trajTimedOut}  aborted=${s.meta.abortedAny}  rtMs=${s.meta.runtimeMs}  err=${s.meta.errorEvents}`);
}

console.log('\n================ TRIAGE (real AgentLens SDK export) ================');
// AgentLens encodes failure in `status` (active/completed/error) + `ended_at`, which
// is richer than raw-timeline gaps. So its natural triage mode is staleOnly:false —
// that consumes AgentLens's own status verdict via !endedCleanly. (staleOnly:true is
// tuned for OpenClaw's gap-based timelines and would ignore status-level abandonment.)
const report = triageAgentLens(text, { dollarsPerMillionTokens: 9, costlyTokenThreshold: 100_000, staleOnly: false });
console.log(renderTriageTable(report, 10));
console.log('\nscanned:', report.scanned, '| flagged:', report.flagged, '| costly:', report.costly);
console.log('byKind:', JSON.stringify(report.byKind));

let fails = 0;
const assert = (cond, msg) => { if (!cond) { console.log('  ✗ FAIL:', msg); fails++; } else { console.log('  ✓', msg); } };
console.log('\n================ ASSERTIONS ================');
const byId = Object.fromEntries(sessions.map(s => [s.meta.sessionId, s.meta]));
assert(sessions.length === 3, '3 AgentLens sessions parsed');
assert(byId['als-clean-001'] && byId['als-clean-001'].endedCleanly === true, 'completed session is clean');
assert(byId['als-clean-001'].tokenUsage === 4200, 'clean tokens from stats = 4200');
assert(byId['als-clean-001'].runtimeMs === 12500, 'clean runtime from stats.session_duration_ms = 12500ms');
assert(byId['als-timeout-002'] && byId['als-timeout-002'].trajTimedOut === true, 'active/never-ended session flagged timeout');
assert(byId['als-timeout-002'].tokenUsage === 1250000, 'timeout tokens = 1.25M');
assert(byId['als-error-003'] && byId['als-error-003'].errorEvents >= 1 && byId['als-error-003'].abortedAny === true, 'error session flagged');
assert(report.byKind.timeout >= 1, 'timeout kind present (never-ended active session)');
const worst = report.rows[0];
assert(worst && worst.kind === 'timeout' && worst.tokenUsage === 1250000, 'worst row = 1.25M timeout');
assert(report.rows.every(r => r.projectedCostUsd > 0), 'every flagged row priced');
assert(report.flagged === 2, 'both broken sessions flagged (timeout + errored); clean one passes');
assert(report.rows.some(r => r.id === 'als-error-003'), 'errored session present');

console.log(fails === 0 ? '\nALL ASSERTIONS PASSED ✅ — AgentLens adapter works on real SDK-emitted export' : `\n${fails} FAILED ❌`);
process.exit(fails === 0 ? 0 : 1);
