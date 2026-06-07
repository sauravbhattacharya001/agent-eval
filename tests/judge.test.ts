/**
 * Tests for the Judge Framework — Tier 3 Shared-Substrate Judgment
 */

import { describe, it, expect } from 'vitest';
import {
  type Rubric,
  type RubricCriterion,
  type RawJudgeResponse,
  type JudgeParseError,
  validateRubric,
  buildRubric,
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
  toPassJudge,
  toScoreOnCriterion,
  toHaveJudgeConfidence,
  toMeetAllCriteria,
  toHaveJudgeSuggestions,
  BUILTIN_RUBRICS,
} from '../src/checks/judge.js';

// ─── HELPERS ────────────────────────────────────────────────────────────────────

function makeRubric(overrides?: Partial<Rubric>): Rubric {
  return {
    name: 'Test Rubric',
    description: 'A test rubric',
    criteria: [
      {
        id: 'quality',
        description: 'Output quality',
        levels: [
          { score: 1, label: 'Poor', description: 'Low quality' },
          { score: 3, label: 'Average', description: 'Medium quality' },
          { score: 5, label: 'Excellent', description: 'High quality' },
        ],
      },
      {
        id: 'relevance',
        description: 'Task relevance',
        levels: [
          { score: 1, label: 'Off-topic', description: 'Not relevant' },
          { score: 5, label: 'On-topic', description: 'Highly relevant' },
        ],
      },
    ],
    passThreshold: 0.6,
    confidenceThreshold: 0.7,
    ...overrides,
  };
}

function makeResponse(overrides?: Partial<RawJudgeResponse>): RawJudgeResponse {
  return {
    scores: [
      { criterionId: 'quality', score: 4, reasoning: 'Good quality', evidence: ['example'], confidence: 0.9 },
      { criterionId: 'relevance', score: 4, reasoning: 'On topic', evidence: ['relevant'], confidence: 0.85 },
    ],
    summary: 'Good output overall',
    suggestions: ['Could be more detailed'],
    ...overrides,
  };
}

function makeRuleBackend(scores: Record<string, { score: number; confidence: number }>) {
  return new RuleBasedJudge(
    Object.fromEntries(
      Object.entries(scores).map(([id, { score, confidence }]) => [
        id,
        () => ({
          criterionId: id,
          score,
          reasoning: `Score ${score} for ${id}`,
          evidence: [`Evidence for ${id}`],
          confidence,
        }),
      ]),
    ),
  );
}

// ─── RUBRIC VALIDATION ─────────────────────────────────────────────────────────

describe('validateRubric', () => {
  it('accepts a valid rubric', () => {
    expect(validateRubric(makeRubric())).toEqual([]);
  });

  it('rejects empty name', () => {
    const errors = validateRubric(makeRubric({ name: '' }));
    expect(errors.some((e) => e.path === 'name')).toBe(true);
  });

  it('rejects empty description', () => {
    const errors = validateRubric(makeRubric({ description: '' }));
    expect(errors.some((e) => e.path === 'description')).toBe(true);
  });

  it('rejects empty criteria array', () => {
    const errors = validateRubric(makeRubric({ criteria: [] }));
    expect(errors.some((e) => e.path === 'criteria')).toBe(true);
  });

  it('rejects passThreshold out of range', () => {
    expect(validateRubric(makeRubric({ passThreshold: -0.1 })).length).toBeGreaterThan(0);
    expect(validateRubric(makeRubric({ passThreshold: 1.5 })).length).toBeGreaterThan(0);
  });

  it('rejects confidenceThreshold out of range', () => {
    expect(validateRubric(makeRubric({ confidenceThreshold: -0.1 })).length).toBeGreaterThan(0);
    expect(validateRubric(makeRubric({ confidenceThreshold: 1.5 })).length).toBeGreaterThan(0);
  });

  it('rejects criterion with no id', () => {
    const rubric = makeRubric({
      criteria: [{
        id: '', description: 'test',
        levels: [
          { score: 1, label: 'Low', description: 'Low' },
          { score: 5, label: 'High', description: 'High' },
        ],
      }],
    });
    expect(validateRubric(rubric).some((e) => e.path.includes('.id'))).toBe(true);
  });

  it('rejects duplicate criterion ids', () => {
    const rubric = makeRubric({
      criteria: [
        { id: 'same', description: 'First', levels: [{ score: 1, label: 'A', description: 'A' }, { score: 5, label: 'B', description: 'B' }] },
        { id: 'same', description: 'Second', levels: [{ score: 1, label: 'A', description: 'A' }, { score: 5, label: 'B', description: 'B' }] },
      ],
    });
    expect(validateRubric(rubric).some((e) => e.message.includes('Duplicate'))).toBe(true);
  });

  it('rejects criterion with fewer than 2 levels', () => {
    const rubric = makeRubric({
      criteria: [{ id: 'test', description: 'test', levels: [{ score: 1, label: 'Only', description: 'Only one' }] }],
    });
    expect(validateRubric(rubric).some((e) => e.message.includes('at least 2'))).toBe(true);
  });

  it('rejects duplicate scores within levels', () => {
    const rubric = makeRubric({
      criteria: [{ id: 'test', description: 'test', levels: [
        { score: 3, label: 'A', description: 'A' },
        { score: 3, label: 'B', description: 'B' },
      ] }],
    });
    expect(validateRubric(rubric).some((e) => e.message.includes('Duplicate score'))).toBe(true);
  });

  it('rejects levels with empty label', () => {
    const rubric = makeRubric({
      criteria: [{ id: 'test', description: 'test', levels: [
        { score: 1, label: '', description: 'A' },
        { score: 5, label: 'B', description: 'B' },
      ] }],
    });
    expect(validateRubric(rubric).some((e) => e.message.includes('label'))).toBe(true);
  });

  it('rejects levels with empty description', () => {
    const rubric = makeRubric({
      criteria: [{ id: 'test', description: 'test', levels: [
        { score: 1, label: 'A', description: '' },
        { score: 5, label: 'B', description: 'B' },
      ] }],
    });
    expect(validateRubric(rubric).some((e) => e.path.includes('description') && e.path.includes('levels'))).toBe(true);
  });

  it('rejects weight out of 0-1 range', () => {
    const rubric = makeRubric({
      criteria: [{ id: 'test', description: 'test', weight: 1.5, levels: [
        { score: 1, label: 'A', description: 'A' },
        { score: 5, label: 'B', description: 'B' },
      ] }],
    });
    expect(validateRubric(rubric).some((e) => e.message.includes('Weight'))).toBe(true);
  });
});

// ─── RUBRIC BUILDER ─────────────────────────────────────────────────────────────

describe('buildRubric', () => {
  it('builds a valid rubric with fluent API', () => {
    const rubric = buildRubric('Test')
      .describe('A test rubric')
      .passAt(0.7)
      .confidenceAt(0.8)
      .criterion('clarity', 'Is the output clear?')
        .level(1, 'Unclear', 'Hard to understand')
        .level(3, 'Moderate', 'Mostly understandable')
        .level(5, 'Clear', 'Very easy to understand')
        .weight(0.6)
        .done()
      .criterion('depth', 'Does it go deep enough?')
        .level(1, 'Shallow', 'Surface level only')
        .level(5, 'Deep', 'Thorough analysis')
        .weight(0.4)
        .done()
      .build();

    expect(rubric.name).toBe('Test');
    expect(rubric.description).toBe('A test rubric');
    expect(rubric.passThreshold).toBe(0.7);
    expect(rubric.confidenceThreshold).toBe(0.8);
    expect(rubric.criteria).toHaveLength(2);
    expect(rubric.criteria[0]?.id).toBe('clarity');
    expect(rubric.criteria[0]?.levels).toHaveLength(3);
    expect(rubric.criteria[1]?.weight).toBe(0.4);
  });

  it('throws on invalid rubric', () => {
    expect(() => {
      buildRubric('').describe('test')
        .criterion('x', 'y').level(1, 'A', 'A').level(5, 'B', 'B').done()
        .build();
    }).toThrow('Invalid rubric');
  });

  it('builds rubric with no explicit weights', () => {
    const rubric = buildRubric('NoWeights')
      .describe('No weights specified')
      .criterion('a', 'First').level(1, 'Low', 'Low').level(5, 'High', 'High').done()
      .criterion('b', 'Second').level(1, 'Low', 'Low').level(5, 'High', 'High').done()
      .build();
    expect(rubric.criteria[0]?.weight).toBeUndefined();
    expect(rubric.criteria[1]?.weight).toBeUndefined();
  });
});

// ─── WEIGHT NORMALIZATION ───────────────────────────────────────────────────────

describe('normalizeCriterionWeights', () => {
  it('normalizes explicit weights to sum to 1', () => {
    const criteria: RubricCriterion[] = [
      { id: 'a', description: 'A', weight: 0.3, levels: [] },
      { id: 'b', description: 'B', weight: 0.7, levels: [] },
    ];
    const weights = normalizeCriterionWeights(criteria);
    expect(weights.get('a')).toBeCloseTo(0.3);
    expect(weights.get('b')).toBeCloseTo(0.7);
  });

  it('normalizes when explicit weights do not sum to 1', () => {
    const criteria: RubricCriterion[] = [
      { id: 'a', description: 'A', weight: 0.2, levels: [] },
      { id: 'b', description: 'B', weight: 0.2, levels: [] },
    ];
    const weights = normalizeCriterionWeights(criteria);
    expect(weights.get('a')).toBeCloseTo(0.5);
    expect(weights.get('b')).toBeCloseTo(0.5);
  });

  it('distributes equal weight when no explicit weights', () => {
    const criteria: RubricCriterion[] = [
      { id: 'a', description: 'A', levels: [] },
      { id: 'b', description: 'B', levels: [] },
      { id: 'c', description: 'C', levels: [] },
    ];
    const weights = normalizeCriterionWeights(criteria);
    expect(weights.get('a')).toBeCloseTo(1 / 3);
    expect(weights.get('b')).toBeCloseTo(1 / 3);
    expect(weights.get('c')).toBeCloseTo(1 / 3);
  });

  it('mixes explicit and implicit weights', () => {
    const criteria: RubricCriterion[] = [
      { id: 'a', description: 'A', weight: 0.6, levels: [] },
      { id: 'b', description: 'B', levels: [] },
      { id: 'c', description: 'C', levels: [] },
    ];
    const weights = normalizeCriterionWeights(criteria);
    expect(weights.get('a')).toBeCloseTo(0.6);
    expect(weights.get('b')).toBeCloseTo(0.2);
    expect(weights.get('c')).toBeCloseTo(0.2);
  });

  it('returns empty map for empty criteria', () => {
    expect(normalizeCriterionWeights([])).toEqual(new Map());
  });
});

// ─── SCORE HELPERS ──────────────────────────────────────────────────────────────

describe('getMaxScore / getMinScore', () => {
  const criterion: RubricCriterion = {
    id: 'test', description: 'test',
    levels: [
      { score: 1, label: 'Low', description: 'Low' },
      { score: 3, label: 'Mid', description: 'Mid' },
      { score: 5, label: 'High', description: 'High' },
    ],
  };

  it('getMaxScore returns highest level score', () => {
    expect(getMaxScore(criterion)).toBe(5);
  });

  it('getMinScore returns lowest level score', () => {
    expect(getMinScore(criterion)).toBe(1);
  });

  it('handles empty levels', () => {
    expect(getMaxScore({ ...criterion, levels: [] })).toBe(0);
    expect(getMinScore({ ...criterion, levels: [] })).toBe(0);
  });
});

describe('classifyConfidence', () => {
  it('classifies high confidence', () => {
    expect(classifyConfidence(0.9)).toBe('high');
    expect(classifyConfidence(0.8)).toBe('high');
  });

  it('classifies medium confidence', () => {
    expect(classifyConfidence(0.7)).toBe('medium');
    expect(classifyConfidence(0.5)).toBe('medium');
  });

  it('classifies low confidence', () => {
    expect(classifyConfidence(0.4)).toBe('low');
    expect(classifyConfidence(0.0)).toBe('low');
  });
});

// ─── VERDICT COMPUTATION ────────────────────────────────────────────────────────

describe('computeVerdict', () => {
  it('returns pass when score meets threshold with high confidence', () => {
    const rubric = makeRubric({ passThreshold: 0.5, confidenceThreshold: 0.7 });
    const response = makeResponse({
      scores: [
        { criterionId: 'quality', score: 4, reasoning: 'Good', evidence: [], confidence: 0.9 },
        { criterionId: 'relevance', score: 4, reasoning: 'Relevant', evidence: [], confidence: 0.8 },
      ],
    });
    const result = computeVerdict(response, rubric);
    expect(result.verdict).toBe('pass');
    expect(result.overallScore).toBeGreaterThan(0.5);
    expect(result.confidence).toBe('high');
  });

  it('returns fail when score below threshold with high confidence', () => {
    const rubric = makeRubric({ passThreshold: 0.8, confidenceThreshold: 0.7 });
    const response = makeResponse({
      scores: [
        { criterionId: 'quality', score: 1, reasoning: 'Poor', evidence: [], confidence: 0.9 },
        { criterionId: 'relevance', score: 1, reasoning: 'Off-topic', evidence: [], confidence: 0.9 },
      ],
    });
    const result = computeVerdict(response, rubric);
    expect(result.verdict).toBe('fail');
    expect(result.overallScore).toBeLessThan(0.8);
  });

  it('returns needs-human-review when confidence too low', () => {
    const rubric = makeRubric({ passThreshold: 0.5, confidenceThreshold: 0.7 });
    const response = makeResponse({
      scores: [
        { criterionId: 'quality', score: 4, reasoning: 'Maybe', evidence: [], confidence: 0.3 },
        { criterionId: 'relevance', score: 4, reasoning: 'Unsure', evidence: [], confidence: 0.4 },
      ],
    });
    expect(computeVerdict(response, rubric).verdict).toBe('needs-human-review');
  });

  it('clamps scores to criterion min/max', () => {
    const rubric = makeRubric();
    const response = makeResponse({
      scores: [
        { criterionId: 'quality', score: 100, reasoning: 'Extreme', evidence: [], confidence: 0.9 },
        { criterionId: 'relevance', score: -5, reasoning: 'Negative', evidence: [], confidence: 0.9 },
      ],
    });
    const result = computeVerdict(response, rubric);
    expect(result.criterionScores.find((s) => s.criterionId === 'quality')?.score).toBe(5);
    expect(result.criterionScores.find((s) => s.criterionId === 'relevance')?.score).toBe(1);
  });

  it('handles missing criterion scores', () => {
    const rubric = makeRubric();
    const response = makeResponse({
      scores: [{ criterionId: 'quality', score: 4, reasoning: 'Good', evidence: [], confidence: 0.9 }],
    });
    const result = computeVerdict(response, rubric);
    const rel = result.criterionScores.find((s) => s.criterionId === 'relevance');
    expect(rel?.score).toBe(0);
    expect(rel?.confidence).toBe('low');
  });

  it('respects options threshold overrides', () => {
    const rubric = makeRubric({ passThreshold: 0.5 });
    const response = makeResponse({
      scores: [
        { criterionId: 'quality', score: 3, reasoning: 'Mid', evidence: [], confidence: 0.9 },
        { criterionId: 'relevance', score: 3, reasoning: 'Mid', evidence: [], confidence: 0.9 },
      ],
    });
    expect(computeVerdict(response, rubric).verdict).toBe('pass');
    expect(computeVerdict(response, rubric, { passThreshold: 0.9 }).verdict).toBe('fail');
  });

  it('normalizes scores correctly for 0-10 range', () => {
    const rubric = makeRubric({
      criteria: [{
        id: 'test', description: 'test',
        levels: [{ score: 0, label: 'Zero', description: 'No' }, { score: 10, label: 'Ten', description: 'Yes' }],
      }],
    });
    const response: RawJudgeResponse = {
      scores: [{ criterionId: 'test', score: 5, reasoning: 'Half', evidence: [], confidence: 0.9 }],
      summary: 'Half', suggestions: [],
    };
    expect(computeVerdict(response, rubric).overallScore).toBeCloseTo(0.5);
  });

  it('preserves summary and suggestions', () => {
    const result = computeVerdict(
      makeResponse({ summary: 'Custom summary', suggestions: ['A', 'B'] }),
      makeRubric(),
    );
    expect(result.summary).toBe('Custom summary');
    expect(result.suggestions).toEqual(['A', 'B']);
  });

  it('populates rubricName', () => {
    expect(computeVerdict(makeResponse(), makeRubric({ name: 'Custom' })).rubricName).toBe('Custom');
  });

  it('has non-negative durationMs', () => {
    expect(computeVerdict(makeResponse(), makeRubric()).durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── PROMPT GENERATION ──────────────────────────────────────────────────────────

describe('buildJudgePrompt', () => {
  it('includes rubric name and description', () => {
    const prompt = buildJudgePrompt('test output', makeRubric(), { task: 'Write a function', chainOfThought: false });
    expect(prompt).toContain('Test Rubric');
    expect(prompt).toContain('A test rubric');
  });

  it('includes criteria and scoring levels', () => {
    const prompt = buildJudgePrompt('output', makeRubric(), { task: 'task', chainOfThought: false });
    expect(prompt).toContain('quality');
    expect(prompt).toContain('relevance');
    expect(prompt).toContain('Poor');
    expect(prompt).toContain('Excellent');
  });

  it('includes the task', () => {
    const prompt = buildJudgePrompt('output', makeRubric(), { task: 'Review this PR', chainOfThought: false });
    expect(prompt).toContain('Review this PR');
  });

  it('includes the output being evaluated', () => {
    const prompt = buildJudgePrompt('Agent output here', makeRubric(), { task: 'task', chainOfThought: false });
    expect(prompt).toContain('Agent output here');
  });

  it('includes references when provided', () => {
    const prompt = buildJudgePrompt('output', makeRubric(), {
      task: 'task', references: ['Ref doc 1', 'Ref doc 2'], chainOfThought: false,
    });
    expect(prompt).toContain('Reference Materials');
    expect(prompt).toContain('Ref doc 1');
  });

  it('includes artifacts when provided', () => {
    const prompt = buildJudgePrompt('output', makeRubric(), {
      task: 'task', artifacts: { diff: '+ added line' }, chainOfThought: false,
    });
    expect(prompt).toContain('Artifacts');
    expect(prompt).toContain('+ added line');
  });

  it('includes chain-of-thought instructions when enabled', () => {
    const prompt = buildJudgePrompt('output', makeRubric(), { task: 'task', chainOfThought: true });
    expect(prompt).toContain('Think step by step');
  });

  it('omits chain-of-thought when disabled', () => {
    const prompt = buildJudgePrompt('output', makeRubric(), { task: 'task', chainOfThought: false });
    expect(prompt).not.toContain('Think step by step');
  });

  it('enforces independence constraint', () => {
    const prompt = buildJudgePrompt('output', makeRubric(), { task: 'task', chainOfThought: false });
    expect(prompt).toContain('Do NOT consider what the agent might have been "thinking"');
    expect(prompt).toContain('only judge observable artifacts');
  });

  it('requests JSON response format', () => {
    const prompt = buildJudgePrompt('output', makeRubric(), { task: 'task', chainOfThought: false });
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('"criterionId"');
    expect(prompt).toContain('"confidence"');
  });
});

// ─── JSON EXTRACTION ────────────────────────────────────────────────────────────

describe('extractJson', () => {
  it('extracts bare JSON object', () => {
    const json = '{"key": "value"}';
    expect(extractJson(json)).toBe(json);
  });

  it('extracts JSON from markdown code block', () => {
    expect(extractJson('```json\n{"key": "val"}\n```')).toBe('{"key": "val"}');
  });

  it('extracts JSON from code block without language', () => {
    expect(extractJson('```\n{"key": "val"}\n```')).toBe('{"key": "val"}');
  });

  it('extracts JSON with text before', () => {
    const result = extractJson('Here is the result: {"key": "val"}');
    expect(result).toBe('{"key": "val"}');
  });

  it('handles nested braces', () => {
    const json = '{"outer": {"inner": "val"}}';
    expect(extractJson(json)).toBe(json);
  });

  it('handles strings containing braces', () => {
    const json = '{"text": "a { b } c"}';
    expect(extractJson(json)).toBe(json);
  });

  it('handles escaped quotes in strings', () => {
    const json = '{"text": "say \\"hello\\""}';
    expect(extractJson(json)).toBe(json);
  });

  it('returns null for no JSON', () => {
    expect(extractJson('no json here')).toBeNull();
  });

  it('extracts JSON array', () => {
    expect(extractJson('[1, 2, 3]')).toBe('[1, 2, 3]');
  });
});

// ─── RESPONSE PARSING ──────────────────────────────────────────────────────────

describe('parseJudgeResponse', () => {
  const rubric = makeRubric();

  it('parses a valid JSON response', () => {
    const json = JSON.stringify({
      scores: [
        { criterionId: 'quality', score: 4, reasoning: 'Good', evidence: ['quote'], confidence: 0.9 },
        { criterionId: 'relevance', score: 3, reasoning: 'OK', evidence: [], confidence: 0.7 },
      ],
      summary: 'Overall good',
      suggestions: ['Be specific'],
    });
    const result = parseJudgeResponse(json, rubric);
    expect('message' in result).toBe(false);
    const r = result as RawJudgeResponse;
    expect(r.scores).toHaveLength(2);
    expect(r.summary).toBe('Overall good');
  });

  it('parses JSON in markdown code block', () => {
    const wrapped = '```json\n{"scores": [{"criterionId": "quality", "score": 4, "reasoning": "Good", "evidence": [], "confidence": 0.9}], "summary": "OK", "suggestions": []}\n```';
    const result = parseJudgeResponse(wrapped, rubric);
    expect('message' in result).toBe(false);
    expect((result as RawJudgeResponse).scores).toHaveLength(1);
  });

  it('parses JSON with surrounding text', () => {
    const text = 'Evaluation:\n{"scores": [{"criterionId": "quality", "score": 3, "reasoning": "Mid", "evidence": [], "confidence": 0.8}], "summary": "Avg", "suggestions": []}\nDone.';
    expect('message' in parseJudgeResponse(text, rubric)).toBe(false);
  });

  it('filters unknown criterion IDs', () => {
    const json = JSON.stringify({
      scores: [
        { criterionId: 'quality', score: 4, reasoning: 'Good', evidence: [], confidence: 0.9 },
        { criterionId: 'unknown', score: 3, reasoning: 'X', evidence: [], confidence: 0.5 },
      ],
      summary: 'Test', suggestions: [],
    });
    const r = parseJudgeResponse(json, rubric) as RawJudgeResponse;
    expect(r.scores).toHaveLength(1);
    expect(r.scores[0]?.criterionId).toBe('quality');
  });

  it('clamps confidence to 0-1', () => {
    const json = JSON.stringify({
      scores: [{ criterionId: 'quality', score: 4, reasoning: 'G', evidence: [], confidence: 1.5 }],
      summary: '', suggestions: [],
    });
    expect((parseJudgeResponse(json, rubric) as RawJudgeResponse).scores[0]?.confidence).toBe(1);
  });

  it('defaults confidence to 0.5 when missing', () => {
    const json = JSON.stringify({
      scores: [{ criterionId: 'quality', score: 4, reasoning: 'G', evidence: [] }],
      summary: '', suggestions: [],
    });
    expect((parseJudgeResponse(json, rubric) as RawJudgeResponse).scores[0]?.confidence).toBe(0.5);
  });

  it('returns error for non-JSON text', () => {
    expect('message' in parseJudgeResponse('not json', rubric)).toBe(true);
  });

  it('returns error for missing scores array', () => {
    const result = parseJudgeResponse('{"summary": "no scores"}', rubric) as JudgeParseError;
    expect(result.message).toContain('scores');
  });

  it('returns error for invalid JSON syntax', () => {
    expect('message' in parseJudgeResponse('{invalid json!!!}', rubric)).toBe(true);
  });

  it('handles empty suggestions gracefully', () => {
    const json = JSON.stringify({ scores: [], summary: 'OK', suggestions: [] });
    const result = parseJudgeResponse(json, rubric) as RawJudgeResponse;
    expect(result.suggestions).toEqual([]);
  });

  it('handles non-string suggestions', () => {
    const json = JSON.stringify({
      scores: [], summary: 'OK', suggestions: ['valid', 123, null, 'also valid'],
    });
    const result = parseJudgeResponse(json, rubric) as RawJudgeResponse;
    expect(result.suggestions).toEqual(['valid', 'also valid']);
  });
});

// ─── RULE-BASED JUDGE ───────────────────────────────────────────────────────────

describe('RuleBasedJudge', () => {
  it('evaluates with registered scoring functions', async () => {
    const backend = makeRuleBackend({
      quality: { score: 4, confidence: 0.9 },
      relevance: { score: 3, confidence: 0.8 },
    });
    const rubric = makeRubric();
    const result = await backend.evaluate('test output', rubric, { task: 'task', chainOfThought: false });
    expect(result.scores).toHaveLength(2);
    expect(result.scores[0]?.score).toBe(4);
    expect(result.scores[1]?.score).toBe(3);
  });

  it('handles missing scoring function with low confidence', async () => {
    const backend = makeRuleBackend({
      quality: { score: 4, confidence: 0.9 },
      // no 'relevance' function
    });
    const rubric = makeRubric();
    const result = await backend.evaluate('output', rubric, { task: 'task', chainOfThought: false });
    expect(result.scores).toHaveLength(2);
    const rel = result.scores.find((s) => s.criterionId === 'relevance');
    expect(rel?.confidence).toBe(0);
  });

  it('returns name', () => {
    const backend = new RuleBasedJudge({});
    expect(backend.name).toBe('rule-based');
  });
});

// ─── JUDGE EVALUATOR ────────────────────────────────────────────────────────────

describe('JudgeEvaluator', () => {
  it('evaluates and returns verdict', async () => {
    const backend = makeRuleBackend({
      quality: { score: 5, confidence: 0.9 },
      relevance: { score: 5, confidence: 0.9 },
    });
    const rubric = makeRubric({ passThreshold: 0.6 });
    const evaluator = new JudgeEvaluator(backend, rubric);
    const result = await evaluator.evaluate('good output', { task: 'task' });
    expect(result.verdict).toBe('pass');
    expect(result.overallScore).toBeGreaterThan(0.6);
  });

  it('returns fail for poor scores', async () => {
    const backend = makeRuleBackend({
      quality: { score: 1, confidence: 0.9 },
      relevance: { score: 1, confidence: 0.9 },
    });
    const evaluator = new JudgeEvaluator(backend, makeRubric({ passThreshold: 0.6 }));
    const result = await evaluator.evaluate('bad output', { task: 'task' });
    expect(result.verdict).toBe('fail');
  });

  it('returns needs-human-review for low confidence', async () => {
    const backend = makeRuleBackend({
      quality: { score: 5, confidence: 0.3 },
      relevance: { score: 5, confidence: 0.2 },
    });
    const evaluator = new JudgeEvaluator(backend, makeRubric({ confidenceThreshold: 0.7 }));
    const result = await evaluator.evaluate('output', { task: 'task' });
    expect(result.verdict).toBe('needs-human-review');
  });

  it('throws on invalid rubric', () => {
    const backend = makeRuleBackend({});
    expect(() => new JudgeEvaluator(backend, makeRubric({ name: '' }))).toThrow('Invalid rubric');
  });

  it('exposes rubric and backend name', () => {
    const backend = makeRuleBackend({});
    const rubric = makeRubric();
    const evaluator = new JudgeEvaluator(backend, rubric);
    expect(evaluator.getRubric()).toBe(rubric);
    expect(evaluator.getBackendName()).toBe('rule-based');
  });
});

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

describe('toPassJudge', () => {
  it('passes when judge verdict is pass', async () => {
    const backend = makeRuleBackend({
      quality: { score: 5, confidence: 0.9 },
      relevance: { score: 5, confidence: 0.9 },
    });
    const rubric = makeRubric({ passThreshold: 0.5 });
    const assertion = toPassJudge(backend, rubric);
    const result = await assertion.evaluate('good output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('pass');
  });

  it('fails when judge verdict is fail', async () => {
    const backend = makeRuleBackend({
      quality: { score: 1, confidence: 0.9 },
      relevance: { score: 1, confidence: 0.9 },
    });
    const assertion = toPassJudge(backend, makeRubric({ passThreshold: 0.8 }));
    const result = await assertion.evaluate('bad output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('fail');
  });

  it('skips when needs-human-review', async () => {
    const backend = makeRuleBackend({
      quality: { score: 5, confidence: 0.2 },
      relevance: { score: 5, confidence: 0.2 },
    });
    const assertion = toPassJudge(backend, makeRubric({ confidenceThreshold: 0.7 }));
    const result = await assertion.evaluate('output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('skip');
  });

  it('has Tier 3 label in name', () => {
    const backend = makeRuleBackend({});
    const assertion = toPassJudge(backend, makeRubric());
    expect(assertion.name).toContain('[Tier 3]');
  });
});

describe('toScoreOnCriterion', () => {
  it('passes when criterion meets minimum', async () => {
    const backend = makeRuleBackend({
      quality: { score: 5, confidence: 0.9 },
      relevance: { score: 5, confidence: 0.9 },
    });
    const assertion = toScoreOnCriterion(backend, makeRubric(), 'quality', 0.5);
    const result = await assertion.evaluate('output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('pass');
  });

  it('fails when criterion below minimum', async () => {
    const backend = makeRuleBackend({
      quality: { score: 1, confidence: 0.9 },
      relevance: { score: 5, confidence: 0.9 },
    });
    const assertion = toScoreOnCriterion(backend, makeRubric(), 'quality', 0.8);
    const result = await assertion.evaluate('output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('fail');
  });

  it('skips on low confidence', async () => {
    const backend = makeRuleBackend({
      quality: { score: 5, confidence: 0.2 },
      relevance: { score: 5, confidence: 0.9 },
    });
    const assertion = toScoreOnCriterion(backend, makeRubric(), 'quality', 0.5);
    const result = await assertion.evaluate('output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('skip');
  });
});

describe('toHaveJudgeConfidence', () => {
  it('passes when confidence meets threshold', async () => {
    const backend = makeRuleBackend({
      quality: { score: 3, confidence: 0.9 },
      relevance: { score: 3, confidence: 0.9 },
    });
    const assertion = toHaveJudgeConfidence(backend, makeRubric(), 0.7);
    const result = await assertion.evaluate('output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('pass');
  });

  it('skips when confidence below threshold', async () => {
    const backend = makeRuleBackend({
      quality: { score: 3, confidence: 0.3 },
      relevance: { score: 3, confidence: 0.4 },
    });
    const assertion = toHaveJudgeConfidence(backend, makeRubric(), 0.7);
    const result = await assertion.evaluate('output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('skip');
  });
});

describe('toMeetAllCriteria', () => {
  it('passes when all criteria meet minimums', async () => {
    const backend = makeRuleBackend({
      quality: { score: 5, confidence: 0.9 },
      relevance: { score: 5, confidence: 0.9 },
    });
    const assertion = toMeetAllCriteria(backend, makeRubric(), { quality: 0.5, relevance: 0.5 });
    const result = await assertion.evaluate('output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('pass');
  });

  it('fails when any criterion below minimum', async () => {
    const backend = makeRuleBackend({
      quality: { score: 1, confidence: 0.9 },
      relevance: { score: 5, confidence: 0.9 },
    });
    const assertion = toMeetAllCriteria(backend, makeRubric(), { quality: 0.8, relevance: 0.5 });
    const result = await assertion.evaluate('output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('quality');
  });

  it('skips on low confidence for any criterion', async () => {
    const backend = makeRuleBackend({
      quality: { score: 5, confidence: 0.2 },
      relevance: { score: 5, confidence: 0.9 },
    });
    const assertion = toMeetAllCriteria(backend, makeRubric(), { quality: 0.5, relevance: 0.5 });
    const result = await assertion.evaluate('output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('skip');
  });
});

describe('toHaveJudgeSuggestions', () => {
  it('passes when enough suggestions provided', async () => {
    const backend = new RuleBasedJudge({
      quality: () => ({ criterionId: 'quality', score: 3, reasoning: 'OK', evidence: [], confidence: 0.9 }),
      relevance: () => ({ criterionId: 'relevance', score: 3, reasoning: 'OK', evidence: [], confidence: 0.9 }),
    });
    // RuleBasedJudge returns no suggestions by default
    const assertion = toHaveJudgeSuggestions(backend, makeRubric(), 0);
    const result = await assertion.evaluate('output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('pass');
  });

  it('fails when too few suggestions', async () => {
    const backend = new RuleBasedJudge({
      quality: () => ({ criterionId: 'quality', score: 3, reasoning: 'OK', evidence: [], confidence: 0.9 }),
      relevance: () => ({ criterionId: 'relevance', score: 3, reasoning: 'OK', evidence: [], confidence: 0.9 }),
    });
    const assertion = toHaveJudgeSuggestions(backend, makeRubric(), 3);
    const result = await assertion.evaluate('output', { prompt: 'task', durationMs: 0, name: '', status: 'pass', assertions: [] });
    expect(result.status).toBe('fail');
  });
});

// ─── BUILT-IN RUBRICS ───────────────────────────────────────────────────────────

describe('BUILTIN_RUBRICS', () => {
  it('codeReview rubric is valid', () => {
    const rubric = BUILTIN_RUBRICS.codeReview();
    expect(validateRubric(rubric)).toEqual([]);
    expect(rubric.criteria.length).toBeGreaterThanOrEqual(3);
    expect(rubric.criteria.some((c) => c.id === 'actionability')).toBe(true);
    expect(rubric.criteria.some((c) => c.id === 'accuracy')).toBe(true);
    expect(rubric.criteria.some((c) => c.id === 'completeness')).toBe(true);
  });

  it('taskCompletion rubric is valid', () => {
    const rubric = BUILTIN_RUBRICS.taskCompletion();
    expect(validateRubric(rubric)).toEqual([]);
    expect(rubric.criteria.length).toBeGreaterThanOrEqual(4);
    expect(rubric.criteria.some((c) => c.id === 'relevance')).toBe(true);
    expect(rubric.criteria.some((c) => c.id === 'completeness')).toBe(true);
  });

  it('codeReview criteria weights sum correctly', () => {
    const rubric = BUILTIN_RUBRICS.codeReview();
    const totalWeight = rubric.criteria.reduce((sum, c) => sum + (c.weight ?? 0), 0);
    expect(totalWeight).toBeCloseTo(1.0);
  });

  it('taskCompletion criteria weights sum correctly', () => {
    const rubric = BUILTIN_RUBRICS.taskCompletion();
    const totalWeight = rubric.criteria.reduce((sum, c) => sum + (c.weight ?? 0), 0);
    expect(totalWeight).toBeCloseTo(1.0);
  });

  it('each built-in rubric has at least 2 levels per criterion', () => {
    for (const factory of [BUILTIN_RUBRICS.codeReview, BUILTIN_RUBRICS.taskCompletion]) {
      const rubric = factory();
      for (const criterion of rubric.criteria) {
        expect(criterion.levels.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

// ─── INTEGRATION: END-TO-END ───────────────────────────────────────────────────

describe('end-to-end: RuleBasedJudge + JudgeEvaluator + built-in rubric', () => {
  it('evaluates a code review with the codeReview rubric', async () => {
    const rubric = BUILTIN_RUBRICS.codeReview();
    const backend = new RuleBasedJudge({
      actionability: (_output, _criterion) => ({
        criterionId: 'actionability',
        score: 4,
        reasoning: 'Suggestions include specific changes',
        evidence: ['Change line 42 to use const'],
        confidence: 0.85,
      }),
      accuracy: (_output, _criterion) => ({
        criterionId: 'accuracy',
        score: 5,
        reasoning: 'All issues identified are real',
        evidence: ['Null check missing on line 15'],
        confidence: 0.9,
      }),
      completeness: (_output, _criterion) => ({
        criterionId: 'completeness',
        score: 3,
        reasoning: 'Logic covered but missed performance',
        evidence: ['Covers correctness'],
        confidence: 0.8,
      }),
    });

    const evaluator = new JudgeEvaluator(backend, rubric);
    const result = await evaluator.evaluate(
      'Code review: Fix null check on line 15. Use const on line 42.',
      { task: 'Review the authentication module changes' },
    );

    expect(result.verdict).toBe('pass');
    expect(result.criterionScores).toHaveLength(3);
    expect(result.overallScore).toBeGreaterThan(0.5);
  });

  it('fails a poor code review', async () => {
    const rubric = BUILTIN_RUBRICS.codeReview();
    const backend = new RuleBasedJudge({
      actionability: () => ({ criterionId: 'actionability', score: 1, reasoning: 'Vague', evidence: [], confidence: 0.9 }),
      accuracy: () => ({ criterionId: 'accuracy', score: 1, reasoning: 'False positives', evidence: [], confidence: 0.9 }),
      completeness: () => ({ criterionId: 'completeness', score: 1, reasoning: 'Superficial', evidence: [], confidence: 0.9 }),
    });

    const evaluator = new JudgeEvaluator(backend, rubric);
    const result = await evaluator.evaluate('LGTM!', { task: 'Review the changes' });
    expect(result.verdict).toBe('fail');
    expect(result.overallScore).toBeLessThan(0.6);
  });
});