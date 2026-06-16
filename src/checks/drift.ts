/**
 * Drift Judge — Tier 3 "Did output address the task or go off-topic?"
 *
 * This module detects when an agent's output drifts from its assigned task.
 * Unlike the Tier 2 relevance module (TF-IDF cosine similarity), this judge
 * understands SEMANTIC drift — when output is superficially related to the topic
 * but doesn't actually address what was asked.
 *
 * Examples of drift that Tier 2 might miss:
 * - Task: "Fix the login bug" → Output: long essay about auth best practices (same domain, wrong action)
 * - Task: "Review this PR" → Output: rewrites the code instead of reviewing it
 * - Task: "Explain error X" → Output: explains errors Y and Z (related but wrong)
 * - Task: "Add tests for module A" → Output: refactors module A without adding tests
 *
 * Architecture:
 * 1. Task decomposition — break task into concrete requirements (what + action + scope)
 * 2. Output segmentation — identify distinct sections/topics in the output
 * 3. Requirement coverage — map which requirements are addressed vs. ignored
 * 4. Tangent detection — identify output sections that address NO requirements
 * 5. Confidence scoring — certainty of the drift/no-drift verdict
 *
 * @tier 3 — Shared-Substrate Judgment (uses judge when heuristics are ambiguous)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';
import type {
  JudgeBackend,
  Rubric,
  JudgeResult,
  JudgeOptions,
} from './judge.js';
import {
  buildRubric,
  JudgeEvaluator,
} from './judge.js';
// Task decomposition and output segmentation — the two structural passes that
// run before any drift scoring — live in a sibling module so this file stays
// focused on the drift reasoning itself. The structural types they produce
// (TaskRequirement, OutputSegment) are co-located with them and re-exported
// below so the public surface is unchanged. See ./drift-segmentation.ts.
import type { TaskRequirement, OutputSegment } from './drift-segmentation.js';
import { decomposeTask, segmentOutput } from './drift-segmentation.js';
// The detection pass — requirement→segment mapping and drift-pattern detection —
// lives in a sibling module so this file stays focused on orchestration, scoring,
// the rubric, and assertions. Its two public functions are re-exported below so
// the surface is unchanged; the marker tables and checkActionMatch it uses are
// private to it (they had no other consumer). See ./drift-detection.ts.
import { mapRequirementsToSegments, detectDriftIssues } from './drift-detection.js';

// ═══ TYPES ═══════════════════════════════════════════════════════════════════════

// TaskRequirement and OutputSegment are defined alongside the decomposition /
// segmentation passes that produce them (./drift-segmentation.ts). Re-exported
// here so `checks/index.ts` (and the public barrel) keep importing them, and
// every consumer, from './drift.js'.
export type { TaskRequirement, OutputSegment } from './drift-segmentation.js';
export { decomposeTask, segmentOutput } from './drift-segmentation.js';
// mapRequirementsToSegments and detectDriftIssues are defined in the detection
// pass (./drift-detection.ts). Re-exported here so `checks/index.ts` (and the
// public barrel) keep resolving them — and every consumer — from './drift.js'.
export { mapRequirementsToSegments, detectDriftIssues } from './drift-detection.js';

/** Classification of a drift issue. */
export type DriftKind =
  | 'off-topic'          // Output is about a completely different subject
  | 'wrong-action'       // Right subject, wrong action (review→rewrite, explain→fix)
  | 'scope-creep'        // Addresses the task but also adds unrequested work
  | 'partial-address'    // Only addresses part of the task, ignores the rest
  | 'tangential'         // Related to the domain but doesn't address the task
  | 'task-substitution'; // Answers a DIFFERENT but related question

/** A specific drift issue found in the output. */
export interface DriftIssue {
  /** What kind of drift was detected. */
  kind: DriftKind;
  /** Human-readable description of the drift. */
  description: string;
  /** Severity of this drift (0–1). 1 = completely off-topic. */
  severity: number;
  /** Evidence from the output supporting this finding. */
  evidence: string[];
  /** Which segment(s) exhibit this drift (by index). */
  segmentIndices: number[];
  /** Which requirements are missed due to this drift. */
  missedRequirements: number[];
}

/** Options for drift analysis. */
export interface DriftAnalysisOptions {
  /** Minimum relevance score for a segment to "address" a requirement. Default: 0.15 */
  relevanceThreshold?: number;
  /** Minimum proportion of requirements addressed to pass. Default: 0.6 */
  coverageThreshold?: number;
  /** Maximum proportion of output that can be tangential. Default: 0.4 */
  maxTangentRatio?: number;
  /** Whether to use judge backend for ambiguous cases. Default: false (rule-based only) */
  useJudge?: boolean;
  /** Judge backend to use for Tier 3 evaluation. */
  judgeBackend?: JudgeBackend;
  /** Judge options (thresholds, retries). */
  judgeOptions?: JudgeOptions;
  /** Custom action verbs to recognize in task decomposition. */
  extraActionVerbs?: string[];
}

/** Full result of drift analysis. */
export interface DriftAnalysisResult {
  /** Whether the output is on-task (no significant drift). */
  onTask: boolean;
  /** Overall drift score (0 = perfectly on-task, 1 = completely off-topic). */
  driftScore: number;
  /** Confidence in the analysis (0–1). */
  confidence: number;
  /** Whether the verdict is "needs-human-review" due to low confidence. */
  needsReview: boolean;
  /** Requirements extracted from the task. */
  requirements: TaskRequirement[];
  /** Segments identified in the output. */
  segments: OutputSegment[];
  /** Proportion of requirements addressed (0–1). */
  requirementCoverage: number;
  /** Proportion of output text that's tangential (0–1). */
  tangentRatio: number;
  /** Specific drift issues found. */
  issues: DriftIssue[];
  /** Summary explanation. */
  summary: string;
  /** Judge result (if Tier 3 was used). */
  judgeResult?: JudgeResult;
  /** Analysis duration in ms. */
  durationMs: number;
}

// ═══ CONSTANTS ══════════════════════════════════════════════════════════════════
//
// The scope-creep and task-substitution marker tables now live alongside the
// detection pass that consumes them (./drift-detection.ts), since nothing else
// referenced them. The built-in DRIFT_RUBRIC constant remains further below,
// next to the judge wiring that uses it.

// ═══ MAIN ANALYSIS ══════════════════════════════════════════════════════════════

/**
 * Perform full drift analysis on agent output against its assigned task.
 *
 * This is the main entry point for the drift detection module. It:
 * 1. Decomposes the task into requirements
 * 2. Segments the output into topic blocks
 * 3. Maps requirements to segments
 * 4. Detects drift patterns
 * 5. Computes an overall drift score
 * 6. Optionally invokes a Tier 3 judge for ambiguous cases
 */
export async function analyzeDrift(
  task: string,
  output: string,
  options?: DriftAnalysisOptions,
): Promise<DriftAnalysisResult> {
  const startTime = performance.now();
  const relevanceThreshold = options?.relevanceThreshold ?? 0.15;
  const coverageThreshold = options?.coverageThreshold ?? 0.6;

  // Handle empty inputs
  if (!task || task.trim().length === 0) {
    return {
      onTask: true,
      driftScore: 0,
      confidence: 0.3,
      needsReview: true,
      requirements: [],
      segments: [],
      requirementCoverage: 0,
      tangentRatio: 0,
      issues: [],
      summary: 'Cannot analyze drift without a task — no task provided',
      durationMs: performance.now() - startTime,
    };
  }

  if (!output || output.trim().length === 0) {
    return {
      onTask: false,
      driftScore: 1,
      confidence: 0.9,
      needsReview: false,
      requirements: decomposeTask(task, options?.extraActionVerbs),
      segments: [],
      requirementCoverage: 0,
      tangentRatio: 1,
      issues: [{
        kind: 'off-topic',
        description: 'Empty output — agent produced nothing',
        severity: 1,
        evidence: ['Output is empty or whitespace-only'],
        segmentIndices: [],
        missedRequirements: [],
      }],
      summary: 'Output is empty — all requirements unaddressed',
      durationMs: performance.now() - startTime,
    };
  }

  // Step 1: Decompose task
  const requirements = decomposeTask(task, options?.extraActionVerbs);

  // Step 2: Segment output
  const rawSegments = segmentOutput(output);

  // Step 3: Map requirements to segments
  const segments = mapRequirementsToSegments(requirements, rawSegments, relevanceThreshold);

  // Step 4: Detect drift issues
  const issues = detectDriftIssues(task, requirements, segments, output, options);

  // Step 5: Compute coverage and tangent metrics
  const coveredRequirements = new Set<number>();
  for (const seg of segments) {
    for (const idx of seg.addressesRequirements) {
      coveredRequirements.add(idx);
    }
  }
  const requirementCoverage = requirements.length > 0
    ? coveredRequirements.size / requirements.length
    : 1;

  const tangentialChars = segments
    .filter((s) => s.addressesRequirements.length === 0)
    .reduce((sum, s) => sum + s.text.length, 0);
  const totalChars = segments.reduce((sum, s) => sum + s.text.length, 0);
  const tangentRatio = totalChars > 0 ? tangentialChars / totalChars : 0;

  // Step 6: Compute overall drift score
  // Drift score combines: (1 - coverage), tangent ratio, and issue severity
  const issueWeight = issues.length > 0
    ? Math.max(...issues.map((i) => i.severity))
    : 0;
  const driftScore = Math.min(1, Math.max(0,
    (1 - requirementCoverage) * 0.4 +
    tangentRatio * 0.3 +
    issueWeight * 0.3,
  ));

  // Step 7: Determine confidence
  // Higher confidence when evidence is clear (very high or very low drift)
  let confidence: number;
  if (driftScore > 0.8 || driftScore < 0.2) {
    confidence = 0.85; // Clear cases
  } else if (issues.length > 0) {
    confidence = 0.65; // Some evidence but ambiguous
  } else {
    confidence = 0.5; // Very uncertain
  }

  // Boost confidence if requirements decomposition was solid
  const avgReqConfidence = requirements.length > 0
    ? requirements.reduce((sum, r) => sum + r.confidence, 0) / requirements.length
    : 0.5;
  confidence = confidence * 0.7 + avgReqConfidence * 0.3;

  const needsReview = confidence < 0.6;
  const onTask = driftScore < (coverageThreshold > 0.5 ? 1 - coverageThreshold : 0.4);

  // Step 8: Optionally invoke Tier 3 judge for ambiguous cases
  let judgeResult: JudgeResult | undefined;
  if (options?.useJudge && options.judgeBackend && needsReview) {
    const evaluator = new JudgeEvaluator(
      options.judgeBackend,
      DRIFT_RUBRIC,
      options.judgeOptions,
    );
    judgeResult = await evaluator.evaluate(output, {
      task,
      artifacts: {
        requirements: requirements.map((r) => `[${r.action}] ${r.subject}`).join('\n'),
        coverage: `${(requirementCoverage * 100).toFixed(0)}% requirements addressed`,
        issues: issues.map((i) => `${i.kind}: ${i.description}`).join('\n'),
      },
    });
  }

  // Build summary
  const summary = buildSummary(onTask, driftScore, requirements, requirementCoverage, issues, judgeResult);

  return {
    onTask,
    driftScore,
    confidence,
    needsReview,
    requirements,
    segments,
    requirementCoverage,
    tangentRatio,
    issues,
    summary,
    judgeResult,
    durationMs: performance.now() - startTime,
  };
}

/**
 * Build a human-readable summary of the drift analysis.
 */
function buildSummary(
  onTask: boolean,
  driftScore: number,
  requirements: TaskRequirement[],
  coverage: number,
  issues: DriftIssue[],
  judgeResult?: JudgeResult,
): string {
  const parts: string[] = [];

  if (onTask) {
    parts.push(`Output is on-task (drift score: ${driftScore.toFixed(2)}).`);
  } else {
    parts.push(`Output has drifted from the task (drift score: ${driftScore.toFixed(2)}).`);
  }

  parts.push(`Addressed ${(coverage * 100).toFixed(0)}% of ${requirements.length} requirement(s).`);

  if (issues.length > 0) {
    const topIssues = issues
      .sort((a, b) => b.severity - a.severity)
      .slice(0, 3)
      .map((i) => `${i.kind} (severity: ${i.severity.toFixed(1)})`);
    parts.push(`Issues: ${topIssues.join(', ')}.`);
  }

  if (judgeResult) {
    parts.push(`Judge verdict: ${judgeResult.verdict} (score: ${judgeResult.overallScore.toFixed(2)}).`);
  }

  return parts.join(' ');
}

// ═══ BUILT-IN DRIFT RUBRIC ══════════════════════════════════════════════════════

/**
 * Built-in rubric for the drift judge.
 * Used when Tier 3 evaluation is needed for ambiguous drift cases.
 */
export const DRIFT_RUBRIC: Rubric = buildRubric('Task Drift Assessment')
  .describe('Evaluates whether an agent\'s output stays on-task or drifts off-topic')
  .passAt(0.6)
  .confidenceAt(0.65)
  .criterion('task-address', 'Does the output directly address the assigned task?')
    .level(1, 'Off-topic', 'Output is about a completely different topic than the task')
    .level(2, 'Tangential', 'Output is in the same domain but does not address the specific task')
    .level(3, 'Partial', 'Output addresses some aspects of the task but misses key requirements')
    .level(4, 'Mostly on-task', 'Output addresses the main task with minor tangents')
    .level(5, 'Fully on-task', 'Output directly and completely addresses all task requirements')
    .weight(0.4)
    .done()
  .criterion('action-alignment', 'Does the output perform the requested ACTION (not just discuss the topic)?')
    .level(1, 'Wrong action', 'Output performs a completely different action (e.g. rewrites instead of reviews)')
    .level(2, 'Misaligned', 'Output partially performs the action but mostly does something else')
    .level(3, 'Mixed', 'Some of the requested action is performed alongside other actions')
    .level(4, 'Mostly aligned', 'The requested action is performed with minor deviations')
    .level(5, 'Perfectly aligned', 'Output performs exactly the requested action on the requested subject')
    .weight(0.35)
    .done()
  .criterion('focus', 'How focused is the output on the task vs. tangential content?')
    .level(1, 'Unfocused', 'Mostly tangential content with the task buried or absent')
    .level(2, 'Scattered', 'Significant tangential content distracting from the task')
    .level(3, 'Adequate', 'Some tangents but the task is the primary focus')
    .level(4, 'Focused', 'Minimal tangents, almost entirely about the task')
    .level(5, 'Laser-focused', 'Every part of the output is directly relevant to the task')
    .weight(0.25)
    .done()
  .build();

// ═══ ASSERTION FACTORIES ════════════════════════════════════════════════════════

/**
 * Create an assertion that checks for task drift using the full analysis pipeline.
 *
 * This is the primary drift assertion — it decomposes the task, segments the output,
 * maps requirements, and detects drift patterns.
 *
 * @param options - Drift analysis options (thresholds, judge config)
 * @tier 3 — Uses heuristics (Tier 1+2) and optionally model-as-judge (Tier 3)
 */
export function toNotDrift(options?: DriftAnalysisOptions): Assertion {
  const threshold = 1 - (options?.coverageThreshold ?? 0.6);

  return {
    name: `[Tier 3] no task drift (max drift: ${threshold.toFixed(2)})`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] no task drift`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output, options);

      if (result.needsReview) {
        return {
          status: 'skip',
          name: `[Tier 3] no task drift`,
          message: `Low confidence (${result.confidence.toFixed(2)}) — needs human review`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      if (result.onTask) {
        return {
          status: 'pass',
          name: `[Tier 3] no task drift (max drift: ${threshold.toFixed(2)})`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: `[Tier 3] no task drift (max drift: ${threshold.toFixed(2)})`,
        message: result.summary,
        expected: `drift score < ${threshold.toFixed(2)}`,
        actual: `drift score = ${result.driftScore.toFixed(2)}`,
        evidence: result.issues.map((i) => `${i.kind}: ${i.description}`).join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that checks requirement coverage — what proportion
 * of the task's requirements are addressed in the output.
 *
 * @param minCoverage - Minimum proportion of requirements to address (0–1). Default: 0.6
 * @tier 3 — Multi-tier analysis (decomposition + relevance scoring)
 */
export function toAddressRequirements(minCoverage = 0.6): Assertion {
  return {
    name: `[Tier 3] addresses >= ${(minCoverage * 100).toFixed(0)}% of requirements`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] addresses requirements`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output);
      const pass = result.requirementCoverage >= minCoverage;

      return {
        status: pass ? 'pass' : 'fail',
        name: `[Tier 3] addresses >= ${(minCoverage * 100).toFixed(0)}% of requirements`,
        message: pass ? undefined :
          `Only ${(result.requirementCoverage * 100).toFixed(0)}% of requirements addressed (need ${(minCoverage * 100).toFixed(0)}%)`,
        expected: `>= ${(minCoverage * 100).toFixed(0)}% coverage`,
        actual: `${(result.requirementCoverage * 100).toFixed(0)}% (${result.requirements.filter((_, i) =>
          result.segments.some((s) => s.addressesRequirements.includes(i)),
        ).length}/${result.requirements.length})`,
        evidence: result.requirements.map((r, i) => {
          const covered = result.segments.some((s) => s.addressesRequirements.includes(i));
          return `${covered ? '\u2713' : '\u2717'} [${r.action}] ${r.subject}`;
        }).join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that checks the drift score is below a maximum.
 *
 * @param maxDrift - Maximum acceptable drift score (0–1). Default: 0.4
 * @tier 3 — Multi-tier analysis
 */
export function toHaveDriftBelow(maxDrift = 0.4): Assertion {
  return {
    name: `[Tier 3] drift score < ${maxDrift}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] drift score < ${maxDrift}`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output);

      if (result.needsReview) {
        return {
          status: 'skip',
          name: `[Tier 3] drift score < ${maxDrift}`,
          message: `Low confidence (${result.confidence.toFixed(2)}) — needs human review`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      const pass = result.driftScore < maxDrift;
      return {
        status: pass ? 'pass' : 'fail',
        name: `[Tier 3] drift score < ${maxDrift}`,
        message: pass ? undefined : `Drift score ${result.driftScore.toFixed(2)} exceeds maximum ${maxDrift}`,
        expected: `< ${maxDrift}`,
        actual: `${result.driftScore.toFixed(2)}`,
        evidence: result.summary,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that detects specific drift patterns.
 * Fails if any issue of the specified kind(s) is found above the severity threshold.
 *
 * @param kinds - Drift kinds to check for (or all if omitted)
 * @param maxSeverity - Maximum severity before failing. Default: 0.5
 * @tier 3 — Pattern-based detection
 */
export function toNotExhibitDrift(
  kinds?: DriftKind[],
  maxSeverity = 0.5,
): Assertion {
  const kindsLabel = kinds ? kinds.join(', ') : 'any';

  return {
    name: `[Tier 3] no ${kindsLabel} drift (severity < ${maxSeverity})`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] no ${kindsLabel} drift`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output);

      // Filter issues to the requested kinds
      const relevant = kinds
        ? result.issues.filter((i) => kinds.includes(i.kind))
        : result.issues;
      const severe = relevant.filter((i) => i.severity >= maxSeverity);

      if (severe.length === 0) {
        return {
          status: 'pass',
          name: `[Tier 3] no ${kindsLabel} drift (severity < ${maxSeverity})`,
          evidence: relevant.length === 0
            ? 'No drift issues detected'
            : `Minor issues below threshold: ${relevant.map((i) => i.kind).join(', ')}`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: `[Tier 3] no ${kindsLabel} drift (severity < ${maxSeverity})`,
        message: `${severe.length} drift issue(s) above severity ${maxSeverity}`,
        evidence: severe.map((i) =>
          `${i.kind} (severity: ${i.severity.toFixed(2)}): ${i.description}`,
        ).join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that uses the full Tier 3 judge for drift assessment.
 * This assertion always invokes the judge backend for maximum accuracy,
 * at the cost of requiring an LLM call.
 *
 * @param backend - Judge backend to use for evaluation
 * @param options - Judge options (thresholds, retries)
 * @tier 3 — Always invokes model-as-judge
 */
export function toPassDriftJudge(
  backend: JudgeBackend,
  options?: JudgeOptions,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, DRIFT_RUBRIC, options);

  return {
    name: `[Tier 3] drift judge: ${DRIFT_RUBRIC.name}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] drift judge`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      try {
        // First run heuristic analysis for context
        const driftResult = await analyzeDrift(task, output);

        const result = await evaluator.evaluate(output, {
          task,
          artifacts: {
            'heuristic-analysis': `Drift score: ${driftResult.driftScore.toFixed(2)}, ` +
              `Coverage: ${(driftResult.requirementCoverage * 100).toFixed(0)}%, ` +
              `Issues: ${driftResult.issues.map((i) => i.kind).join(', ') || 'none'}`,
            'requirements': driftResult.requirements.map((r) => `[${r.action}] ${r.subject}`).join('\n'),
          },
        });

        const status = result.verdict === 'pass' ? 'pass'
          : result.verdict === 'needs-human-review' ? 'skip'
          : 'fail';

        return {
          status,
          name: `[Tier 3] drift judge: ${DRIFT_RUBRIC.name}`,
          message: status === 'pass' ? undefined :
            status === 'skip'
              ? `Judge confidence too low (${result.confidenceValue.toFixed(2)}) — needs human review`
              : `Judge verdict: fail (score=${result.overallScore.toFixed(2)})`,
          expected: `pass (>= ${options?.passThreshold ?? DRIFT_RUBRIC.passThreshold ?? 0.6})`,
          actual: `${result.verdict} (score=${result.overallScore.toFixed(2)})`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] drift judge`,
          message: `Drift judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}
