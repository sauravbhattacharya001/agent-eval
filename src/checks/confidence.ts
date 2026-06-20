/**
 * Confidence Labeling — Multi-Signal Verdict Reliability
 *
 * Determines when a judge verdict should be marked "needs-human-review" instead
 * of issuing a definitive pass/fail. Aggregates MULTIPLE confidence signals:
 *
 * 1. Self-reported confidence — what the judge says about its own certainty
 * 2. Evidence quality — how much evidence backs the scores
 * 3. Score consistency — do related criteria agree or contradict?
 * 4. Boundary proximity — is the overall score right at the pass/fail line?
 * 5. Coverage completeness — were all criteria actually scored?
 * 6. Reasoning quality — are justifications substantive or boilerplate?
 *
 * This file is the **public barrel** for confidence labeling and the home of the
 * assertion factories + the `ConfidenceAwareJudge` that wrap the analysis engine
 * into Jest/Vitest-style assertions. The supporting seams live alongside it and
 * are re-exported here so the public surface stays a single `./confidence.js`
 * import path:
 * - ./confidence-types.js    — the type vocabulary (signals, assessment, options)
 * - ./confidence-analysis.js — signal extractors + assessConfidence / labelVerdict
 *
 * @tier 3 — Meta-evaluation (evaluates the evaluator's certainty)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';
import type {
  JudgeBackend,
  Rubric,
  JudgeOptions,
} from './judge.js';
import { JudgeEvaluator } from './judge.js';
import { labelVerdict } from './confidence-analysis.js';
import type {
  ConfidenceLabelingOptions,
  LabeledVerdict,
} from './confidence-types.js';

// ─── TYPE RE-EXPORTS ───────────────────────────────────────
// The confidence type vocabulary lives in ./confidence-types.js; re-export it
// here so consumers keep a single `./confidence.js` import path.
export type {
  ConfidenceSignal,
  ConfidenceSignalId,
  ConfidenceAssessment,
  ConfidenceRecommendation,
  ConfidenceLabelingOptions,
  LabeledVerdict,
} from './confidence-types.js';

// ─── ANALYSIS RE-EXPORTS ───────────────────────────────────
// The deterministic engine (signal extractors + aggregation + labeling) lives
// alongside; re-export the public functions so the barrel is the single surface.
export {
  extractSelfReportedConfidence,
  extractEvidenceQuality,
  extractScoreConsistency,
  extractBoundaryProximity,
  extractCoverageCompleteness,
  extractReasoningQuality,
  assessConfidence,
  labelVerdict,
} from './confidence-analysis.js';

// ═══ CONFIDENCE-AWARE JUDGE ══════════════════════════════════════════════════════

/**
 * A judge evaluator that automatically applies confidence labeling.
 */
export class ConfidenceAwareJudge {
  private backend: JudgeBackend;
  private rubric: Rubric;
  private judgeOptions: JudgeOptions;
  private confidenceOptions: ConfidenceLabelingOptions;

  constructor(
    backend: JudgeBackend,
    rubric: Rubric,
    confidenceOptions?: ConfidenceLabelingOptions,
    judgeOptions?: JudgeOptions,
  ) {
    this.backend = backend;
    this.rubric = rubric;
    this.confidenceOptions = {
      passThreshold: rubric.passThreshold ?? judgeOptions?.passThreshold ?? 0.6,
      ...confidenceOptions,
    };
    this.judgeOptions = judgeOptions ?? {};
  }

  async evaluate(
    output: string,
    context: { task: string; references?: string[]; artifacts?: Record<string, string> },
  ): Promise<LabeledVerdict> {
    const evaluator = new JudgeEvaluator(this.backend, this.rubric, this.judgeOptions);
    const result = await evaluator.evaluate(output, context);
    return labelVerdict(result, this.rubric.criteria.length, this.confidenceOptions);
  }

  getRubric(): Rubric { return this.rubric; }
  getConfidenceOptions(): ConfidenceLabelingOptions { return { ...this.confidenceOptions }; }
}

// ═══ ASSERTION FACTORIES ═════════════════════════════════════════════════════════

/**
 * Assertion that evaluates with confidence labeling.
 * Uses multi-signal confidence to determine whether to trust the verdict.
 * @tier 3
 */
export function toPassWithConfidence(
  backend: JudgeBackend,
  rubric: Rubric,
  confidenceOptions?: ConfidenceLabelingOptions,
  judgeOptions?: JudgeOptions,
): Assertion {
  const judge = new ConfidenceAwareJudge(backend, rubric, confidenceOptions, judgeOptions);
  return {
    name: `[Tier 3] confidence-labeled judge: ${rubric.name}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const labeled = await judge.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });
        const status = labeled.labeledVerdict === 'pass' ? 'pass'
          : labeled.labeledVerdict === 'needs-human-review' ? 'skip' : 'fail';
        const overrideNote = labeled.overridden ? ` [OVERRIDDEN from ${labeled.originalVerdict}]` : '';
        const minConf = judge.getConfidenceOptions().minConfidence ?? 0.6;
        return {
          status,
          name: `[Tier 3] confidence-labeled judge: ${rubric.name}`,
          message: status === 'pass' ? undefined
            : status === 'skip' ? `${labeled.assessment.summary}${overrideNote}`
            : `Judge verdict: fail (score=${labeled.judgeResult.overallScore.toFixed(2)})`,
          expected: `pass with confidence >= ${minConf}`,
          actual: `${labeled.labeledVerdict} (score=${labeled.judgeResult.overallScore.toFixed(2)}, confidence=${labeled.assessment.overallConfidence.toFixed(2)})`,
          evidence: labeled.assessment.signals.map((s) => `${s.name}: ${s.score.toFixed(2)}${s.flagged ? ' \u26A0\uFE0F' : ''}`).join('\n'),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 3] confidence-labeled judge: ${rubric.name}`,
          message: `Confidence-labeled evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assertion that checks multi-signal confidence is adequate.
 * @tier 3
 */
export function toHaveAdequateConfidence(
  backend: JudgeBackend,
  rubric: Rubric,
  minConfidence = 0.6,
  options?: ConfidenceLabelingOptions,
): Assertion {
  const judge = new ConfidenceAwareJudge(backend, rubric, { ...options, minConfidence });
  return {
    name: `[Tier 3] adequate confidence >= ${minConfidence}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const labeled = await judge.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });
        const pass = labeled.assessment.overallConfidence >= minConfidence;
        return {
          status: pass ? 'pass' : 'skip',
          name: `[Tier 3] adequate confidence >= ${minConfidence}`,
          message: pass ? undefined : `Confidence ${labeled.assessment.overallConfidence.toFixed(2)} below ${minConfidence}`,
          expected: `confidence >= ${minConfidence}`,
          actual: `${labeled.assessment.overallConfidence.toFixed(2)} (${labeled.assessment.recommendation})`,
          evidence: labeled.assessment.flaggedSignals.map((s) => `${s.name}: ${s.reasoning}`).join('\n'),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 3] adequate confidence >= ${minConfidence}`,
          message: `Confidence assessment failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assertion that requires no confidence signals to be flagged.
 * @tier 3
 */
export function toHaveNoConfidenceFlags(
  backend: JudgeBackend,
  rubric: Rubric,
  options?: ConfidenceLabelingOptions,
): Assertion {
  const judge = new ConfidenceAwareJudge(backend, rubric, options);
  return {
    name: '[Tier 3] no confidence flags',
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const labeled = await judge.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });
        const flags = labeled.assessment.flaggedSignals;
        const pass = flags.length === 0;
        return {
          status: pass ? 'pass' : 'skip',
          name: '[Tier 3] no confidence flags',
          message: pass ? undefined : `${flags.length} signal(s) flagged: ${flags.map((s) => s.name).join(', ')}`,
          expected: '0 flagged signals',
          actual: `${flags.length} flagged`,
          evidence: flags.map((s) => `${s.name}: ${s.reasoning}`).join('\n'),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: '[Tier 3] no confidence flags',
          message: `Confidence assessment failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assertion that checks verdict was NOT overridden by confidence labeling.
 * @tier 3
 */
export function toNotBeOverridden(
  backend: JudgeBackend,
  rubric: Rubric,
  options?: ConfidenceLabelingOptions,
): Assertion {
  const judge = new ConfidenceAwareJudge(backend, rubric, options);
  return {
    name: '[Tier 3] verdict not overridden',
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const labeled = await judge.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });
        const pass = !labeled.overridden;
        return {
          status: pass ? 'pass' : 'fail',
          name: '[Tier 3] verdict not overridden',
          message: pass ? undefined
            : `Verdict overridden from ${labeled.originalVerdict} to ${labeled.labeledVerdict}: ${labeled.assessment.summary}`,
          expected: 'verdict accepted without override',
          actual: labeled.overridden
            ? `overridden (${labeled.originalVerdict} → ${labeled.labeledVerdict})`
            : `accepted (${labeled.labeledVerdict})`,
          evidence: labeled.assessment.flaggedSignals.map((s) => `${s.name}: ${s.reasoning}`).join('\n'),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: '[Tier 3] verdict not overridden',
          message: `Confidence assessment failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}