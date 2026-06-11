/**
 * GitHub Action Adapter — Phase 4 CI Integration
 *
 * The seam where the monitoring pipeline meets a CI runner. Everything upstream
 * of this module answers "how healthy is the fleet?" as data ({@link Scorecard}).
 * This module answers the question a *workflow* asks: **"should this step pass,
 * what's the headline score, and what's the evidence?"** — and emits it in the
 * three shapes a GitHub Action consumes:
 *
 *   1. **Action outputs** (`eval_passed`, `eval_score`, `eval_evidence`, …) so a
 *      downstream `if:` can gate on quality.
 *   2. A **step summary** (GitHub-flavored Markdown) for `$GITHUB_STEP_SUMMARY`.
 *   3. An **exit code** so a step can hard-fail the job when a worker is
 *      at-risk/critical.
 *
 * Why it exists (the framework's thesis, one layer out): research-time safety !=
 * runtime safety. An agent that runs autonomously in CI — reviewing PRs, editing
 * code, triaging issues — ships "safe" and then runs unattended forever. The
 * only built-in check most CI agents have is "did the process exit 0?", which
 * catches a crash but not a stale run, an empty review, or output that wandered
 * off the task. This adapter turns the independent Tier 1 / Tier 2 signals the
 * scorecard already computes into a pass/fail gate the pipeline can act on.
 *
 * Independence note (the core axis is independent -> corruptible): every input
 * is a {@link Scorecard} built from scores the evaluated agent never produced.
 * This module adds no judgement of its own — it is a pure projection of those
 * independent signals into Action-shaped outputs. No model-as-judge, offline,
 * reproducible. The I/O (writing to `$GITHUB_OUTPUT` / `$GITHUB_STEP_SUMMARY`)
 * is isolated behind {@link ActionWriter} so the decision logic stays a pure
 * function and the file effects are testable without a real runner.
 *
 * Pipeline shape:
 *
 *     Scorecard --evaluateForAction--> ActionEvaluation
 *                                          |  |  |
 *                                          |  |  '-- renderActionSummary --> $GITHUB_STEP_SUMMARY
 *                                          |  '----- toActionOutputs -------> $GITHUB_OUTPUT
 *                                          '-------- evaluation.exitCode ---> process.exitCode
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import type { HealthGrade, Scorecard, WorkerScorecard } from '../monitoring/scorecard.js';
import { formatScorecardMarkdown } from '../monitoring/scorecard.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/**
 * The lowest health grade a worker may carry while the eval step still passes.
 * Anything strictly worse than the gate (see {@link GRADE_SEVERITY}) fails the
 * step. Defaults to `at-risk`, i.e. `healthy`/`watch` pass and
 * `at-risk`/`critical` fail.
 */
export type GateGrade = Exclude<HealthGrade, 'no-data'>;

/**
 * How a worker that produced no evaluable runs (`no-data`) should be treated by
 * the gate. CI agents legitimately have nothing to say sometimes (a docs-only
 * PR, a no-op trigger), so the default is lenient.
 *
 * - `pass`   — `no-data` never fails the gate (default).
 * - `fail`   — `no-data` fails the gate (use when a run is always expected).
 * - `ignore` — `no-data` workers are dropped from the evaluation entirely (not
 *   counted in totals, never gated on).
 */
export type NoDataPolicy = 'pass' | 'fail' | 'ignore';

/** Options for {@link evaluateForAction}. */
export interface EvaluateForActionOptions {
  /**
   * Worst grade that still passes. A worker strictly worse than this fails the
   * gate. Default: `at-risk` (so only `at-risk`/`critical` fail).
   */
  gate?: GateGrade;
  /** How to treat `no-data` workers. Default: `pass`. */
  noData?: NoDataPolicy;
  /**
   * Restrict the gate to these workers (others still appear in the summary but
   * never fail the step). Useful when one Action only owns part of the fleet.
   * Omit to gate on every worker.
   */
  gateWorkers?: readonly string[];
  /**
   * Minimum fleet mean score to pass, in [0, 1]. Applied in addition to the
   * per-worker grade gate. Omit to disable the score floor.
   */
  minScore?: number;
  /** Maximum number of failing workers listed in `eval_evidence`. Default: 5. */
  maxEvidenceItems?: number;
}

/** One worker's contribution to the gate decision. */
export interface WorkerVerdict {
  /** Worker name. */
  worker: string;
  /** The worker's health grade. */
  grade: HealthGrade;
  /** Pass rate in [0, 1]; NaN when no evaluable runs. */
  passRate: number;
  /** Whether this worker was within the gate (true) or tripped it (false). */
  passed: boolean;
  /** True when this worker was excluded from gating (not in `gateWorkers`). */
  gated: boolean;
  /** One-line reason, e.g. "grade at-risk worse than gate watch". */
  reason: string;
}

/** A single piece of evidence for why the step passed or failed. */
export interface ActionEvidence {
  /** Worker the evidence is about, or `fleet` for fleet-level findings. */
  worker: string;
  /** Severity of the finding. */
  severity: 'info' | 'warning' | 'critical';
  /** Human-readable message. */
  message: string;
}

/**
 * The complete, CI-shaped result of evaluating a {@link Scorecard}. This is the
 * single object an Action step needs: the booleans/numbers to emit as outputs,
 * the evidence to surface, the Markdown summary, and the exit code.
 */
export interface ActionEvaluation {
  /** Did the eval step pass overall? */
  passed: boolean;
  /** Process exit code: 0 on pass, 1 on fail. Mirrors {@link passed}. */
  exitCode: 0 | 1;
  /** Fleet mean score in [0, 1]; NaN when there were no scored runs. */
  score: number;
  /** Effective gate grade applied. */
  gate: GateGrade;
  /** Per-worker verdicts, worst grade first (mirrors the scorecard order). */
  verdicts: WorkerVerdict[];
  /** Evidence list (failing/at-risk workers first), capped by `maxEvidenceItems`. */
  evidence: ActionEvidence[];
  /** Count of workers that tripped the gate. */
  failingWorkers: number;
  /** Count of workers evaluated (after any `no-data: ignore`). */
  evaluatedWorkers: number;
  /** One-line headline, e.g. "FAIL — 1/4 workers below gate (at-risk)". */
  headline: string;
  /** The scorecard this evaluation was derived from. */
  scorecard: Scorecard;
}

/** A flat string map of GitHub Action outputs (all values stringified). */
export interface ActionOutputs {
  /** "true" / "false". */
  eval_passed: string;
  /** Fleet mean score formatted to 4 decimals, or "" when NaN. */
  eval_score: string;
  /** Effective gate grade. */
  eval_gate: string;
  /** Count of workers that tripped the gate. */
  eval_failing_workers: string;
  /** Count of workers evaluated. */
  eval_evaluated_workers: string;
  /** Single-line headline. */
  eval_headline: string;
  /** Semicolon-joined evidence messages (capped). */
  eval_evidence: string;
}

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

/**
 * Severity ordering of grades for gate comparison. Higher = worse. A worker
 * fails the gate when its severity exceeds the gate grade's severity.
 * `no-data` is handled separately by {@link NoDataPolicy} and is intentionally
 * absent here.
 */
const GRADE_SEVERITY: Readonly<Record<GateGrade, number>> = {
  healthy: 0,
  watch: 1,
  'at-risk': 2,
  critical: 3,
};

const DEFAULT_GATE: GateGrade = 'at-risk';
const DEFAULT_MAX_EVIDENCE = 5;

/** Map a grade to evidence severity. */
const GRADE_TO_SEVERITY: Readonly<Record<HealthGrade, ActionEvidence['severity']>> = {
  healthy: 'info',
  watch: 'warning',
  'at-risk': 'warning',
  critical: 'critical',
  'no-data': 'info',
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────────

/** Round to 4 decimals; pass through non-finite values unchanged. */
function round4(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 10_000) / 10_000;
}

/** Format a [0,1] score for output: 4 decimals, or "" when not finite. */
function scoreString(n: number): string {
  return Number.isFinite(n) ? round4(n).toFixed(4) : '';
}

/** Format a pass rate as a percentage string, or "n/a" when not finite. */
function pctStr(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : 'n/a';
}

/**
 * Decide one worker's verdict against the gate. Pure and total — covers the
 * `no-data` policy, the explicit `gateWorkers` allow-list, and the grade
 * comparison.
 */
function judgeWorker(
  w: WorkerScorecard,
  gate: GateGrade,
  noData: NoDataPolicy,
  gateWorkers: ReadonlySet<string> | undefined,
): WorkerVerdict {
  const inGate = gateWorkers ? gateWorkers.has(w.worker) : true;

  // A worker not on the allow-list is reported but never trips the gate.
  if (!inGate) {
    return {
      worker: w.worker,
      grade: w.grade,
      passRate: w.passRate,
      passed: true,
      gated: false,
      reason: 'not in gate set',
    };
  }

  if (w.grade === 'no-data') {
    const passed = noData !== 'fail';
    return {
      worker: w.worker,
      grade: w.grade,
      passRate: w.passRate,
      passed,
      gated: true,
      reason: passed ? 'no evaluable runs (allowed)' : 'no evaluable runs (required)',
    };
  }

  const gradeSev = GRADE_SEVERITY[w.grade];
  const gateSev = GRADE_SEVERITY[gate];
  const passed = gradeSev <= gateSev;
  return {
    worker: w.worker,
    grade: w.grade,
    passRate: w.passRate,
    passed,
    gated: true,
    reason: passed
      ? `grade ${w.grade} within gate ${gate}`
      : `grade ${w.grade} worse than gate ${gate}`,
  };
}

/** Build the evidence list: failing/risky workers first, capped. */
function buildEvidence(
  verdicts: readonly WorkerVerdict[],
  cards: ReadonlyMap<string, WorkerScorecard>,
  fleetScore: number,
  minScore: number | undefined,
  cap: number,
): ActionEvidence[] {
  const evidence: ActionEvidence[] = [];

  // Fleet score floor breach is the most important single line.
  if (minScore !== undefined && Number.isFinite(fleetScore) && fleetScore < minScore) {
    evidence.push({
      worker: 'fleet',
      severity: 'critical',
      message: `fleet mean score ${scoreString(fleetScore)} below floor ${minScore}`,
    });
  }

  // Failing gated workers, then non-failing-but-degraded workers, for context.
  const failing = verdicts.filter((v) => v.gated && !v.passed);
  const risky = verdicts.filter(
    (v) => v.gated && v.passed && (v.grade === 'watch' || v.grade === 'at-risk'),
  );

  for (const v of [...failing, ...risky]) {
    if (evidence.length >= cap) break;
    const card = cards.get(v.worker);
    const topFailure = card?.failureCategories[0];
    const failBit = topFailure ? `, top failure: ${topFailure.check} (${topFailure.count})` : '';
    const trendBit =
      card && card.trend.direction === 'degrading' ? `, trend ${card.trend.arrow}` : '';
    evidence.push({
      worker: v.worker,
      severity: GRADE_TO_SEVERITY[v.grade],
      message: `${v.worker}: ${v.grade} (${pctStr(v.passRate)} pass)${failBit}${trendBit}`,
    });
  }

  return evidence.slice(0, cap);
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────────

/**
 * Project a {@link Scorecard} into a CI-shaped {@link ActionEvaluation}: a
 * pass/fail decision, a headline score, per-worker verdicts, and evidence.
 * Pure — no filesystem, no environment, no clock.
 *
 * The decision is the conjunction of two gates:
 *   1. **Per-worker grade gate.** Every gated worker must be at or above the
 *      `gate` grade (default `at-risk`, so only `at-risk`/`critical` fail).
 *   2. **Fleet score floor** (optional). If `minScore` is set, the fleet mean
 *      score must meet it.
 *
 * `no-data` workers follow {@link NoDataPolicy} (default `pass`): a CI agent
 * with nothing to evaluate (docs-only PR, no-op trigger) shouldn't fail the
 * build by default.
 *
 * @param scorecard - A scorecard from `buildScorecard` / `aggregateScorecard`.
 * @param options - Gate grade, no-data policy, score floor, evidence cap.
 */
export function evaluateForAction(
  scorecard: Scorecard,
  options: EvaluateForActionOptions = {},
): ActionEvaluation {
  const gate = options.gate ?? DEFAULT_GATE;
  const noData = options.noData ?? 'pass';
  const cap = options.maxEvidenceItems ?? DEFAULT_MAX_EVIDENCE;
  const gateWorkers =
    options.gateWorkers && options.gateWorkers.length > 0
      ? new Set(options.gateWorkers)
      : undefined;

  // `no-data: ignore` drops those workers from the evaluation entirely.
  const workers =
    noData === 'ignore'
      ? scorecard.workers.filter((w) => w.grade !== 'no-data')
      : scorecard.workers;

  const cardByWorker = new Map<string, WorkerScorecard>();
  for (const w of workers) cardByWorker.set(w.worker, w);

  const verdicts = workers.map((w) => judgeWorker(w, gate, noData, gateWorkers));

  const fleetScore = scorecard.totals.meanScore;
  const scoreFloorOk =
    options.minScore === undefined ||
    !Number.isFinite(fleetScore) ||
    fleetScore >= options.minScore;

  const failingWorkers = verdicts.filter((v) => v.gated && !v.passed).length;
  const passed = failingWorkers === 0 && scoreFloorOk;

  const evidence = buildEvidence(verdicts, cardByWorker, fleetScore, options.minScore, cap);

  const evaluatedWorkers = verdicts.filter((v) => v.gated).length;
  const headline = buildHeadline(passed, failingWorkers, evaluatedWorkers, gate, fleetScore, {
    minScore: options.minScore,
    scoreFloorOk,
  });

  return {
    passed,
    exitCode: passed ? 0 : 1,
    score: round4(fleetScore),
    gate,
    verdicts,
    evidence,
    failingWorkers,
    evaluatedWorkers,
    headline,
    scorecard,
  };
}

/** Compose the one-line headline shown in outputs and the summary heading. */
function buildHeadline(
  passed: boolean,
  failingWorkers: number,
  evaluatedWorkers: number,
  gate: GateGrade,
  fleetScore: number,
  floor: { minScore: number | undefined; scoreFloorOk: boolean },
): string {
  const verdict = passed ? 'PASS' : 'FAIL';
  const scoreBit = Number.isFinite(fleetScore) ? `, mean score ${scoreString(fleetScore)}` : '';

  if (passed) {
    return evaluatedWorkers === 0
      ? `${verdict} — no workers to gate${scoreBit}`
      : `${verdict} — ${evaluatedWorkers}/${evaluatedWorkers} workers within gate (${gate})${scoreBit}`;
  }

  const parts: string[] = [];
  if (failingWorkers > 0) {
    parts.push(`${failingWorkers}/${evaluatedWorkers} workers below gate (${gate})`);
  }
  if (!floor.scoreFloorOk && floor.minScore !== undefined) {
    parts.push(`fleet score ${scoreString(fleetScore)} < floor ${floor.minScore}`);
  }
  return `${verdict} — ${parts.join('; ')}${scoreBit}`;
}

/**
 * Map an {@link ActionEvaluation} into the flat string outputs a GitHub Action
 * exposes via `core.setOutput` / `$GITHUB_OUTPUT`. Every value is a string so
 * it can be written verbatim to the outputs file.
 *
 * @param evaluation - Result of {@link evaluateForAction}.
 */
export function toActionOutputs(evaluation: ActionEvaluation): ActionOutputs {
  return {
    eval_passed: String(evaluation.passed),
    eval_score: scoreString(evaluation.score),
    eval_gate: evaluation.gate,
    eval_failing_workers: String(evaluation.failingWorkers),
    eval_evaluated_workers: String(evaluation.evaluatedWorkers),
    eval_headline: evaluation.headline,
    eval_evidence: evaluation.evidence.map((e) => e.message).join('; '),
  };
}

/**
 * Render the GitHub-flavored Markdown step summary for an
 * {@link ActionEvaluation} — the block written to `$GITHUB_STEP_SUMMARY` and
 * shown on the Action run page. A verdict heading, the gate/score line, an
 * evidence list (when failing/degraded), and the full per-worker scorecard
 * table from {@link formatScorecardMarkdown}.
 *
 * @param evaluation - Result of {@link evaluateForAction}.
 * @param options.title - Heading text. Default: "Agent Eval".
 */
export function renderActionSummary(
  evaluation: ActionEvaluation,
  options: { title?: string } = {},
): string {
  const title = options.title ?? 'Agent Eval';
  const icon = evaluation.passed ? '✅' : '❌';
  const out: string[] = [];

  out.push(`## ${icon} ${title} — ${evaluation.passed ? 'passed' : 'failed'}`);
  out.push('');
  out.push(`> ${evaluation.headline}`);
  out.push('');
  out.push(
    `**Gate:** \`${evaluation.gate}\` · ` +
      `**Evaluated:** ${evaluation.evaluatedWorkers} worker(s) · ` +
      `**Failing:** ${evaluation.failingWorkers} · ` +
      `**Fleet score:** ${scoreString(evaluation.score) || 'n/a'}`,
  );
  out.push('');

  if (evaluation.evidence.length > 0) {
    out.push('### Findings');
    out.push('');
    for (const e of evaluation.evidence) {
      const mark = e.severity === 'critical' ? '🔴' : e.severity === 'warning' ? '🟡' : 'ℹ️';
      out.push(`- ${mark} ${e.message}`);
    }
    out.push('');
  }

  // Embed the full scorecard (drop its top-level H1 so headings nest cleanly
  // under this summary's H2/H3 structure).
  const scorecardMd = formatScorecardMarkdown(evaluation.scorecard, {
    title: 'Scorecard',
  });
  const body = scorecardMd
    .split('\n')
    .map((line) => (line.startsWith('# ') ? `##${line}` : line))
    .join('\n');
  out.push(body.trimEnd());

  return out.join('\n').trimEnd() + '\n';
}
