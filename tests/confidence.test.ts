/**
 * Tests for confidence labeling module.
 */
import { describe, it, expect } from 'vitest';
import {
  extractSelfReportedConfidence,
  extractEvidenceQuality,
  extractScoreConsistency,
  extractBoundaryProximity,
  extractCoverageCompleteness,
  extractReasoningQuality,
  assessConfidence,
  labelVerdict,
  ConfidenceAwareJudge,
  toPassWithConfidence,
  toHaveAdequateConfidence,
  toHaveNoConfidenceFlags,
  toNotBeOverridden,
} from '../src/checks/confidence.js';
import type { JudgeResult, CriterionScore, JudgeBackend, RawJudgeResponse } from '../src/checks/judge.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────────

/**
 * Minimal typed JudgeBackend stub. These tests only exercise judge metadata
 * (rubric/options/assertion-factory names), never the evaluate() path, so the
 * stub returns an empty-but-valid RawJudgeResponse rather than being cast to any.
 */
function makeMockBackend(): JudgeBackend {
  return {
    name: 'mock-backend',
    evaluate: async (): Promise<RawJudgeResponse> => ({
      scores: [],
      summary: '',
      suggestions: [],
    }),
  };
}

function makeJudgeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    verdict: 'pass',
    overallScore: 0.82,
    confidenceValue: 0.85,
    confidence: 'high',
    criterionScores: [
      {
        criterionId: 'accuracy',
        rawScore: 4,
        normalizedScore: 0.8,
        maxScore: 5,
        reasoning: 'The output accurately addresses the core question with correct information and relevant examples.',
        evidence: ['Correctly identifies the main concept', 'Provides relevant example'],
        confidence: 0.9,
      },
      {
        criterionId: 'clarity',
        rawScore: 4,
        normalizedScore: 0.85,
        maxScore: 5,
        reasoning: 'Writing is clear, well-structured, and easy to follow with logical progression.',
        evidence: ['Uses clear headings', 'Logical paragraph structure'],
        confidence: 0.8,
      },
    ] as CriterionScore[],
    rubricName: 'test-rubric',
    reasoning: 'Overall strong performance',
    suggestions: [],
    rawResponse: '{}',
    ...overrides,
  };
}

// ─── Self-Reported Confidence ───────────────────────────────────────────────────

describe('extractSelfReportedConfidence', () => {
  it('returns high score for high confidence value', () => {
    const result = makeJudgeResult({ confidenceValue: 0.9 });
    const signal = extractSelfReportedConfidence(result, {});
    expect(signal.id).toBe('self-reported');
    expect(signal.score).toBe(0.9);
    expect(signal.flagged).toBe(false);
    expect(signal.reasoning).toContain('high confidence');
  });

  it('returns moderate for mid-range confidence', () => {
    const result = makeJudgeResult({ confidenceValue: 0.6 });
    const signal = extractSelfReportedConfidence(result, {});
    expect(signal.score).toBe(0.6);
    expect(signal.flagged).toBe(false);
    expect(signal.reasoning).toContain('moderate confidence');
  });

  it('flags low confidence below threshold', () => {
    const result = makeJudgeResult({ confidenceValue: 0.3 });
    const signal = extractSelfReportedConfidence(result, {});
    expect(signal.score).toBe(0.3);
    expect(signal.flagged).toBe(true);
    expect(signal.reasoning).toContain('LOW confidence');
  });

  it('respects custom minSelfReported threshold', () => {
    const result = makeJudgeResult({ confidenceValue: 0.5 });
    const signal = extractSelfReportedConfidence(result, { minSelfReported: 0.6 });
    expect(signal.flagged).toBe(true);
  });

  it('uses default weight from signal weights config', () => {
    const result = makeJudgeResult({ confidenceValue: 0.8 });
    const signal = extractSelfReportedConfidence(result, {});
    expect(signal.weight).toBe(0.25);
  });

  it('uses custom weight when provided', () => {
    const result = makeJudgeResult({ confidenceValue: 0.8 });
    const signal = extractSelfReportedConfidence(result, {
      signalWeights: { 'self-reported': 0.5 },
    });
    expect(signal.weight).toBe(0.5);
  });
});

// ─── Evidence Quality ───────────────────────────────────────────────────────────

describe('extractEvidenceQuality', () => {
  it('returns high score when all criteria have evidence', () => {
    const result = makeJudgeResult();
    const signal = extractEvidenceQuality(result, {});
    expect(signal.score).toBeGreaterThan(0.9);
    expect(signal.flagged).toBe(false);
  });

  it('flags when less than half criteria have evidence', () => {
    const result = makeJudgeResult({
      criterionScores: [
        {
          criterionId: 'accuracy',
          rawScore: 4,
          normalizedScore: 0.8,
          maxScore: 5,
          reasoning: 'Good',
          evidence: [],
          confidence: 0.9,
        },
        {
          criterionId: 'clarity',
          rawScore: 4,
          normalizedScore: 0.85,
          maxScore: 5,
          reasoning: 'Clear',
          evidence: [],
          confidence: 0.8,
        },
      ] as CriterionScore[],
    });
    const signal = extractEvidenceQuality(result, {});
    expect(signal.flagged).toBe(true);
    expect(signal.score).toBe(0);
  });

  it('returns zero score for no criteria', () => {
    const result = makeJudgeResult({ criterionScores: [] });
    const signal = extractEvidenceQuality(result, {});
    expect(signal.score).toBe(0);
    expect(signal.flagged).toBe(true);
  });

  it('applies richness bonus for many evidence items', () => {
    const result = makeJudgeResult({
      criterionScores: [
        {
          criterionId: 'accuracy',
          rawScore: 4,
          normalizedScore: 0.8,
          maxScore: 5,
          reasoning: 'Detailed analysis of the output covering multiple aspects.',
          evidence: ['Evidence 1', 'Evidence 2', 'Evidence 3', 'Evidence 4'],
          confidence: 0.9,
        },
      ] as CriterionScore[],
    });
    const signal = extractEvidenceQuality(result, {});
    expect(signal.score).toBeGreaterThan(1.0 - 0.001); // ratio=1 + bonus
  });

  it('respects custom minEvidencePerCriterion', () => {
    const result = makeJudgeResult(); // 2 evidence items per criterion
    const signal = extractEvidenceQuality(result, { minEvidencePerCriterion: 3 });
    expect(signal.flagged).toBe(true); // needs 3, only has 2
  });
});

// ─── Score Consistency ──────────────────────────────────────────────────────────

describe('extractScoreConsistency', () => {
  it('returns high score for consistent scores', () => {
    const result = makeJudgeResult({
      criterionScores: [
        { criterionId: 'a', rawScore: 4, normalizedScore: 0.8, maxScore: 5, reasoning: 'Good analysis', evidence: ['e'], confidence: 0.9 },
        { criterionId: 'b', rawScore: 4, normalizedScore: 0.82, maxScore: 5, reasoning: 'Good analysis', evidence: ['e'], confidence: 0.85 },
      ] as CriterionScore[],
    });
    const signal = extractScoreConsistency(result, {});
    expect(signal.score).toBeGreaterThan(0.9);
    expect(signal.flagged).toBe(false);
  });

  it('flags wildly inconsistent scores', () => {
    const result = makeJudgeResult({
      criterionScores: [
        { criterionId: 'a', rawScore: 5, normalizedScore: 1.0, maxScore: 5, reasoning: 'Perfect output', evidence: ['e'], confidence: 0.9 },
        { criterionId: 'b', rawScore: 1, normalizedScore: 0.2, maxScore: 5, reasoning: 'Very poor', evidence: ['e'], confidence: 0.9 },
      ] as CriterionScore[],
    });
    const signal = extractScoreConsistency(result, {});
    expect(signal.flagged).toBe(true);
    expect(signal.reasoning).toContain('Large score range');
  });

  it('returns 1.0 for single criterion', () => {
    const result = makeJudgeResult({
      criterionScores: [
        { criterionId: 'only', rawScore: 3, normalizedScore: 0.6, maxScore: 5, reasoning: 'Adequate response', evidence: ['e'], confidence: 0.7 },
      ] as CriterionScore[],
    });
    const signal = extractScoreConsistency(result, {});
    expect(signal.score).toBe(1.0);
    expect(signal.flagged).toBe(false);
  });

  it('respects custom maxScoreRange', () => {
    const result = makeJudgeResult({
      criterionScores: [
        { criterionId: 'a', rawScore: 5, normalizedScore: 0.9, maxScore: 5, reasoning: 'Strong output', evidence: ['e'], confidence: 0.9 },
        { criterionId: 'b', rawScore: 3, normalizedScore: 0.5, maxScore: 5, reasoning: 'Middling output', evidence: ['e'], confidence: 0.7 },
      ] as CriterionScore[],
    });
    // Range = 0.4, default max = 0.6, so NOT flagged
    const signal1 = extractScoreConsistency(result, {});
    expect(signal1.flagged).toBe(false);
    // With custom max = 0.3, now flagged
    const signal2 = extractScoreConsistency(result, { maxScoreRange: 0.3 });
    expect(signal2.flagged).toBe(true);
  });
});

// ─── Boundary Proximity ─────────────────────────────────────────────────────────

describe('extractBoundaryProximity', () => {
  it('returns high score for score far from threshold', () => {
    const result = makeJudgeResult({ overallScore: 0.9 });
    const signal = extractBoundaryProximity(result, {});
    expect(signal.score).toBe(1.0);
    expect(signal.flagged).toBe(false);
    expect(signal.reasoning).toContain('clear pass');
  });

  it('flags score at the threshold', () => {
    const result = makeJudgeResult({ overallScore: 0.6 });
    const signal = extractBoundaryProximity(result, {});
    expect(signal.flagged).toBe(true);
    expect(signal.reasoning).toContain('AT the threshold');
  });

  it('flags score near the threshold within margin', () => {
    const result = makeJudgeResult({ overallScore: 0.55 });
    const signal = extractBoundaryProximity(result, {});
    expect(signal.flagged).toBe(true);
    expect(signal.reasoning).toContain('borderline');
  });

  it('marks clear fail when far below threshold', () => {
    const result = makeJudgeResult({ overallScore: 0.3 });
    const signal = extractBoundaryProximity(result, {});
    expect(signal.score).toBe(1.0);
    expect(signal.flagged).toBe(false);
    expect(signal.reasoning).toContain('clear fail');
  });

  it('respects custom passThreshold and borderlineMargin', () => {
    const result = makeJudgeResult({ overallScore: 0.72 });
    const signal = extractBoundaryProximity(result, { passThreshold: 0.7, borderlineMargin: 0.05 });
    expect(signal.flagged).toBe(true); // 0.72 is within 0.05 of 0.7
  });
});

// ─── Coverage Completeness ──────────────────────────────────────────────────────

describe('extractCoverageCompleteness', () => {
  it('returns 1.0 when all criteria are scored', () => {
    const result = makeJudgeResult(); // 2 criteria
    const signal = extractCoverageCompleteness(result, 2, {});
    expect(signal.score).toBe(1.0);
    expect(signal.flagged).toBe(false);
  });

  it('flags when coverage is below 80%', () => {
    const result = makeJudgeResult(); // 2 criteria scored
    const signal = extractCoverageCompleteness(result, 5, {}); // expected 5
    expect(signal.flagged).toBe(true);
    expect(signal.score).toBe(0.4); // 2/5
  });

  it('detects unscored criteria', () => {
    const result = makeJudgeResult({
      criterionScores: [
        { criterionId: 'a', rawScore: 4, normalizedScore: 0.8, maxScore: 5, reasoning: 'Well written and thorough analysis', evidence: ['e'], confidence: 0.9 },
        { criterionId: 'b', rawScore: 0, normalizedScore: 0, maxScore: 5, reasoning: 'No score provided by judge', evidence: [], confidence: 0 },
      ] as CriterionScore[],
    });
    const signal = extractCoverageCompleteness(result, 2, {});
    expect(signal.score).toBe(0.5); // only 1/2 effectively scored
    expect(signal.flagged).toBe(true);
  });
});

// ─── Reasoning Quality ──────────────────────────────────────────────────────────

describe('extractReasoningQuality', () => {
  it('returns 1.0 for substantive reasoning', () => {
    const result = makeJudgeResult(); // default has substantive reasoning
    const signal = extractReasoningQuality(result, {});
    expect(signal.score).toBe(1.0);
    expect(signal.flagged).toBe(false);
  });

  it('flags boilerplate reasoning', () => {
    const result = makeJudgeResult({
      criterionScores: [
        { criterionId: 'a', rawScore: 4, normalizedScore: 0.8, maxScore: 5, reasoning: 'Good.', evidence: ['e'], confidence: 0.9 },
        { criterionId: 'b', rawScore: 4, normalizedScore: 0.85, maxScore: 5, reasoning: 'Fine.', evidence: ['e'], confidence: 0.8 },
      ] as CriterionScore[],
    });
    const signal = extractReasoningQuality(result, {});
    expect(signal.score).toBe(0);
    expect(signal.flagged).toBe(true);
  });

  it('detects empty reasoning', () => {
    const result = makeJudgeResult({
      criterionScores: [
        { criterionId: 'a', rawScore: 4, normalizedScore: 0.8, maxScore: 5, reasoning: '', evidence: ['e'], confidence: 0.9 },
        { criterionId: 'b', rawScore: 4, normalizedScore: 0.85, maxScore: 5, reasoning: 'This response provides a thorough and accurate explanation.', evidence: ['e'], confidence: 0.8 },
      ] as CriterionScore[],
    });
    const signal = extractReasoningQuality(result, {});
    expect(signal.score).toBe(0.5); // 1/2 substantive
    expect(signal.flagged).toBe(false);
  });

  it('returns 0 for no criteria', () => {
    const result = makeJudgeResult({ criterionScores: [] });
    const signal = extractReasoningQuality(result, {});
    expect(signal.score).toBe(0);
    expect(signal.flagged).toBe(true);
  });

  it('respects custom minReasoningLength', () => {
    const result = makeJudgeResult({
      criterionScores: [
        { criterionId: 'a', rawScore: 4, normalizedScore: 0.8, maxScore: 5, reasoning: 'Short but OK', evidence: ['e'], confidence: 0.9 },
      ] as CriterionScore[],
    });
    // Default min=20, 'Short but OK' is 12 chars → boilerplate
    const signal1 = extractReasoningQuality(result, {});
    expect(signal1.score).toBe(0);
    // With min=10, 'Short but OK' is 12 chars → substantive
    const signal2 = extractReasoningQuality(result, { minReasoningLength: 10 });
    expect(signal2.score).toBe(1.0);
  });
});

// ─── Aggregate Confidence Assessment ────────────────────────────────────────────

describe('assessConfidence', () => {
  it('returns trustworthy assessment for strong results', () => {
    const result = makeJudgeResult({
      confidenceValue: 0.9,
      overallScore: 0.85,
    });
    const assessment = assessConfidence(result, 2);
    expect(assessment.trustworthy).toBe(true);
    expect(assessment.recommendation).toBe('trust-verdict');
    expect(assessment.overallConfidence).toBeGreaterThan(0.6);
    expect(assessment.flaggedSignals).toHaveLength(0);
  });

  it('returns needs-review for low aggregate confidence', () => {
    // Scenario: self-reported very low AND boundary proximity flagged but
    // we need overall confidence below minConfidence (0.6) with < 3 flagged signals
    // Use minConfidence: 0.9 to make the assessment stricter
    const result = makeJudgeResult({
      confidenceValue: 0.5,  // moderate, not flagged at default 0.4 threshold
      overallScore: 0.85,    // far from threshold → not borderline
      criterionScores: [
        { criterionId: 'a', rawScore: 4, normalizedScore: 0.8, maxScore: 5, reasoning: 'Adequate explanation covering the main points.', evidence: ['cites source'], confidence: 0.5 },
        { criterionId: 'b', rawScore: 4, normalizedScore: 0.82, maxScore: 5, reasoning: 'Clear structure with logical flow of ideas.', evidence: ['uses headings'], confidence: 0.5 },
      ] as CriterionScore[],
    });
    // With a high minConfidence threshold, the aggregate falls below it
    const assessment = assessConfidence(result, 2, { minConfidence: 0.95 });
    expect(assessment.trustworthy).toBe(false);
    expect(assessment.recommendation).toBe('needs-review');
  });

  it('detects borderline scores', () => {
    const result = makeJudgeResult({
      confidenceValue: 0.9,
      overallScore: 0.6, // exactly at threshold
    });
    const assessment = assessConfidence(result, 2);
    expect(assessment.recommendation).toBe('borderline');
    expect(assessment.trustworthy).toBe(false);
  });

  it('returns contradictory when many signals flagged', () => {
    const result = makeJudgeResult({
      confidenceValue: 0.2,  // self-reported flagged
      overallScore: 0.6,     // boundary flagged
      criterionScores: [
        { criterionId: 'a', rawScore: 5, normalizedScore: 1.0, maxScore: 5, reasoning: 'Good.', evidence: [], confidence: 0.2 },
        { criterionId: 'b', rawScore: 1, normalizedScore: 0.2, maxScore: 5, reasoning: 'Bad.', evidence: [], confidence: 0.2 },
      ] as CriterionScore[],
    });
    const assessment = assessConfidence(result, 4, { maxFlaggedSignals: 3 });
    // Should have multiple flags: self-reported, boundary, evidence, coverage, reasoning, consistency
    expect(assessment.flaggedSignals.length).toBeGreaterThanOrEqual(3);
    expect(assessment.recommendation).toBe('contradictory');
  });

  it('normalizes weights to sum to 1', () => {
    const result = makeJudgeResult();
    const assessment = assessConfidence(result, 2);
    const totalWeight = assessment.signals.reduce((s, sig) => s + sig.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });

  it('has 6 signals', () => {
    const result = makeJudgeResult();
    const assessment = assessConfidence(result, 2);
    expect(assessment.signals).toHaveLength(6);
  });
});

// ─── Label Verdict ──────────────────────────────────────────────────────────────

describe('labelVerdict', () => {
  it('preserves pass verdict when confidence is high', () => {
    const result = makeJudgeResult({ verdict: 'pass', confidenceValue: 0.9, overallScore: 0.85 });
    const labeled = labelVerdict(result, 2);
    expect(labeled.labeledVerdict).toBe('pass');
    expect(labeled.overridden).toBe(false);
    expect(labeled.originalVerdict).toBe('pass');
  });

  it('overrides pass to needs-human-review when confidence is low', () => {
    const result = makeJudgeResult({
      verdict: 'pass',
      confidenceValue: 0.2,
      overallScore: 0.6,
      criterionScores: [
        { criterionId: 'a', rawScore: 3, normalizedScore: 0.6, maxScore: 5, reasoning: '', evidence: [], confidence: 0.2 },
      ] as CriterionScore[],
    });
    const labeled = labelVerdict(result, 3);
    expect(labeled.labeledVerdict).toBe('needs-human-review');
    expect(labeled.overridden).toBe(true);
    expect(labeled.originalVerdict).toBe('pass');
  });

  it('never overrides FROM needs-human-review', () => {
    const result = makeJudgeResult({
      verdict: 'needs-human-review',
      confidenceValue: 0.95,
      overallScore: 0.95,
    });
    const labeled = labelVerdict(result, 2);
    expect(labeled.labeledVerdict).toBe('needs-human-review');
    expect(labeled.overridden).toBe(false);
  });

  it('overrides fail to needs-human-review when confidence is low', () => {
    const result = makeJudgeResult({
      verdict: 'fail',
      confidenceValue: 0.2,
      overallScore: 0.59, // just below threshold, but borderline
      criterionScores: [
        { criterionId: 'a', rawScore: 3, normalizedScore: 0.59, maxScore: 5, reasoning: '', evidence: [], confidence: 0.2 },
      ] as CriterionScore[],
    });
    const labeled = labelVerdict(result, 3);
    expect(labeled.labeledVerdict).toBe('needs-human-review');
    expect(labeled.overridden).toBe(true);
    expect(labeled.originalVerdict).toBe('fail');
  });

  it('preserves fail verdict when confidence is high and score is clearly below threshold', () => {
    const result = makeJudgeResult({
      verdict: 'fail',
      confidenceValue: 0.9,
      overallScore: 0.3,
    });
    const labeled = labelVerdict(result, 2);
    expect(labeled.labeledVerdict).toBe('fail');
    expect(labeled.overridden).toBe(false);
  });
});

// ─── ConfidenceAwareJudge ───────────────────────────────────────────────────────

describe('ConfidenceAwareJudge', () => {
  it('exposes rubric and options', () => {
    const mockBackend = makeMockBackend();
    const rubric = {
      name: 'test',
      description: 'test rubric',
      criteria: [{ id: 'c1', description: 'test', levels: [{ score: 1, label: 'bad', description: 'bad' }, { score: 5, label: 'good', description: 'good' }] }],
      passThreshold: 0.7,
    };
    const judge = new ConfidenceAwareJudge(mockBackend, rubric, { minConfidence: 0.8 });
    expect(judge.getRubric()).toBe(rubric);
    expect(judge.getConfidenceOptions().minConfidence).toBe(0.8);
    expect(judge.getConfidenceOptions().passThreshold).toBe(0.7);
  });
});

// ─── Assertion Integration ──────────────────────────────────────────────────────

describe('assertion factories', () => {
  it('toPassWithConfidence creates assertion with correct name', () => {
    const mockBackend = makeMockBackend();
    const rubric = {
      name: 'Quality Check',
      description: 'test',
      criteria: [{ id: 'c1', description: 'test', levels: [{ score: 1, label: 'bad', description: 'bad' }, { score: 5, label: 'good', description: 'good' }] }],
    };
    const assertion = toPassWithConfidence(mockBackend, rubric);
    expect(assertion.name).toBe('[Tier 3] confidence-labeled judge: Quality Check');
  });

  it('toHaveAdequateConfidence creates assertion with threshold in name', () => {
    const mockBackend = makeMockBackend();
    const rubric = {
      name: 'test',
      description: 'test',
      criteria: [{ id: 'c1', description: 'test', levels: [{ score: 1, label: 'bad', description: 'bad' }, { score: 5, label: 'good', description: 'good' }] }],
    };
    const assertion = toHaveAdequateConfidence(mockBackend, rubric, 0.75);
    expect(assertion.name).toBe('[Tier 3] adequate confidence >= 0.75');
  });

  it('toHaveNoConfidenceFlags creates assertion with correct name', () => {
    const mockBackend = makeMockBackend();
    const rubric = {
      name: 'test',
      description: 'test',
      criteria: [{ id: 'c1', description: 'test', levels: [{ score: 1, label: 'bad', description: 'bad' }, { score: 5, label: 'good', description: 'good' }] }],
    };
    const assertion = toHaveNoConfidenceFlags(mockBackend, rubric);
    expect(assertion.name).toBe('[Tier 3] no confidence flags');
  });

  it('toNotBeOverridden creates assertion with correct name', () => {
    const mockBackend = makeMockBackend();
    const rubric = {
      name: 'test',
      description: 'test',
      criteria: [{ id: 'c1', description: 'test', levels: [{ score: 1, label: 'bad', description: 'bad' }, { score: 5, label: 'good', description: 'good' }] }],
    };
    const assertion = toNotBeOverridden(mockBackend, rubric);
    expect(assertion.name).toBe('[Tier 3] verdict not overridden');
  });
});
