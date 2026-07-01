/**
 * Drift Judge - type vocabulary
 *
 * Pure type/interface definitions for the drift check (Tier 3). Extracted from
 * `drift.ts` so the type surface can be imported without pulling in the analysis
 * engine, the built-in rubric, or the Tier-3 judge wiring - and so the sibling
 * passes (`drift-detection.ts`) that produce {@link DriftIssue}s can depend on the
 * vocabulary directly instead of reaching back up into their orchestrator.
 * Re-exported from `./drift.js`, so consumers keep a single public import path.
 *
 * @tier 3 - Shared-Substrate Judgment
 * @module
 */

import type { JudgeBackend, JudgeResult, JudgeOptions } from './judge.js';
import type { TaskRequirement, OutputSegment } from './drift-segmentation.js';

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
