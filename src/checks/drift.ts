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
  JudgeResult,
  JudgeOptions,
} from './judge.js';
import {
  JudgeEvaluator,
} from './judge.js';
// The built-in drift rubric — a static, self-contained Tier 3 artifact with no
// dependency on the drift engine — lives in a leaf module so it is importable
// without this orchestrator (matching ./drift-types.ts). Imported here for the
// judge calls and re-exported below so the public surface is unchanged.
// See ./drift-rubric.ts.
import { DRIFT_RUBRIC } from './drift-rubric.js';
// Task decomposition and output segmentation — the two structural passes that
// run before any drift scoring — live in a sibling module so this file stays
// focused on the drift reasoning itself. The structural types they produce
// (TaskRequirement, OutputSegment) are co-located with them; TaskRequirement is
// imported here for the summary signature, and both are re-exported below so the
// public surface is unchanged. See ./drift-segmentation.ts.
import type { TaskRequirement } from './drift-segmentation.js';
import { decomposeTask, segmentOutput } from './drift-segmentation.js';
// The detection pass — requirement→segment mapping and drift-pattern detection —
// lives in a sibling module so this file stays focused on orchestration, scoring,
// the rubric, and assertions. Its two public functions are re-exported below so
// the surface is unchanged; the marker tables and checkActionMatch it uses are
// private to it (they had no other consumer). See ./drift-detection.ts.
import { mapRequirementsToSegments, detectDriftIssues } from './drift-detection.js';
// The drift type vocabulary (DriftKind, DriftIssue, DriftAnalysisOptions,
// DriftAnalysisResult) lives in a leaf module so the sibling passes can depend on
// it directly instead of importing back up into this orchestrator, and so the
// type surface is importable without the engine. Re-exported below so the public
// surface (`./drift.js`) is unchanged. See ./drift-types.ts.
import type {
  DriftKind,
  DriftIssue,
  DriftAnalysisOptions,
  DriftAnalysisResult,
} from './drift-types.js';

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
// The drift type vocabulary is defined in the leaf ./drift-types.ts. Re-exported
// here so `checks/index.ts` (and the public barrel) keep resolving these types,
// and every consumer, from './drift.js'.
export type {
  DriftKind,
  DriftIssue,
  DriftAnalysisOptions,
  DriftAnalysisResult,
} from './drift-types.js';

// ═══ ANALYSIS ═══════════════════════════════════════════════════════════════════

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

// DRIFT_RUBRIC is defined in the leaf ./drift-rubric.ts. Re-exported here so
// `checks/index.ts` (and the public barrel) keep resolving it — and every
// consumer — from './drift.js'.
export { DRIFT_RUBRIC } from './drift-rubric.js';

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
