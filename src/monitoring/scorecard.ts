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
 * This module is split in two, mirroring the rest of monitoring:
 *   - {@link aggregateScorecard} is pure (takes scores + an optional trend
 *     report, returns a {@link Scorecard}). No filesystem, fully testable.
 *   - `buildScorecard` (in `scorecard-runner.ts`) wires it to disk via
 *     `scoreHistory` + `detectTrendsFromDisk`.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import type { CheckName, TranscriptScore } from './scorer.js';
import type { TrendReport, TrendSeverity, WorkerTrend } from './trend-detector.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/**
 * Overall health grade for a worker, derived from its pass rate and whether any
 * trend is degrading. Coarser than the raw numbers on purpose — a grade is what
 * goes in the headline; the numbers are the drill-down.
 */
export type HealthGrade = 'healthy' | 'watch' | 'at-risk' | 'critical' | 'no-data';

/**
 * A single trend arrow glyph. The literal values are the rendered characters so
 * a formatter can splice them straight into a table without a lookup.
 */
export type TrendArrow = '↑' | '↓' | '→' | '·';

/** How a worker's overall health is moving, with the glyph and a label. */
export interface ScorecardTrend {
  /** The glyph to render. */
  arrow: TrendArrow;
  /** Machine-readable direction. `none` when there is no trend signal at all. */
  direction: 'improving' | 'degrading' | 'stable' | 'none';
  /** Worst degradation severity contributing to a down arrow, else `none`. */
  severity: TrendSeverity;
  /** Count of degrading (worker, check, metric) trends. */
  degrading: number;
  /** Count of improving trends. */
  improving: number;
  /** Human one-liner, e.g. "2 degrading, 1 improving". */
  summary: string;
}

/** Per-check roll-up within one worker: how a single check is performing. */
export interface CheckBreakdown {
  /** The check name, e.g. "completeness". */
  check: CheckName;
  /** Mean score for this check across the window, in [0, 1]. NaN if no data. */
  meanScore: number;
  /** Number of runs that exercised this check (non-skipped). */
  runs: number;
  /** How many of those runs failed this check. */
  fails: number;
  /** How many warned. */
  warns: number;
  /** How many passed. */
  passes: number;
}

/** A single failure category: a check and how many times it failed. */
export interface FailureCategory {
  /** The check that failed. */
  check: CheckName;
  /** Number of runs in which it failed. */
  count: number;
}

/**
 * One worker's complete scorecard line: a grade, a pass rate, the failure
 * breakdown, and a trend arrow. This is the atomic unit a reader scans.
 */
export interface WorkerScorecard {
  /** Worker name. */
  worker: string;
  /** Overall health grade. */
  grade: HealthGrade;
  /** Number of distinct runs scored in the window. */
  runs: number;
  /**
   * Pass rate in [0, 1]: fraction of scored runs with zero failing checks. NaN
   * when there were no runs. This is run-level (a run "passes" only if every
   * non-skipped check passed), which is stricter and more honest than a
   * check-level average.
   */
  passRate: number;
  /** Mean of every run's overall score, in [0, 1]. NaN if no runs. */
  meanScore: number;
  /** Worst single run's overall score in the window. NaN if no runs. */
  worstScore: number;
  /** Number of runs with at least one failing check. */
  runsWithFailures: number;
  /** Total failing-check occurrences across all runs. */
  totalFailures: number;
  /**
   * Failure categories: which checks failed and how often, worst (most
   * failures) first. The "what's breaking" column.
   */
  failureCategories: FailureCategory[];
  /** Per-check performance breakdown, worst mean score first. */
  checks: CheckBreakdown[];
  /** Trend arrow + detail. `direction: 'none'` when no trend report was supplied. */
  trend: ScorecardTrend;
  /** One-line human summary of this worker's line. */
  summary: string;
}

/** Fleet-wide totals across every worker on the scorecard. */
export interface ScorecardTotals {
  /** Number of workers represented. */
  workers: number;
  /** Total runs scored across all workers. */
  runs: number;
  /** Fleet pass rate: passing runs / total runs, in [0, 1]. NaN if no runs. */
  passRate: number;
  /** Mean overall score across all runs (every run weighted equally). NaN if none. */
  meanScore: number;
  /** Count of workers at each grade. */
  grades: Record<HealthGrade, number>;
  /** Total degrading trends across the fleet. */
  degradingTrends: number;
  /** Total improving trends across the fleet. */
  improvingTrends: number;
}

/** Top-level scorecard: per-worker lines + fleet totals. */
export interface Scorecard {
  /** Inclusive date window this scorecard covers, if one was applied. */
  window: { fromDate: string; toDate: string } | undefined;
  /** When the scorecard was generated (ISO-8601). */
  generatedAt: string;
  /** Per-worker lines, worst grade first. */
  workers: WorkerScorecard[];
  /** Fleet-wide totals. */
  totals: ScorecardTotals;
}

/** Options for {@link aggregateScorecard}. */
export interface AggregateScorecardOptions {
  /**
   * Trend report (from `detectTrends` / `detectTrendsFromDisk`) used to compute
   * the trend arrow per worker. Omit for a snapshot-only scorecard (every arrow
   * becomes `·` / `direction: 'none'`).
   */
  trends?: TrendReport;
  /** The inclusive date window covered, recorded verbatim on the result. */
  window?: { fromDate: string; toDate: string };
  /** Override the generation timestamp (testing). Default: now. */
  now?: Date;
  /**
   * Pass-rate floor (inclusive) at or above which a worker can be `healthy`,
   * assuming no degrading trend. Default: 0.9.
   */
  healthyPassRate?: number;
  /**
   * Pass-rate floor (inclusive) at or above which a worker is at worst `watch`
   * (below it, the worker is `at-risk`). Default: 0.6.
   */
  watchPassRate?: number;
}

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

const DEFAULT_HEALTHY_PASS_RATE = 0.9;
const DEFAULT_WATCH_PASS_RATE = 0.6;

const GRADE_RANK: Readonly<Record<HealthGrade, number>> = {
  critical: 0,
  'at-risk': 1,
  watch: 2,
  healthy: 3,
  'no-data': 4,
};

const EMPTY_GRADES: Readonly<Record<HealthGrade, number>> = {
  healthy: 0,
  watch: 0,
  'at-risk': 0,
  critical: 0,
  'no-data': 0,
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────────

/** Mean of an array, or NaN when empty. */
function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((a, v) => a + v, 0) / values.length;
}

/** Round to 4 decimals to keep JSON output tidy and stable. */
function round4(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 10_000) / 10_000;
}

/** Is a run a pass? At least one non-skipped check and none failed. */
function runPassed(ts: TranscriptScore): boolean {
  const scored = ts.checks.filter((c) => c.status !== 'skip');
  if (scored.length === 0) return false;
  return scored.every((c) => c.status !== 'fail');
}

/** Did a run produce any pass/fail signal at all (>= 1 non-skipped check)? */
function runHasSignal(ts: TranscriptScore): boolean {
  return ts.checks.some((c) => c.status !== 'skip');
}

/**
 * Derive the trend arrow for one worker from its {@link WorkerTrend} roll-up.
 * The arrow follows the degradation/improvement balance, and a down arrow
 * inherits the worst degradation severity so the formatter can flag it.
 */
function trendFromWorker(wt: WorkerTrend | undefined): ScorecardTrend {
  if (!wt) {
    return {
      arrow: '·',
      direction: 'none',
      severity: 'none',
      degrading: 0,
      improving: 0,
      summary: 'no trend data',
    };
  }

  const degrading = wt.degradations.length;
  const improving = wt.improvements.length;

  let arrow: TrendArrow;
  let direction: ScorecardTrend['direction'];
  if (degrading > improving) {
    arrow = '↓';
    direction = 'degrading';
  } else if (improving > degrading) {
    arrow = '↑';
    direction = 'improving';
  } else {
    // Either nothing moved, or movement in both directions cancels to flat.
    arrow = '→';
    direction = 'stable';
  }

  const summary =
    degrading === 0 && improving === 0
      ? 'steady'
      : `${degrading} degrading, ${improving} improving`;

  return {
    arrow,
    direction,
    // Severity only meaningful when the net direction is down.
    severity: direction === 'degrading' ? wt.worstSeverity : 'none',
    degrading,
    improving,
    summary,
  };
}

/**
 * Grade a worker from its pass rate and trend. The trend can only *demote* a
 * worker, never promote it — a high pass rate with a critical downward trend is
 * still risky because the snapshot looks fine precisely while it rots.
 */
function gradeWorker(
  passRate: number,
  trend: ScorecardTrend,
  thresholds: { healthy: number; watch: number },
): HealthGrade {
  if (!Number.isFinite(passRate)) return 'no-data';

  let grade: HealthGrade;
  if (passRate >= thresholds.healthy) grade = 'healthy';
  else if (passRate >= thresholds.watch) grade = 'watch';
  else grade = 'at-risk';

  // A degrading trend demotes. Critical degradation forces at least 'at-risk';
  // a critical trend on an already-bad worker pushes to 'critical'.
  if (trend.direction === 'degrading') {
    if (trend.severity === 'critical') {
      grade = grade === 'at-risk' ? 'critical' : 'at-risk';
    } else if (grade === 'healthy') {
      // Any non-critical degradation knocks a "healthy" worker down to "watch".
      grade = 'watch';
    }
  }

  return grade;
}

/** Build the per-check breakdown for one worker from its scored runs. */
function breakdownChecks(scores: readonly TranscriptScore[]): CheckBreakdown[] {
  const acc = new Map<
    CheckName,
    { scores: number[]; fails: number; warns: number; passes: number }
  >();

  for (const ts of scores) {
    for (const c of ts.checks) {
      if (c.status === 'skip') continue; // skipped checks carry no signal
      let a = acc.get(c.check);
      if (!a) {
        a = { scores: [], fails: 0, warns: 0, passes: 0 };
        acc.set(c.check, a);
      }
      a.scores.push(c.score);
      if (c.status === 'fail') a.fails += 1;
      else if (c.status === 'warn') a.warns += 1;
      else if (c.status === 'pass') a.passes += 1;
    }
  }

  const out: CheckBreakdown[] = [];
  for (const [check, a] of acc) {
    out.push({
      check,
      meanScore: round4(mean(a.scores)),
      runs: a.scores.length,
      fails: a.fails,
      warns: a.warns,
      passes: a.passes,
    });
  }

  // Worst mean score first; ties broken by more failures, then name.
  out.sort((x, y) => {
    const mx = Number.isFinite(x.meanScore) ? x.meanScore : Infinity;
    const my = Number.isFinite(y.meanScore) ? y.meanScore : Infinity;
    if (mx !== my) return mx - my;
    if (x.fails !== y.fails) return y.fails - x.fails;
    return x.check.localeCompare(y.check);
  });
  return out;
}

/** Tally failure categories (which checks failed, how often) worst-first. */
function failureCategories(scores: readonly TranscriptScore[]): FailureCategory[] {
  const counts = new Map<CheckName, number>();
  for (const ts of scores) {
    for (const c of ts.checks) {
      if (c.status === 'fail') counts.set(c.check, (counts.get(c.check) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([check, count]) => ({ check, count }))
    .sort((a, b) => b.count - a.count || a.check.localeCompare(b.check));
}

/** Build one worker's scorecard line from its scored runs and (optional) trend. */
function buildWorkerScorecard(
  worker: string,
  scores: readonly TranscriptScore[],
  trend: ScorecardTrend,
  thresholds: { healthy: number; watch: number },
): WorkerScorecard {
  const runs = scores.length;

  // Pass rate is measured only over runs that produced a pass/fail signal. A
  // run where every check skipped (no task, empty body) carries no verdict and
  // would otherwise unfairly drag the rate to 0.
  const evaluable = scores.filter(runHasSignal);
  const passingRuns = evaluable.filter(runPassed).length;
  const runsWithFailures = scores.filter((ts) => ts.failCount > 0).length;
  const totalFailures = scores.reduce((a, ts) => a + ts.failCount, 0);

  const overalls = scores.map((ts) => ts.overall).filter((n) => Number.isFinite(n));
  const passRate = evaluable.length > 0 ? passingRuns / evaluable.length : Number.NaN;
  const meanScore = round4(mean(overalls));
  const worstScore = overalls.length > 0 ? round4(Math.min(...overalls)) : Number.NaN;

  const cats = failureCategories(scores);
  const checks = breakdownChecks(scores);
  const grade = gradeWorker(passRate, trend, thresholds);

  const passPctStr = Number.isFinite(passRate) ? `${Math.round(passRate * 100)}%` : 'n/a';
  const worstCat = cats[0] ? `, top failure: ${cats[0].check} (${cats[0].count})` : '';
  const summary =
    runs === 0
      ? `${worker}: no runs in window`
      : `${worker}: ${grade}, ${passPctStr} pass (${passingRuns}/${runs}) ${trend.arrow}${worstCat}`;

  return {
    worker,
    grade,
    runs,
    passRate: round4(passRate),
    meanScore,
    worstScore,
    runsWithFailures,
    totalFailures,
    failureCategories: cats,
    checks,
    trend,
    summary,
  };
}

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
  const thresholds = {
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

/** Compute fleet-wide totals from the per-worker lines + raw scores. */
function computeTotals(
  workers: readonly WorkerScorecard[],
  scores: readonly TranscriptScore[],
): ScorecardTotals {
  const grades: Record<HealthGrade, number> = { ...EMPTY_GRADES };
  let degradingTrends = 0;
  let improvingTrends = 0;
  for (const w of workers) {
    grades[w.grade] += 1;
    degradingTrends += w.trend.degrading;
    improvingTrends += w.trend.improving;
  }

  const totalRuns = scores.length;
  const evaluable = scores.filter(runHasSignal);
  const passingRuns = evaluable.filter(runPassed).length;
  const overalls = scores.map((ts) => ts.overall).filter((n) => Number.isFinite(n));

  return {
    workers: workers.length,
    runs: totalRuns,
    passRate: evaluable.length > 0 ? round4(passingRuns / evaluable.length) : Number.NaN,
    meanScore: round4(mean(overalls)),
    grades,
    degradingTrends,
    improvingTrends,
  };
}

// ─── FORMATTERS ──────────────────────────────────────────────────────────────────

const GRADE_LABEL: Readonly<Record<HealthGrade, string>> = {
  healthy: 'OK',
  watch: 'WATCH',
  'at-risk': 'RISK',
  critical: 'CRIT',
  'no-data': '--',
};

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