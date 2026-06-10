/**
 * Manual smoke runner for the historical scorer (Phase 3.5).
 *
 * Scores every transcript under the real workspace transcripts root WITHOUT
 * persisting, and prints a per-worker summary. Run with:
 *
 *   npx tsx scripts/smoke-scorer.ts
 *   (or) node --import tsx scripts/smoke-scorer.ts
 */

import { scoreHistory } from '../src/monitoring/score-runner.js';

const root =
  process.argv[2] ?? 'C:\\Users\\onlin\\.openclaw\\workspace\\transcripts';

const result = scoreHistory(root, { persist: false });

console.log(`Discovered: ${result.discovered}, scored: ${result.scored}, failed: ${result.failed}`);
if (result.errors.length > 0) {
  console.log('Errors:');
  for (const e of result.errors) console.log(`  ${e.path}: ${e.error}`);
}

// Aggregate per worker.
const byWorker = new Map<
  string,
  { n: number; overall: number; fails: number; warns: number; skips: number }
>();
for (const s of result.scores) {
  const agg = byWorker.get(s.worker) ?? { n: 0, overall: 0, fails: 0, warns: 0, skips: 0 };
  agg.n += 1;
  agg.overall += Number.isFinite(s.overall) ? s.overall : 0;
  agg.fails += s.failCount;
  agg.warns += s.warnCount;
  agg.skips += s.checks.filter((c) => c.status === 'skip').length;
  byWorker.set(s.worker, agg);
}

console.log('\nPer-worker average overall score:');
for (const [worker, agg] of [...byWorker.entries()].sort()) {
  const avg = (agg.overall / agg.n).toFixed(3);
  console.log(
    `  ${worker.padEnd(16)} runs=${String(agg.n).padStart(2)}  avg=${avg}  fails=${agg.fails}  warns=${agg.warns}  skips=${agg.skips}`,
  );
}

// Show a couple of full rows for eyeballing.
console.log('\nSample (newest 2 transcripts):');
for (const s of result.scores.slice(0, 2)) {
  console.log(`\n  ${s.worker}/${s.runId}  outcome=${s.reportedOutcome}  overall=${s.overall.toFixed(3)}`);
  for (const c of s.checks) {
    console.log(`    [${c.status.padEnd(4)}] ${c.check.padEnd(16)} score=${c.score.toFixed(2)}  ${c.summary}`);
  }
}
