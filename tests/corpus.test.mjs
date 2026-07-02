/**
 * corpus.test.mjs — the promotion funnel + scaffold, over a real trace fixture.
 *
 * Verifies:
 *   1. corpusScaffold() emits the scrub-discipline file set.
 *   2. promoteFromTriage() freezes the worst triaged run into a runnable .eval.mjs
 *      that carries provenance and the right structural assertions.
 */

import { readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseLangSmith } from '../dist/adapters/index.js';
import { triageBuilt } from '../dist/action/index.js';
import { corpusScaffold } from '../dist/corpus/scaffold.js';
import { promoteFromTriage } from '../dist/corpus/promote.js';

let failures = 0;
const ok = (cond, msg) => {
  if (cond) { console.log(`  \u2713 ${msg}`); }
  else { console.error(`  \u2717 ${msg}`); failures++; }
};

// ---- 1) scaffold ------------------------------------------------------------
const files = corpusScaffold();
const paths = files.map((f) => f.path);
for (const want of ['README.md', 'SCRUBBING.md', '.gitignore', 'cases/README.md', 'scripts/check-secrets.mjs', '.github/workflows/eval-gate.yml']) {
  ok(paths.includes(want), `scaffold includes ${want}`);
}
ok(files.find((f) => f.path === '.gitignore').content.includes('raw/*'), 'gitignore blocks raw/ traces');
ok(files.find((f) => f.path === 'scripts/check-secrets.mjs').content.includes('sk-'), 'scanner checks for OpenAI-style keys');
ok(!!files.find((f) => f.path === 'package.json'), 'scaffold includes package.json (so cases can resolve agent-eval)');
ok(files.find((f) => f.path === 'package.json').content.includes('"agent-eval"'), 'package.json depends on agent-eval');
ok(files.find((f) => f.path === '.github/workflows/eval-gate.yml').content.includes('npm install'), 'CI gate installs deps before running cases');

// ---- 2) promotion funnel ----------------------------------------------------
const OUT = join('tests', '_corpus_tmp');
rmSync(OUT, { recursive: true, force: true });

const text = readFileSync(join('tests', 'fixtures', 'wild', 'langsmith-export.real-schema.json'), 'utf8');
const sessions = parseLangSmith(text);
const report = triageBuilt(sessions, { dollarsPerMillionTokens: 9, costlyTokenThreshold: 100_000 });

ok(report.rows.length >= 1, `triage flagged at least one run (got ${report.rows.length})`);

const promoted = promoteFromTriage(sessions, report, { outDir: OUT, top: 2, importFrom: 'agent-eval' });
ok(promoted.length >= 1, `promoted at least one case (got ${promoted.length})`);
ok(promoted.length <= 2, 'respected --top cap of 2');

const worst = promoted[0];
ok(worst.kind === report.rows[0].kind, `worst promoted case matches top triage row kind (${worst.kind})`);
ok(existsSync(worst.file), 'promoted case file exists on disk');

const body = readFileSync(worst.file, 'utf8');
ok(body.includes(`sourceTraceId : ${worst.sourceId}`), 'case carries sourceTraceId provenance');
ok(body.includes(`failureKind   : ${worst.kind}`), 'case carries failureKind provenance');
ok(body.includes('EXPECTED TO FAIL'), 'case documents it is a red-until-fixed incident');
ok(body.includes('from "agent-eval"'), 'case imports the engine by package name for a client corpus');
ok(readdirSync(OUT).every((f) => f.startsWith('regression-') && f.endsWith('.eval.mjs')), 'all outputs are regression-*.eval.mjs');

// The failure kind determines the gating strategy:
//   - no-final-answer (abandoned/stalled) -> assert a real answer exists
//   - resource/error (timeout/runaway/errored) -> gate on a frozen incident flag,
//     NOT the replayed text (which may be non-empty partial output).
if (worst.kind === 'abandoned' || worst.kind === 'stalled') {
  ok(body.includes('toHaveMinLength(1)'), 'no-answer case asserts a non-empty final answer (structural, Tier 1)');
} else {
  ok(body.includes('INCIDENT_RESOLVED = false'), 'resource/error case is red-by-construction via a frozen incident flag');
  ok(!body.includes('toHaveMinLength(1),'), 'resource/error case does NOT green-wash on replayed non-empty output');
}

// ---- 3) anti-green-washing: a timeout with PARTIAL output must stay red -------
// (the exact regression a reviewer caught: replaying non-empty partial text as
//  success would flip a resource failure green on promotion.)
const OUT2 = join('tests', '_corpus_tmp2');
rmSync(OUT2, { recursive: true, force: true });
const partialMeta = {
  sessionId: 'partial-timeout', label: 'scrape a big site', cwd: null,
  tokenUsage: 900_000, msgTokenMax: 0, trajTokenTotal: 0, hadTrajectory: false,
  runtimeMs: 1, eventCount: 1, assistantCount: 1, errorEvents: 0,
  sawAborted: false, cleanStop: false, idleTimeoutErr: false, trajIdle: false,
  trajAborted: false, trajTimedOut: true, trajExternalAbort: false,
  trajFinalStatus: null, trajError: false, abortedAny: true, endedCleanly: false,
  lastType: null, lastRole: null,
  allAssistantText: 'Working... step 1 done... step 2 in progress...', source: 'trajectory',
};
const partialSessions = [{ timeline: { events: [] }, meta: partialMeta }];
const partialReport = {
  scanned: 1, flagged: 1, costly: 1, costlyTokens: 900_000, projectedCostUsd: 8.1,
  dollarsPerMillionTokens: 9,
  rows: [{ id: 'partial-timeout', label: partialMeta.label, kind: 'timeout', issueKinds: [], tokenUsage: 900_000, projectedCostUsd: 8.1, summary: 'timeout' }],
};
const [partialCase] = promoteFromTriage(partialSessions, partialReport, { outDir: OUT2, top: 1, importFrom: 'agent-eval' });
const partialBody = readFileSync(partialCase.file, 'utf8');
ok(/const CAPTURED_OUTPUT = "[^"]+"/.test(partialBody), 'partial-timeout replayed a NON-empty output (the trap)');
ok(partialBody.includes('INCIDENT_RESOLVED = false'), 'partial-timeout still gates on the frozen incident flag');
ok(partialBody.includes('SOURCE_WASTED_TOKENS = 900000'), 'partial-timeout freezes the real measured burn');
ok(!partialBody.includes('produced a usable final answer'), 'partial-timeout does NOT use the non-empty-output check that would pass');
rmSync(OUT2, { recursive: true, force: true });

// cleanup
rmSync(OUT, { recursive: true, force: true });

if (failures === 0) {
  console.log(`\n[corpus] ALL ASSERTIONS PASSED \u2705 \u2014 promotion funnel + scaffold work over a real trace`);
  process.exit(0);
} else {
  console.error(`\n[corpus] ${failures} assertion(s) FAILED \u274c`);
  process.exit(1);
}
