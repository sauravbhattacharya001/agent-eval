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
ok(body.includes('toHaveMinLength(1)'), 'case asserts a non-empty final answer (structural, Tier 1)');
ok(body.includes("from \"agent-eval\""), 'case imports the engine by package name for a client corpus');
ok(readdirSync(OUT).every((f) => f.startsWith('regression-') && f.endsWith('.eval.mjs')), 'all outputs are regression-*.eval.mjs');

// cleanup
rmSync(OUT, { recursive: true, force: true });

const total = 22;
if (failures === 0) {
  console.log(`\n[corpus] ALL ASSERTIONS PASSED \u2705 \u2014 promotion funnel + scaffold work over a real trace`);
  process.exit(0);
} else {
  console.error(`\n[corpus] ${failures} assertion(s) FAILED \u274c`);
  process.exit(1);
}
