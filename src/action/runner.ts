/**
 * Action Runner — Phase 4 CI Integration
 *
 * The one-call entry point a GitHub Action step uses: read a transcripts root,
 * build a {@link Scorecard}, project it into an {@link ActionEvaluation}, and
 * (optionally) write the outputs and step summary to the runner's environment
 * files. This is the seam an eval-layer contribution to a CI Action plugs into
 * — it takes the same transcripts the workers already write and turns them into
 * a quality gate, in one call:
 *
 *     const result = runActionEval('.../transcripts', { window: 7, gate: 'watch' });
 *     emitActionResult(result.evaluation);            // outputs + summary + exit
 *     process.exitCode = result.evaluation.exitCode;  // fail the job on a bad gate
 *
 * The decision logic ({@link evaluateForAction}) and the scorecard build
 * ({@link buildScorecard}) are pure / filesystem-only respectively; the *side
 * effects* a CI runner needs — appending to `$GITHUB_OUTPUT`, writing
 * `$GITHUB_STEP_SUMMARY` — are isolated behind {@link ActionWriter} so the
 * runner can be exercised offline with an in-memory writer and no real runner.
 *
 * Independence note (the core axis is independent -> corruptible): the gate is
 * computed entirely from scores the evaluated agent never produced (Tier 1+2,
 * no model-as-judge). This runner adds orchestration and I/O only — it does not
 * introduce any new judgement.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import { appendFileSync } from 'node:fs';
import { EOL } from 'node:os';

import { buildScorecard } from '../monitoring/scorecard-runner.js';
import type { BuildScorecardOptions, BuildScorecardResult } from '../monitoring/scorecard-runner.js';

import {
  evaluateForAction,
  renderActionSummary,
  toActionOutputs,
} from './adapter.js';
import type {
  ActionEvaluation,
  ActionOutputs,
  EvaluateForActionOptions,
} from './adapter.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/**
 * The subset of the GitHub Actions environment this runner writes to. Injected
 * so the side effects are testable; the default ({@link createEnvWriter}) reads
 * the real `GITHUB_OUTPUT` / `GITHUB_STEP_SUMMARY` env vars.
 */
export interface ActionWriter {
  /**
   * Append one `name=value` (or multiline) output to the outputs file. A no-op
   * when the runner provides no outputs file (e.g. local invocation).
   */
  setOutput(name: string, value: string): void;
  /**
   * Append a block of Markdown to the job step summary. A no-op when no summary
   * file is configured.
   */
  appendSummary(markdown: string): void;
}

/** Options for {@link runActionEval}. */
export interface RunActionEvalOptions
  extends BuildScorecardOptions,
    EvaluateForActionOptions {
  /** Title used for the step-summary heading. Default: "Agent Eval". */
  title?: string;
}

/** Result of {@link runActionEval}. */
export interface RunActionEvalResult {
  /** The CI-shaped evaluation (pass/fail, score, evidence, exit code). */
  evaluation: ActionEvaluation;
  /** The flat Action outputs (stringified). */
  outputs: ActionOutputs;
  /** The rendered Markdown step summary. */
  summary: string;
  /** The underlying scorecard build result (scored/failed counts, errors). */
  build: BuildScorecardResult;
}

// ─── WRITERS ──────────────────────────────────────────────────────────────────────

/**
 * GitHub Actions delimits multiline output values with a random heredoc marker
 * so a value containing newlines can't break the `name=value` parser. We mirror
 * that here for any value that contains a newline.
 */
function formatOutputLine(name: string, value: string): string {
  if (!value.includes('\n')) return `${name}=${value}`;
  // A delimiter that won't collide with realistic content.
  const delim = `ghadelimiter_${Math.random().toString(36).slice(2)}`;
  return `${name}<<${delim}${EOL}${value}${EOL}${delim}`;
}

/**
 * Default writer backed by the real GitHub Actions environment files. Reads
 * `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY` from `env` (defaults to
 * `process.env`). When a path is absent the corresponding method is a no-op, so
 * the same code runs locally (no files written) and in CI (files appended).
 *
 * @param env - Environment to read the file paths from. Default: `process.env`.
 */
export function createEnvWriter(env: NodeJS.ProcessEnv = process.env): ActionWriter {
  const outputPath = env.GITHUB_OUTPUT;
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  return {
    setOutput(name, value) {
      if (!outputPath) return;
      appendFileSync(outputPath, formatOutputLine(name, value) + EOL, 'utf8');
    },
    appendSummary(markdown) {
      if (!summaryPath) return;
      // Step summaries accumulate across appends; keep a trailing blank line so
      // successive blocks don't run together.
      appendFileSync(summaryPath, markdown.endsWith('\n') ? markdown : markdown + EOL, 'utf8');
    },
  };
}

/**
 * An in-memory writer that records what *would* be written. Useful for tests
 * and for previewing the effect of a run without a real runner.
 */
export interface MemoryWriter extends ActionWriter {
  /** Outputs captured so far, in call order. */
  readonly outputs: Array<{ name: string; value: string }>;
  /** Summary blocks captured so far, in call order. */
  readonly summaries: string[];
}

/** Create a {@link MemoryWriter}. */
export function createMemoryWriter(): MemoryWriter {
  const outputs: Array<{ name: string; value: string }> = [];
  const summaries: string[] = [];
  return {
    outputs,
    summaries,
    setOutput(name, value) {
      outputs.push({ name, value });
    },
    appendSummary(markdown) {
      summaries.push(markdown);
    },
  };
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────────

/**
 * Build a scorecard from a transcripts root and evaluate it for CI, returning
 * everything an Action step needs (evaluation, outputs, summary, build stats).
 * Pure read-of-record: this does NOT touch the runner environment — call
 * {@link emitActionResult} to actually write outputs / summary and propagate
 * the exit code.
 *
 * @param root - Transcripts root containing per-worker subdirectories.
 * @param options - Scorecard window/thresholds plus gate/no-data/score-floor.
 */
export function runActionEval(
  root: string,
  options: RunActionEvalOptions = {},
): RunActionEvalResult {
  const build = buildScorecard(root, options);
  const evaluation = evaluateForAction(build.scorecard, options);
  const outputs = toActionOutputs(evaluation);
  const summary = renderActionSummary(evaluation, { title: options.title ?? 'Agent Eval' });
  return { evaluation, outputs, summary, build };
}

/**
 * Emit an {@link ActionEvaluation} to a CI runner: write every Action output,
 * append the step summary, and return the exit code. Does NOT call
 * `process.exit` itself — the caller decides when to exit so it can flush logs
 * first (`process.exitCode = emitActionResult(...)`).
 *
 * @param evaluation - Result of {@link evaluateForAction} / {@link runActionEval}.
 * @param options.writer - Where to write. Default: {@link createEnvWriter}()
 *   (the real `$GITHUB_OUTPUT` / `$GITHUB_STEP_SUMMARY`).
 * @param options.title - Summary heading. Default: "Agent Eval".
 * @returns The process exit code (0 pass / 1 fail).
 */
export function emitActionResult(
  evaluation: ActionEvaluation,
  options: { writer?: ActionWriter; title?: string } = {},
): 0 | 1 {
  const writer = options.writer ?? createEnvWriter();
  const outputs = toActionOutputs(evaluation);
  for (const [name, value] of Object.entries(outputs)) {
    writer.setOutput(name, value);
  }
  writer.appendSummary(renderActionSummary(evaluation, { title: options.title ?? 'Agent Eval' }));
  return evaluation.exitCode;
}

/**
 * Convenience: build, evaluate, emit, and return the exit code in one call —
 * the body of a minimal CI eval step. Equivalent to {@link runActionEval}
 * followed by {@link emitActionResult}, sharing the one summary render.
 *
 * @param root - Transcripts root.
 * @param options - Scorecard + gate options; `writer` selects the I/O target.
 * @returns The evaluation result and the resolved exit code.
 */
export function runAndEmit(
  root: string,
  options: RunActionEvalOptions & { writer?: ActionWriter } = {},
): { result: RunActionEvalResult; exitCode: 0 | 1 } {
  const result = runActionEval(root, options);
  const writer = options.writer ?? createEnvWriter();
  const outputs = result.outputs;
  for (const [name, value] of Object.entries(outputs)) {
    writer.setOutput(name, value);
  }
  writer.appendSummary(result.summary);
  return { result, exitCode: result.evaluation.exitCode };
}
