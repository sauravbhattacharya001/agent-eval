/**
 * Weekly Scorecard — Phase 3.5 Production Monitoring
 *
 * The capstone of the monitoring pipeline. The scorer turns transcripts into
 * point-in-time {@link TranscriptScore}s; the trend detector turns those scores
 * into a *direction* per (worker, check, metric). Neither alone answers the
 * question a human actually asks on Monday morning: **"which workers are
 * healthy, which are slipping, and what's breaking?"** The scorecard is that
 * answer — one roll-up per worker combining a current pass rate, a breakdown of
 * what's failing, and a trend arrow (up improving / down degrading / flat steady).
 *
 * Why it exists (the framework's thesis, applied one more time): research-time
 * safety != runtime safety. A fleet of agents can each look fine on any single
 * run while the fleet as a whole quietly rots. The scorecard is the weekly
 * physical — it reads the record the workers can't forge (their own scored
 * transcripts) and reports the trend, not the snapshot.
 *
 * Independence note (the core axis is independent -> corruptible): every input
 * is a Tier 1 / Tier 2 score the worker never produced, and the trend arrows
 * compare a worker against *its own* earlier baseline. No model-as-judge, no
 * shared substrate. The scorecard is pure aggregation + formatting over those
 * independent signals — reproducible and offline by construction.
 *
 * Pipeline shape:
 *
 *     scores.jsonl --scoreHistory--> TranscriptScore[]  -.
 *                                                          >-- aggregateScorecard --> Scorecard
 *     scores.jsonl --detectTrends--> TrendReport        -'                              |
 *                                                                                       v
 *                                                   formatScorecard / formatScorecardMarkdown
 *
 * Module layout (this file is the orchestration + formatting surface; the pieces
 * it drives live alongside it, re-exported here so consumers keep one import
 * path at `./scorecard.js`):
 *
 *   - `./scorecard-types.js` — the type vocabulary + grading/display constants.
 *   - `./scorecard-stats.js` — the pure `(scores [+ trend]) -> line` engine
 *                              (predicates, grading, per-check + failure
 *                              breakdowns, per-worker + fleet roll-up).
 *   - this file              — grouping/sorting orchestration ({@link aggregateScorecard})
 *                              and the renderers ({@link formatScorecard},
 *                              {@link formatScorecardMarkdown}).
 *   - `./scorecard-runner.js` — the disk wiring (`scoreHistory` +
 *                               `detectTrendsFromDisk` -> {@link aggregateScorecard}).
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import type { TranscriptScore } from './scorer.js';
import type { WorkerTrend } from './trend-detector.js';
import {
  type AggregateScorecardOptions,
  type HealthGrade,
  type Scorecard,
  type ScorecardThresholds,
  type WorkerScorecard,
  DEFAULT_HEALTHY_PASS_RATE,
  DEFAULT_WATCH_PASS_RATE,
  GRADE_LABEL,
  GRADE_RANK,
} from './scorecard-types.js';
import {
  buildWorkerScorecard,
  computeTotals,
  trendFromWorker,
} from './scorecard-stats.js';

// Re-export the type vocabulary so consumers keep one import path at
// `./scorecard.js` (mirrors the trend-detector split).
export type {
  HealthGrade,
  TrendArrow,
  ScorecardTrend,
  CheckBreakdown,
  FailureCategory,
  WorkerScorecard,
  ScorecardTotals,
  Scorecard,
  AggregateScorecardOptions,
} from './scorecard-types.js';

// Re-export the pure engine pieces a consumer might want to drive directly
// (e.g. to build a single worker line without re-grouping).
export {
  buildWorkerScorecard,
  computeTotals,
  trendFromWorker,
  gradeWorker,
  breakdownChecks,
  failureCategories,
} from './scorecard-stats.js';

// ─── PUBLIC API ──────────────────────────────────────────────────────────────────

/**
 * Aggregate scored transcripts (and an optional trend report) into a
 * {@link Scorecard}. Pure: no filesystem, no clock beyond `options.now`.
 *
 * Workers are grouped from the {@link TranscriptScore.worker} field, so the set
 * of workers on the scorecard is exactly the set that produced scored runs in
 * the window. The trend report only contributes arrows; it never adds a worker
 * that has no scored runs (a trend with no current data is not actionable).
 *
 * @param scores - Per-transcript scores (typically `scoreHistory(...).scores`).
 * @param options - Trend report, window, and grading thresholds.
 */
export function aggregateScorecard(
  scores: readonly TranscriptScore[],
  options: AggregateScorecardOptions = {},
): Scorecard {
  const now = options.now ?? new Date();
  const thresholds: ScorecardThresholds = {
    healthy: options.healthyPassRate ?? DEFAULT_HEALTHY_PASS_RATE,
    watch: options.watchPassRate ?? DEFAULT_WATCH_PASS_RATE,
  };

  // Index trends by worker for arrow lookup.
  const trendByWorker = new Map<string, WorkerTrend>();
  if (options.trends) {
    for (const wt of options.trends.workers) trendByWorker.set(wt.worker, wt);
  }

  // Group scores by worker, preserving first-seen order for stable grouping.
  const byWorker = new Map<string, TranscriptScore[]>();
  for (const ts of scores) {
    const list = byWorker.get(ts.worker);
    if (list) list.push(ts);
    else byWorker.set(ts.worker, [ts]);
  }

  const workers: WorkerScorecard[] = [];
  for (const [worker, runs] of byWorker) {
    const trend = trendFromWorker(trendByWorker.get(worker));
    workers.push(buildWorkerScorecard(worker, runs, trend, thresholds));
  }

  // Worst grade first; within a grade, lowest pass rate first, then name.
  workers.sort((a, b) => {
    const g = GRADE_RANK[a.grade] - GRADE_RANK[b.grade];
    if (g !== 0) return g;
    const pa = Number.isFinite(a.passRate) ? a.passRate : Infinity;
    const pb = Number.isFinite(b.passRate) ? b.passRate : Infinity;
    if (pa !== pb) return pa - pb;
    return a.worker.localeCompare(b.worker);
  });

  const totals = computeTotals(workers, scores);

  return {
    window: options.window,
    generatedAt: now.toISOString(),
    workers,
    totals,
  };
}

// ─── FORMATTERS ──────────────────────────────────────────────────────────────────

function pctStr(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : 'n/a';
}

function scoreStr(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : 'n/a';
}

/** Describe the covered window as a short string, or 'all-time' when absent. */
function windowLabel(window: Scorecard['window']): string {
  if (!window) return 'all-time';
  const { fromDate, toDate } = window;
  if (fromDate && toDate) return `${fromDate} .. ${toDate}`;
  if (fromDate) return `since ${fromDate}`;
  if (toDate) return `until ${toDate}`;
  return 'all-time';
}

/** Pad/truncate a string to a fixed display width. */
function fixed(s: string, width: number): string {
  if (s.length === width) return s;
  if (s.length > width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

/**
 * Render a compact terminal scorecard — the kind a cron worker drops into a
 * status file or a chat alert. A header, one aligned line per worker (grade,
 * pass rate, mean score, runs, trend arrow, top failure), then a fleet summary.
 *
 * @param card - A {@link Scorecard}.
 * @param options.maxFailures - Cap the failure categories shown per worker.
 *   Default: 3.
 */
export function formatScorecard(
  card: Scorecard,
  options: { maxFailures?: number } = {},
): string {
  const maxFailures = options.maxFailures ?? 3;
  const lines: string[] = [];

  const t = card.totals;
  lines.push(
    `Scorecard (${windowLabel(card.window)}) — ${t.workers} worker(s), ` +
      `${t.runs} run(s), fleet pass ${pctStr(t.passRate)}`,
  );

  if (card.workers.length === 0) {
    lines.push('  (no scored runs)');
    return lines.join('\n');
  }

  // Aligned columns: grade | worker | pass | mean | runs | arrow | failures.
  const nameWidth = Math.min(
    18,
    Math.max(6, ...card.workers.map((w) => w.worker.length)),
  );

  for (const w of card.workers) {
    const grade = fixed(GRADE_LABEL[w.grade], 5);
    const name = fixed(w.worker, nameWidth);
    const pass = fixed(pctStr(w.passRate), 4);
    const score = fixed(scoreStr(w.meanScore), 4);
    const runs = fixed(`${w.runs}r`, 4);
    const fails =
      w.failureCategories.length === 0
        ? 'clean'
        : w.failureCategories
            .slice(0, maxFailures)
            .map((f) => `${f.check}:${f.count}`)
            .join(' ') +
          (w.failureCategories.length > maxFailures
            ? ` +${w.failureCategories.length - maxFailures}`
            : '');
    lines.push(
      `  ${grade} ${name}  pass ${pass}  score ${score}  ${runs}  ${w.trend.arrow}  ${fails}`,
    );
  }

  // Fleet trend + grade tally footer.
  const gradeBits = (Object.keys(GRADE_RANK) as HealthGrade[])
    .sort((a, b) => GRADE_RANK[a] - GRADE_RANK[b])
    .filter((g) => t.grades[g] > 0)
    .map((g) => `${GRADE_LABEL[g]}=${t.grades[g]}`);
  lines.push(
    `  ── ${gradeBits.join(' ')} · trends ↓${t.degradingTrends} ↑${t.improvingTrends}`,
  );

  return lines.join('\n');
}

/**
 * Render the scorecard as a Markdown document — the format for a weekly report
 * dropped into a status file, a memory note, or a PR comment. A summary line, a
 * worker table with trend arrows, and per-worker failure/check drill-downs.
 *
 * @param card - A {@link Scorecard}.
 * @param options.title - Heading text. Default: "Weekly Scorecard".
 * @param options.maxFailures - Cap failure categories per worker in the table.
 *   Default: 3.
 * @param options.includeChecks - Add a per-check breakdown section. Default: true.
 */
export function formatScorecardMarkdown(
  card: Scorecard,
  options: { title?: string; maxFailures?: number; includeChecks?: boolean } = {},
): string {
  const title = options.title ?? 'Weekly Scorecard';
  const maxFailures = options.maxFailures ?? 3;
  const includeChecks = options.includeChecks ?? true;
  const t = card.totals;
  const out: string[] = [];

  out.push(`# ${title}`);
  out.push('');
  out.push(`**Window:** ${windowLabel(card.window)}  `);
  out.push(`**Generated:** ${card.generatedAt}  `);
  out.push(
    `**Fleet:** ${t.workers} worker(s) · ${t.runs} run(s) · ` +
      `pass ${pctStr(t.passRate)} · mean ${scoreStr(t.meanScore)} · ` +
      `trends ↓${t.degradingTrends} ↑${t.improvingTrends}`,
  );
  out.push('');

  if (card.workers.length === 0) {
    out.push('_No scored runs in this window._');
    return out.join('\n');
  }

  // Worker summary table.
  out.push('| Worker | Grade | Pass | Mean | Worst | Runs | Trend | Top failures |');
  out.push('|---|---|---:|---:|---:|---:|:---:|---|');
  for (const w of card.workers) {
    const fails =
      w.failureCategories.length === 0
        ? '—'
        : w.failureCategories
            .slice(0, maxFailures)
            .map((f) => `${f.check} (${f.count})`)
            .join(', ') +
          (w.failureCategories.length > maxFailures
            ? `, +${w.failureCategories.length - maxFailures} more`
            : '');
    out.push(
      `| ${w.worker} | ${GRADE_LABEL[w.grade]} | ${pctStr(w.passRate)} | ` +
        `${scoreStr(w.meanScore)} | ${scoreStr(w.worstScore)} | ${w.runs} | ` +
        `${w.trend.arrow} | ${fails} |`,
    );
  }
  out.push('');

  if (includeChecks) {
    out.push('## Per-check breakdown');
    out.push('');
    for (const w of card.workers) {
      if (w.checks.length === 0) continue;
      out.push(`### ${w.worker} — ${GRADE_LABEL[w.grade]} ${w.trend.arrow}`);
      out.push('');
      out.push('| Check | Mean | Pass | Warn | Fail | Runs |');
      out.push('|---|---:|---:|---:|---:|---:|');
      for (const c of w.checks) {
        out.push(
          `| ${c.check} | ${scoreStr(c.meanScore)} | ${c.passes} | ` +
            `${c.warns} | ${c.fails} | ${c.runs} |`,
        );
      }
      if (w.trend.direction !== 'none') {
        out.push('');
        out.push(`_Trend: ${w.trend.summary} (${w.trend.arrow})._`);
      }
      out.push('');
    }
  }

  return out.join('\n').trimEnd() + '\n';
}
