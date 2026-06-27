
import { buildScorecard, formatScorecardMarkdown } from './dist/index.js';
import { writeFileSync, readFileSync } from 'node:fs';
const ROOT = process.env.AE_TRANSCRIPTS;
const calib = JSON.parse(readFileSync(process.env.AE_CALIB, 'utf8'));
const result = buildScorecard(ROOT, {
  window: 14,
  trendMetrics: ['score', 'durationMs', 'failRate'],
  persist: false,
  relevanceThreshold: calib.relThreshold,
  coverageThreshold: calib.covThreshold,
});
const sc = result.scorecard;
writeFileSync(process.env.AE_SCORECARD_MD, formatScorecardMarkdown(sc), 'utf8');
// Emit a HARD-checks snapshot: per worker, count of completeness/staleness fails.
const workers = (sc.workers ?? []).map((w) => {
  const cb = w.checks ?? [];
  const find = (n) => (Array.isArray(cb) ? cb.find((c) => (c.check ?? c.name) === n) : null);
  const comp = find('completeness'); const stale = find('staleness');
  const compFail = comp?.fails ?? comp?.fail ?? 0;
  const staleFail = stale?.fails ?? stale?.fail ?? 0;
  return {
    worker: w.worker,
    grade: String(w.grade ?? w.health ?? '').toLowerCase(),
    passRate: w.passRate ?? w.totals?.passRate ?? null,
    runs: w.runs ?? w.totals?.runs ?? null,
    hardFails: compFail + staleFail,
    completenessFail: compFail,
    stalenessFail: staleFail,
  };
});
const snap = {
  generatedAt: new Date().toISOString(),
  window: sc.window ?? null,
  fleet: { workers: sc.totals?.workers, runs: sc.totals?.runs, passRate: sc.totals?.passRate },
  workers,
};
console.log('SNAPSHOT_JSON_BEGIN');
console.log(JSON.stringify(snap));
console.log('SNAPSHOT_JSON_END');
