/**
 * Seam tests for the Judge Framework split.
 *
 * `judge.ts` was split into four sibling seams — `judge-types.ts`,
 * `judge-rubric.ts`, `judge-scoring.ts`, and `judge-prompt.ts` — with `judge.ts`
 * kept as the public barrel (re-exporting everything) plus the runtime wiring
 * (`RuleBasedJudge`, `JudgeEvaluator`, assertion factories).
 *
 * The behavioural suite in `judge.test.ts` imports everything from `judge.js`
 * and therefore only reaches the moved units transitively. These tests pin the
 * seam boundary itself:
 *   1. each unit is importable from its OWN new module, and
 *   2. `judge.js` re-exports the *same function reference* (the barrel cannot
 *      silently diverge from the seam),
 * plus a few direct unit checks on the seams that were previously only exercised
 * through the barrel.
 */

import { describe, it, expect } from 'vitest';

// Seam modules — imported directly from their new homes.
import {
  validateRubric as validateRubricSeam,
  buildRubric as buildRubricSeam,
  RubricBuilder as RubricBuilderSeam,
  CriterionBuilder as CriterionBuilderSeam,
  BUILTIN_RUBRICS as BUILTIN_RUBRICS_SEAM,
} from '../src/checks/judge-rubric.js';
import {
  computeVerdict as computeVerdictSeam,
  normalizeCriterionWeights as normalizeCriterionWeightsSeam,
  getMaxScore as getMaxScoreSeam,
  getMinScore as getMinScoreSeam,
  classifyConfidence as classifyConfidenceSeam,
} from '../src/checks/judge-scoring.js';
import {
  buildJudgePrompt as buildJudgePromptSeam,
  parseJudgeResponse as parseJudgeResponseSeam,
  extractJson as extractJsonSeam,
} from '../src/checks/judge-prompt.js';

// Public barrel — what consumers import.
import {
  validateRubric,
  buildRubric,
  RubricBuilder,
  CriterionBuilder,
  BUILTIN_RUBRICS,
  computeVerdict,
  normalizeCriterionWeights,
  getMaxScore,
  getMinScore,
  classifyConfidence,
  buildJudgePrompt,
  parseJudgeResponse,
  extractJson,
  RuleBasedJudge,
  JudgeEvaluator,
  type Rubric,
  type RubricCriterion,
  type RawJudgeResponse,
  type JudgeContext,
  type JudgeParseError,
} from '../src/checks/judge.js';

function makeRubric(overrides?: Partial<Rubric>): Rubric {
  return {
    name: 'Seam Rubric',
    description: 'A rubric for seam tests',
    criteria: [
      {
        id: 'quality',
        description: 'Output quality',
        levels: [
          { score: 1, label: 'Poor', description: 'Low quality' },
          { score: 5, label: 'Great', description: 'High quality' },
        ],
      },
    ],
    passThreshold: 0.6,
    confidenceThreshold: 0.7,
    ...overrides,
  };
}

function makeResponse(score: number, confidence: number): RawJudgeResponse {
  return {
    scores: [
      { criterionId: 'quality', score, reasoning: 'r', evidence: ['e'], confidence },
    ],
    summary: 'summary',
    suggestions: ['s'],
  };
}

const ctx: JudgeContext = { task: 'Do the thing', chainOfThought: false };

// ─── RE-EXPORT IDENTITY ──────────────────────────────────────────────────────────

describe('judge.ts re-exports the same references as its seams', () => {
  it('rubric-authoring seam (judge-rubric.ts)', () => {
    expect(validateRubric).toBe(validateRubricSeam);
    expect(buildRubric).toBe(buildRubricSeam);
    expect(RubricBuilder).toBe(RubricBuilderSeam);
    expect(CriterionBuilder).toBe(CriterionBuilderSeam);
    expect(BUILTIN_RUBRICS).toBe(BUILTIN_RUBRICS_SEAM);
  });

  it('scoring seam (judge-scoring.ts)', () => {
    expect(computeVerdict).toBe(computeVerdictSeam);
    expect(normalizeCriterionWeights).toBe(normalizeCriterionWeightsSeam);
    expect(getMaxScore).toBe(getMaxScoreSeam);
    expect(getMinScore).toBe(getMinScoreSeam);
    expect(classifyConfidence).toBe(classifyConfidenceSeam);
  });

  it('prompt seam (judge-prompt.ts)', () => {
    expect(buildJudgePrompt).toBe(buildJudgePromptSeam);
    expect(parseJudgeResponse).toBe(parseJudgeResponseSeam);
    expect(extractJson).toBe(extractJsonSeam);
  });
});

// ─── SCORING SEAM — DIRECT UNIT CHECKS ───────────────────────────────────────────

describe('judge-scoring seam', () => {
  it('classifyConfidence maps to high/medium/low at the documented thresholds', () => {
    expect(classifyConfidenceSeam(0.8)).toBe('high');
    expect(classifyConfidenceSeam(0.79)).toBe('medium');
    expect(classifyConfidenceSeam(0.5)).toBe('medium');
    expect(classifyConfidenceSeam(0.49)).toBe('low');
    expect(classifyConfidenceSeam(0)).toBe('low');
  });

  it('getMaxScore / getMinScore read a criterion\'s level range', () => {
    const criterion: RubricCriterion = {
      id: 'c',
      description: 'd',
      levels: [
        { score: 2, label: 'lo', description: 'lo' },
        { score: 7, label: 'hi', description: 'hi' },
        { score: 4, label: 'mid', description: 'mid' },
      ],
    };
    expect(getMaxScoreSeam(criterion)).toBe(7);
    expect(getMinScoreSeam(criterion)).toBe(2);
  });

  it('getMaxScore / getMinScore return 0 for an empty level list', () => {
    const empty: RubricCriterion = { id: 'c', description: 'd', levels: [] };
    expect(getMaxScoreSeam(empty)).toBe(0);
    expect(getMinScoreSeam(empty)).toBe(0);
  });

  it('normalizeCriterionWeights distributes unweighted criteria evenly', () => {
    const weights = normalizeCriterionWeightsSeam([
      { id: 'a', description: 'a', levels: [] },
      { id: 'b', description: 'b', levels: [] },
    ]);
    expect(weights.get('a')).toBeCloseTo(0.5);
    expect(weights.get('b')).toBeCloseTo(0.5);
  });

  it('normalizeCriterionWeights renormalizes explicit weights to sum to 1', () => {
    const weights = normalizeCriterionWeightsSeam([
      { id: 'a', description: 'a', weight: 0.2, levels: [] },
      { id: 'b', description: 'b', weight: 0.2, levels: [] },
    ]);
    const total = [...weights.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1);
    expect(weights.get('a')).toBeCloseTo(0.5);
  });

  it('computeVerdict passes a high score with high confidence', () => {
    const result = computeVerdictSeam(makeResponse(5, 0.9), makeRubric());
    expect(result.verdict).toBe('pass');
    expect(result.overallScore).toBeCloseTo(1);
    expect(result.confidence).toBe('high');
  });

  it('computeVerdict fails a low score with high confidence', () => {
    const result = computeVerdictSeam(makeResponse(1, 0.9), makeRubric());
    expect(result.verdict).toBe('fail');
  });

  it('computeVerdict flags needs-human-review below the confidence threshold', () => {
    const result = computeVerdictSeam(makeResponse(5, 0.3), makeRubric());
    expect(result.verdict).toBe('needs-human-review');
  });

  it('computeVerdict clamps an out-of-range score into the level range', () => {
    const result = computeVerdictSeam(makeResponse(99, 0.9), makeRubric());
    expect(result.criterionScores[0]?.score).toBe(5);
    expect(result.criterionScores[0]?.normalizedScore).toBeCloseTo(1);
  });

  it('computeVerdict treats a missing criterion score as a low-confidence zero', () => {
    const empty: RawJudgeResponse = { scores: [], summary: '', suggestions: [] };
    const result = computeVerdictSeam(empty, makeRubric());
    expect(result.criterionScores[0]?.score).toBe(0);
    expect(result.criterionScores[0]?.confidence).toBe('low');
  });
});

// ─── PROMPT SEAM — DIRECT UNIT CHECKS ────────────────────────────────────────────

describe('judge-prompt seam', () => {
  it('buildJudgePrompt embeds the rubric, task, and output', () => {
    const prompt = buildJudgePromptSeam('THE OUTPUT', makeRubric(), ctx);
    expect(prompt).toContain('Seam Rubric');
    expect(prompt).toContain('Do the thing');
    expect(prompt).toContain('THE OUTPUT');
    expect(prompt).toContain('quality');
  });

  it('buildJudgePrompt includes chain-of-thought guidance only when requested', () => {
    expect(buildJudgePromptSeam('o', makeRubric(), { ...ctx, chainOfThought: true })).toContain('step by step');
    expect(buildJudgePromptSeam('o', makeRubric(), { ...ctx, chainOfThought: false })).not.toContain('step by step');
  });

  it('extractJson unwraps a fenced ```json block', () => {
    expect(extractJsonSeam('prose\n```json\n{"a":1}\n```\nmore')).toBe('{"a":1}');
  });

  it('extractJson finds a balanced object embedded in prose', () => {
    expect(extractJsonSeam('here you go: {"a":{"b":2}} done')).toBe('{"a":{"b":2}}');
  });

  it('extractJson returns null when there is no JSON', () => {
    expect(extractJsonSeam('no json here')).toBeNull();
  });

  it('parseJudgeResponse parses a valid response and drops unknown criteria', () => {
    const raw = JSON.stringify({
      scores: [
        { criterionId: 'quality', score: 4, reasoning: 'ok', evidence: ['x'], confidence: 0.8 },
        { criterionId: 'not-a-criterion', score: 5, reasoning: 'no', evidence: [], confidence: 0.9 },
      ],
      summary: 'fine',
      suggestions: ['do better'],
    });
    const result = parseJudgeResponseSeam(raw, makeRubric());
    expect('message' in result).toBe(false);
    const ok = result as Exclude<typeof result, JudgeParseError>;
    expect(ok.scores).toHaveLength(1);
    expect(ok.scores[0]?.criterionId).toBe('quality');
    expect(ok.summary).toBe('fine');
  });

  it('parseJudgeResponse returns a parse error when JSON is absent', () => {
    const result = parseJudgeResponseSeam('totally not json', makeRubric());
    expect('message' in result).toBe(true);
  });

  it('parseJudgeResponse returns a parse error when the scores array is missing', () => {
    const result = parseJudgeResponseSeam('{"summary":"x"}', makeRubric());
    expect((result as JudgeParseError).message).toContain('scores');
  });
});

// ─── RUBRIC SEAM — DIRECT UNIT CHECKS ────────────────────────────────────────────

describe('judge-rubric seam', () => {
  it('buildRubric produces a rubric the scoring seam can consume', async () => {
    const rubric = buildRubricSeam('Built')
      .describe('built via the seam')
      .passAt(0.5)
      .criterion('quality', 'Output quality')
      .level(1, 'Poor', 'low')
      .level(5, 'Great', 'high')
      .done()
      .build();
    expect(validateRubricSeam(rubric)).toEqual([]);

    const backend = new RuleBasedJudge({
      quality: () => ({ criterionId: 'quality', score: 5, reasoning: 'r', evidence: [], confidence: 0.9 }),
    });
    const evaluator = new JudgeEvaluator(backend, rubric);
    const result = await evaluator.evaluate('out', { task: 't' });
    expect(result.verdict).toBe('pass');
  });

  it('BUILTIN_RUBRICS are all structurally valid', () => {
    expect(validateRubricSeam(BUILTIN_RUBRICS_SEAM.codeReview())).toEqual([]);
    expect(validateRubricSeam(BUILTIN_RUBRICS_SEAM.taskCompletion())).toEqual([]);
  });
});
