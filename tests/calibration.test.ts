import { describe, it, expect } from 'vitest';
import {
  calibrate,
  buildCalibrationSet,
  detectDrift,
} from '../src/checks/calibration.js';
import type {
  CalibrationSnapshot,
  CalibrationReport,
} from '../src/checks/calibration.js';
import type {
  JudgeBackend,
  Rubric,
  RawJudgeResponse,
  JudgeContext,
} from '../src/checks/judge.js';
import { buildRubric } from '../src/checks/judge.js';

// ─── FIXTURES ───────────────────────────────────────────────────────────────────

const testRubric: Rubric = buildRubric('Test Rubric')
  .describe('For calibration testing')
  .passAt(0.6)
  .criterion('quality', 'Overall quality')
    .level(1, 'Bad', 'Poor quality')
    .level(2, 'Okay', 'Acceptable')
    .level(3, 'Good', 'High quality')
    .level(4, 'Great', 'Very high quality')
    .level(5, 'Excellent', 'Exceptional')
    .weight(0.6)
    .done()
  .criterion('clarity', 'Clarity of expression')
    .level(1, 'Unclear', 'Hard to understand')
    .level(3, 'Clear', 'Easy to follow')
    .level(5, 'Crystal', 'Perfectly clear')
    .weight(0.4)
    .done()
  .build();

/** Mock judge that returns predictable scores. */
function createMockJudge(scoreMap: Record<string, number>): JudgeBackend {
  return {
    name: 'mock-judge',
    async evaluate(_output: string, rubric: Rubric, _context: JudgeContext): Promise<RawJudgeResponse> {
      return {
        scores: rubric.criteria.map(c => ({
          criterionId: c.id,
          score: scoreMap[c.id] ?? 3,
          reasoning: 'Mock reasoning',
          evidence: ['mock evidence'],
          confidence: 0.9,
        })),
        summary: 'Mock summary',
        suggestions: ['Mock suggestion'],
      };
    },
  };
}

/** Mock judge that's consistently too generous (+1 on everything). */
function createGenerousJudge(): JudgeBackend {
  return {
    name: 'generous-judge',
    async evaluate(_output: string, rubric: Rubric, _context: JudgeContext): Promise<RawJudgeResponse> {
      return {
        scores: rubric.criteria.map(c => ({
          criterionId: c.id,
          score: 4, // Always scores 4 regardless of quality
          reasoning: 'This looks great!',
          evidence: ['generally positive'],
          confidence: 0.85,
        })),
        summary: 'Everything looks good',
        suggestions: [],
      };
    },
  };
}

// ─── CALIBRATION SET BUILDER ────────────────────────────────────────────────────

describe('buildCalibrationSet', () => {
  it('creates a valid calibration set', () => {
    const calSet = buildCalibrationSet('Test Cal', 'Test Rubric')
      .example('Good example')
        .output('This is excellent work with clear reasoning.')
        .task('Write a summary')
        .scores({ quality: 4, clarity: 5 })
        .verdict('pass')
        .notes('Clearly written, thorough')
        .done()
      .example('Bad example')
        .output('meh')
        .task('Write a summary')
        .scores({ quality: 1, clarity: 1 })
        .verdict('fail')
        .notes('Minimal effort')
        .done()
      .build();

    expect(calSet.name).toBe('Test Cal');
    expect(calSet.rubricName).toBe('Test Rubric');
    expect(calSet.examples).toHaveLength(2);
    expect(calSet.examples[0]!.expectedScores.quality).toBe(4);
    expect(calSet.examples[1]!.expectedVerdict).toBe('fail');
    expect(calSet.lastValidated).toBeDefined();
  });

  it('throws on empty calibration set', () => {
    expect(() => buildCalibrationSet('Empty', 'Test').build()).toThrow();
  });

  it('supports version numbering', () => {
    const calSet = buildCalibrationSet('Versioned', 'Test')
      .version(3)
      .example('Only one')
        .output('test')
        .task('test')
        .scores({ quality: 3 })
        .done()
      .build();

    expect(calSet.version).toBe(3);
  });
});

// ─── CALIBRATION ENGINE ─────────────────────────────────────────────────────────

describe('calibrate', () => {
  it('reports perfect calibration when judge matches ground truth', async () => {
    const perfectJudge = createMockJudge({ quality: 4, clarity: 5 });

    const calSet = buildCalibrationSet('Perfect', 'Test Rubric')
      .example('Match')
        .output('test output')
        .task('test task')
        .scores({ quality: 4, clarity: 5 })
        .done()
      .build();

    const report = await calibrate(perfectJudge, testRubric, calSet);

    expect(report.exactMatchRate).toBe(1);
    expect(report.withinOneRate).toBe(1);
    expect(report.meanAbsoluteError).toBe(0);
    expect(report.bias).toBe(0);
    expect(report.calibrated).toBe(true);
  });

  it('detects generous bias', async () => {
    const generousJudge = createGenerousJudge();

    const calSet = buildCalibrationSet('Bias Test', 'Test Rubric')
      .example('Should be low')
        .output('minimal')
        .task('test')
        .scores({ quality: 2, clarity: 2 })
        .done()
      .example('Should be mid')
        .output('decent work')
        .task('test')
        .scores({ quality: 3, clarity: 3 })
        .done()
      .build();

    const report = await calibrate(generousJudge, testRubric, calSet);

    // Judge always scores 4, ground truth is 2-3 → positive bias
    expect(report.bias).toBeGreaterThan(0);
    expect(report.suggestedThresholdAdjustment).toBeGreaterThan(0);
  });

  it('identifies unreliable criteria', async () => {
    // Judge is good at quality but bad at clarity
    const unevenJudge: JudgeBackend = {
      name: 'uneven',
      async evaluate(_output, rubric, _ctx) {
        return {
          scores: rubric.criteria.map(c => ({
            criterionId: c.id,
            score: c.id === 'quality' ? 3 : 5, // Clarity always way off
            reasoning: 'test',
            evidence: [],
            confidence: 0.8,
          })),
          summary: '',
          suggestions: [],
        };
      },
    };

    const calSet = buildCalibrationSet('Uneven', 'Test')
      .example('Ex1')
        .output('test')
        .task('test')
        .scores({ quality: 3, clarity: 2 })
        .done()
      .example('Ex2')
        .output('test2')
        .task('test2')
        .scores({ quality: 3, clarity: 1 })
        .done()
      .build();

    const report = await calibrate(unevenJudge, testRubric, calSet);

    const qualityCal = report.criteria.find(c => c.criterionId === 'quality');
    const clarityCal = report.criteria.find(c => c.criterionId === 'clarity');

    expect(qualityCal!.reliable).toBe(true);
    expect(clarityCal!.reliable).toBe(false); // Always off by 3+
  });

  it('reports worst misses', async () => {
    const badJudge = createMockJudge({ quality: 5, clarity: 5 });

    const calSet = buildCalibrationSet('Misses', 'Test')
      .example('Way off')
        .output('bad')
        .task('test')
        .scores({ quality: 1, clarity: 1 })
        .done()
      .build();

    const report = await calibrate(badJudge, testRubric, calSet);

    expect(report.worstMisses.length).toBeGreaterThan(0);
    expect(Math.abs(report.worstMisses[0]!.delta)).toBeGreaterThanOrEqual(4);
  });
});

// ─── DRIFT DETECTION ────────────────────────────────────────────────────────────

describe('detectDrift', () => {
  const baselineReport: CalibrationReport = {
    backendName: 'test',
    rubricName: 'Test',
    exampleCount: 5,
    exactMatchRate: 0.6,
    withinOneRate: 0.9,
    meanAbsoluteError: 0.4,
    bias: 0.1,
    criteria: [
      { criterionId: 'quality', sampleCount: 5, exactMatchRate: 0.6, withinOneRate: 0.9, meanAbsoluteError: 0.4, bias: 0.1, deltas: [], reliable: true },
      { criterionId: 'clarity', sampleCount: 5, exactMatchRate: 0.6, withinOneRate: 0.9, meanAbsoluteError: 0.4, bias: 0.0, deltas: [], reliable: true },
    ],
    worstMisses: [],
    calibrated: true,
    suggestedThresholdAdjustment: 0.02,
    durationMs: 100,
  };

  const baseline: CalibrationSnapshot = {
    timestamp: '2024-01-01T00:00:00Z',
    backendName: 'test',
    modelVersion: 'v1',
    report: baselineReport,
  };

  it('detects no drift when reports are similar', () => {
    const current: CalibrationReport = { ...baselineReport, bias: 0.12 };
    const result = detectDrift(baseline, current);

    expect(result.drifted).toBe(false);
    expect(result.summary).toContain('No significant drift');
  });

  it('detects bias drift', () => {
    const current: CalibrationReport = {
      ...baselineReport,
      bias: 0.5,
      criteria: baselineReport.criteria.map(c => ({ ...c, bias: c.bias + 0.4 })),
    };
    const result = detectDrift(baseline, current, 0.1);

    expect(result.drifted).toBe(true);
    expect(result.biasDelta).toBeGreaterThan(0.3);
    expect(result.summary).toContain('generous');
  });

  it('detects accuracy drop', () => {
    const current: CalibrationReport = {
      ...baselineReport,
      withinOneRate: 0.7,
    };
    const result = detectDrift(baseline, current, 0.1);

    expect(result.drifted).toBe(true);
    expect(result.withinOneDelta).toBeLessThan(-0.1);
  });

  it('identifies drifted criteria', () => {
    const current: CalibrationReport = {
      ...baselineReport,
      criteria: [
        { ...baselineReport.criteria[0]!, bias: 0.1 }, // Same
        { ...baselineReport.criteria[1]!, bias: 0.5 }, // Drifted
      ],
    };
    const result = detectDrift(baseline, current, 0.1);

    expect(result.driftedCriteria.length).toBe(1);
    expect(result.driftedCriteria[0]!.criterionId).toBe('clarity');
  });
});
