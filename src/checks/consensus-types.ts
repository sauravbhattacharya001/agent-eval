/**
 * Consensus Judge - Type Vocabulary
 *
 * The configuration and result shapes shared by the consensus engine
 * (`./consensus-analysis.js`) and the public barrel (`./consensus.js`):
 * consensus run options/result, per-criterion agreement, and the
 * adversarial / cross-model judge option shapes. Kept dependency-free so the
 * engine and any consumer can import them without pulling in runtime code.
 *
 * @tier 3 - Enhanced Judgment (more reliable than single-shot judge)
 * @module
 */

import type { JudgeBackend, JudgeResult, RawJudgeResponse } from './judge.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** Configuration for consensus judging. */
export interface ConsensusOptions {
  /** Number of evaluation samples to take. Default: 3 */
  samples?: number;
  /** Maximum allowed score range before flagging disagreement. Default: 1 */
  maxDisagreement?: number;
  /** Minimum agreement ratio to trust the result. Default: 0.7 */
  minAgreement?: number;
}

/** Result of consensus judging. */
export interface ConsensusResult {
  /** The final judge result using median scores. */
  result: JudgeResult;
  /** Individual sample results (raw responses). */
  sampleResponses: RawJudgeResponse[];
  /** Per-criterion agreement info. */
  agreement: CriterionAgreement[];
  /** Overall agreement ratio (1.0 = all samples identical). */
  overallAgreement: number;
  /** Criteria where samples disagreed significantly. */
  disagreements: string[];
  /** Whether the consensus is trustworthy. */
  trustworthy: boolean;
}

/** Agreement info for a single criterion. */
export interface CriterionAgreement {
  criterionId: string;
  /** Scores from each sample. */
  scores: number[];
  /** Median score (used as final). */
  median: number;
  /** Score range (max - min). */
  range: number;
  /** Whether this criterion had disagreement. */
  disagreed: boolean;
}

/** Configuration for adversarial judging. */
export interface AdversarialOptions {
  /** Whether to prepend adversarial framing to the judge prompt. Default: true */
  adversarial?: boolean;
  /** Whether to instruct "pick the lower score when uncertain". Default: true */
  strictScoring?: boolean;
  /** Whether to require weakness identification before scoring. Default: true */
  weaknessFirst?: boolean;
}

/** Configuration for cross-model judging. */
export interface CrossModelOptions {
  /** Primary backend (for the output being judged). */
  primaryBackend: JudgeBackend;
  /** Secondary backend (the actual judge). Must be a different model. */
  judgeBackend: JudgeBackend;
}