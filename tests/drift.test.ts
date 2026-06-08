/**
 * Tests for the Drift Judge module.
 *
 * Tests cover:
 * - Task decomposition (single/multi requirements, action verbs, noun phrases)
 * - Output segmentation (headings, paragraphs, topic shifts)
 * - Requirement-segment mapping (relevance scoring, action matching)
 * - Drift issue detection (off-topic, wrong-action, scope-creep, partial, tangential, substitution)
 * - Full drift analysis (empty inputs, on-task, drifted, ambiguous)
 * - Assertion factories (toNotDrift, toAddressRequirements, toHaveDriftBelow, toNotExhibitDrift, toPassDriftJudge)
 * - DRIFT_RUBRIC structure validation
 */

import { describe, it, expect } from 'vitest';
import {
  decomposeTask,
  segmentOutput,
  mapRequirementsToSegments,
  detectDriftIssues,
  analyzeDrift,
  DRIFT_RUBRIC,
  toNotDrift,
  toAddressRequirements,
  toHaveDriftBelow,
  toNotExhibitDrift,
  toPassDriftJudge,
} from '../src/checks/drift.js';
import type {
  TaskRequirement,
  OutputSegment,
} from '../src/checks/drift.js';
import type { JudgeBackend, RawJudgeResponse, Rubric, JudgeContext } from '../src/checks/judge.js';
import { validateRubric } from '../src/checks/judge.js';

// ═══ HELPERS ═════════════════════════════════════════════════════════════════════

function makeJudgeBackend(scores: Record<string, number>, confidence = 0.8): JudgeBackend {
  return {
    name: 'mock-drift-judge',
    async evaluate(_output: string, rubric: Rubric, _context: JudgeContext): Promise<RawJudgeResponse> {
      return {
        scores: rubric.criteria.map((c) => ({
          criterionId: c.id,
          score: scores[c.id] ?? 3,
          reasoning: `Mock score for ${c.id}`,
          evidence: ['mock evidence'],
          confidence,
        })),
        summary: 'Mock drift judge evaluation',
        suggestions: ['improve focus'],
      };
    },
  };
}

// ═══ TASK DECOMPOSITION ══════════════════════════════════════════════════════════

describe('decomposeTask', () => {
  it('returns empty array for empty/null input', () => {
    expect(decomposeTask('')).toEqual([]);
    expect(decomposeTask('   ')).toEqual([]);
  });

  it('extracts single requirement with verb + subject', () => {
    const reqs = decomposeTask('Fix the login bug');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.action).toBe('fix');
    expect(reqs[0]!.subject).toContain('login');
    expect(reqs[0]!.subject).toContain('bug');
    expect(reqs[0]!.confidence).toBeGreaterThan(0.5);
  });

  it('extracts multiple requirements joined by "and"', () => {
    const reqs = decomposeTask('Fix the bug and add unit tests');
    expect(reqs.length).toBe(2);
    expect(reqs[0]!.action).toBe('fix');
    expect(reqs[1]!.action).toBe('add');
    expect(reqs[1]!.subject).toContain('unit');
    expect(reqs[1]!.subject).toContain('test');
  });

  it('extracts requirements from numbered list', () => {
    const task = '1. Review the PR changes\n2. Add test coverage\n3. Update the README';
    const reqs = decomposeTask(task);
    expect(reqs.length).toBe(3);
    expect(reqs[0]!.action).toBe('review');
    expect(reqs[1]!.action).toBe('add');
    expect(reqs[2]!.action).toBe('update');
  });

  it('extracts requirements from bullet points', () => {
    const task = '- Fix the auth middleware\n- Add error handling\n- Remove deprecated endpoints';
    const reqs = decomposeTask(task);
    expect(reqs.length).toBe(3);
    expect(reqs[0]!.action).toBe('fix');
    expect(reqs[1]!.action).toBe('add');
    expect(reqs[2]!.action).toBe('remove');
  });

  it('handles noun-phrase tasks without verbs', () => {
    const reqs = decomposeTask('ESLint configuration guide');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.action).toBe('address');
    expect(reqs[0]!.confidence).toBeLessThan(0.6);
  });

  it('recognizes custom action verbs', () => {
    const reqs = decomposeTask('Frobulate the quantum field', ['frobulate']);
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.action).toBe('frobulate');
    expect(reqs[0]!.subject).toContain('quantum');
  });

  it('handles tasks with semicolons as separators', () => {
    const reqs = decomposeTask('Explain the error; fix if possible; update docs');
    expect(reqs.length).toBe(3);
    expect(reqs[0]!.action).toBe('explain');
    expect(reqs[1]!.action).toBe('fix');
    expect(reqs[2]!.action).toBe('update');
  });

  it('handles imperative-style tasks', () => {
    const reqs = decomposeTask('Deploy the service to production');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.action).toBe('deploy');
    expect(reqs[0]!.subject).toContain('service');
    expect(reqs[0]!.subject).toContain('production');
  });

  it('strips filler words from subjects', () => {
    const reqs = decomposeTask('Please review the changes in this PR');
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.action).toBe('review');
    expect(reqs[0]!.subject).not.toContain('please');
  });
});

// ═══ OUTPUT SEGMENTATION ═════════════════════════════════════════════════════════

describe('segmentOutput', () => {
  it('returns empty array for empty input', () => {
    expect(segmentOutput('')).toEqual([]);
    expect(segmentOutput('   ')).toEqual([]);
  });

  it('creates single segment for short unstructured output', () => {
    const segments = segmentOutput('This is a simple response with no headings.');
    expect(segments.length).toBe(1);
    expect(segments[0]!.text).toContain('simple response');
  });

  it('splits on markdown headings', () => {
    const output = `Introduction paragraph here.

## Bug Analysis
The bug is in the auth module.

## Fix Applied
Changed the validation logic.`;
    const segments = segmentOutput(output);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    const labels = segments.map((s) => s.label);
    expect(labels.some((l) => l.includes('Bug Analysis'))).toBe(true);
    expect(labels.some((l) => l.includes('Fix Applied'))).toBe(true);
  });

  it('respects startIndex and endIndex', () => {
    const output = `# First Section
Content of first section.

# Second Section
Content of second section.`;
    const segments = segmentOutput(output);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const seg of segments) {
      expect(seg.startIndex).toBeGreaterThanOrEqual(0);
      expect(seg.endIndex).toBeGreaterThan(seg.startIndex);
    }
  });

  it('preserves text content within segments', () => {
    const output = `# Review
The code looks good overall. One issue: the error handling is missing.

# Suggestions
Add try-catch around the database calls.`;
    const segments = segmentOutput(output);
    // The full output should be captured across segments
    const allText = segments.map((s) => s.text).join(' ');
    expect(allText).toContain('error handling');
  });
});

// ═══ REQUIREMENT-SEGMENT MAPPING ════════════════════════════════════════════════

describe('mapRequirementsToSegments', () => {
  it('returns unmodified segments when no requirements', () => {
    const segments: OutputSegment[] = [{
      text: 'Some text',
      label: 'Test',
      startIndex: 0,
      endIndex: 9,
      addressesRequirements: [],
      relevanceScore: 0,
    }];
    const result = mapRequirementsToSegments([], segments);
    expect(result[0]!.addressesRequirements).toEqual([]);
  });

  it('maps relevant segment to matching requirement', () => {
    const requirements: TaskRequirement[] = [{
      description: 'Fix the login bug',
      action: 'fix',
      subject: 'login bug authentication',
      confidence: 0.8,
    }];
    const segments: OutputSegment[] = [{
      text: 'I fixed the login bug by correcting the authentication token validation. The fix ensures tokens are properly validated before granting access.',
      label: 'Fix',
      startIndex: 0,
      endIndex: 150,
      addressesRequirements: [],
      relevanceScore: 0,
    }];

    const result = mapRequirementsToSegments(requirements, segments);
    expect(result[0]!.addressesRequirements).toContain(0);
    expect(result[0]!.relevanceScore).toBeGreaterThan(0);
  });

  it('does not map irrelevant segment to requirement', () => {
    const requirements: TaskRequirement[] = [{
      description: 'Fix the login bug',
      action: 'fix',
      subject: 'login bug',
      confidence: 0.8,
    }];
    const segments: OutputSegment[] = [{
      text: 'The weather forecast for tomorrow shows sunny skies with temperatures reaching 75 degrees Fahrenheit.',
      label: 'Weather',
      startIndex: 0,
      endIndex: 100,
      addressesRequirements: [],
      relevanceScore: 0,
    }];

    const result = mapRequirementsToSegments(requirements, segments);
    expect(result[0]!.addressesRequirements).toEqual([]);
  });

  it('maps multiple requirements to appropriate segments', () => {
    const requirements: TaskRequirement[] = [
      { description: 'Fix the login bug', action: 'fix', subject: 'login bug', confidence: 0.8 },
      { description: 'Add tests', action: 'add', subject: 'tests unit testing', confidence: 0.8 },
    ];
    const segments: OutputSegment[] = [
      {
        text: 'Fixed the login bug in the authentication module by correcting token validation.',
        label: 'Bug Fix', startIndex: 0, endIndex: 80, addressesRequirements: [], relevanceScore: 0,
      },
      {
        text: 'Added unit tests for the new validation logic. Tests cover valid and invalid tokens.',
        label: 'Tests', startIndex: 81, endIndex: 170, addressesRequirements: [], relevanceScore: 0,
      },
    ];

    const result = mapRequirementsToSegments(requirements, segments);
    expect(result[0]!.addressesRequirements).toContain(0);
    expect(result[1]!.addressesRequirements).toContain(1);
  });
});

// ═══ DRIFT ISSUE DETECTION ═════════════════════════════════════════════════════════

describe('detectDriftIssues', () => {
  it('detects off-topic output', () => {
    const task = 'Fix the authentication bug in the login module';
    const requirements = decomposeTask(task);
    const segments: OutputSegment[] = [{
      text: 'The history of pizza dates back to ancient civilizations. Naples, Italy is widely regarded as the birthplace of modern pizza making traditions.',
      label: 'Pizza History',
      startIndex: 0,
      endIndex: 140,
      addressesRequirements: [],
      relevanceScore: 0,
    }];
    const output = segments[0]!.text;

    const issues = detectDriftIssues(task, requirements, segments, output);
    expect(issues.some((i) => i.kind === 'off-topic')).toBe(true);
    expect(issues.find((i) => i.kind === 'off-topic')!.severity).toBeGreaterThan(0.8);
  });

  it('detects scope creep', () => {
    const task = 'Fix the login bug';
    const requirements = decomposeTask(task);
    const segments: OutputSegment[] = [{
      text: 'Fixed the login bug. Additionally, I also noticed the password hashing was weak so I refactored that too. While I was at it, I also updated the database schema.',
      label: 'Changes',
      startIndex: 0,
      endIndex: 160,
      addressesRequirements: [0],
      relevanceScore: 0.3,
    }];
    const output = segments[0]!.text;

    const issues = detectDriftIssues(task, requirements, segments, output);
    expect(issues.some((i) => i.kind === 'scope-creep')).toBe(true);
  });

  it('detects task substitution', () => {
    const task = 'Explain how the caching system works';
    const requirements = decomposeTask(task);
    const segments: OutputSegment[] = [{
      text: 'Instead, I will rewrite the entire caching system from scratch because the implementation is flawed.',
      label: 'Approach',
      startIndex: 0,
      endIndex: 100,
      addressesRequirements: [],
      relevanceScore: 0.1,
    }];
    const output = segments[0]!.text;

    const issues = detectDriftIssues(task, requirements, segments, output);
    expect(issues.some((i) => i.kind === 'task-substitution')).toBe(true);
  });

  it('detects partial-address when requirements are missed', () => {
    const task = 'Fix the bug and add tests and update docs';
    const requirements = decomposeTask(task);
    expect(requirements.length).toBe(3);

    const segments: OutputSegment[] = [{
      text: 'Fixed the bug by correcting the null pointer dereference in the parser module.',
      label: 'Fix',
      startIndex: 0,
      endIndex: 80,
      addressesRequirements: [0],
      relevanceScore: 0.4,
    }];
    const output = segments[0]!.text;

    const issues = detectDriftIssues(task, requirements, segments, output, {
      coverageThreshold: 0.6,
    });
    expect(issues.some((i) => i.kind === 'partial-address')).toBe(true);
    const partial = issues.find((i) => i.kind === 'partial-address')!;
    expect(partial.missedRequirements.length).toBeGreaterThan(0);
  });

  it('detects tangential content', () => {
    const task = 'Review the authentication code';
    const requirements = decomposeTask(task);
    const segments: OutputSegment[] = [
      {
        text: 'The authentication code looks solid with proper token validation.',
        label: 'Review', startIndex: 0, endIndex: 60,
        addressesRequirements: [0], relevanceScore: 0.5,
      },
      {
        text: 'Here is a long discussion about the history of OAuth2 and how it evolved from OAuth1. The original specification was published in 2006 and has since gone through many revisions. The framework provides delegated authorization for web applications and services.',
        label: 'OAuth History', startIndex: 61, endIndex: 320,
        addressesRequirements: [], relevanceScore: 0.05,
      },
    ];
    const output = segments.map((s) => s.text).join('\n');

    const issues = detectDriftIssues(task, requirements, segments, output, {
      maxTangentRatio: 0.4,
    });
    expect(issues.some((i) => i.kind === 'tangential')).toBe(true);
  });

  it('returns no severe issues for well-focused output', () => {
    const task = 'Fix the login bug';
    const requirements = decomposeTask(task);
    const segments: OutputSegment[] = [{
      text: 'I fixed the login bug by correcting the token validation in auth.ts. The issue was a missing null check.',
      label: 'Fix',
      startIndex: 0,
      endIndex: 100,
      addressesRequirements: [0],
      relevanceScore: 0.6,
    }];
    const output = segments[0]!.text;

    const issues = detectDriftIssues(task, requirements, segments, output);
    const severeIssues = issues.filter((i) => i.severity > 0.5);
    expect(severeIssues.length).toBe(0);
  });
});

// ═══ FULL DRIFT ANALYSIS ═══════════════════════════════════════════════════════════

describe('analyzeDrift', () => {
  it('handles empty task gracefully', async () => {
    const result = await analyzeDrift('', 'Some output');
    expect(result.onTask).toBe(true);
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.needsReview).toBe(true);
    expect(result.summary).toContain('no task provided');
  });

  it('handles empty output as off-topic', async () => {
    const result = await analyzeDrift('Fix the login bug', '');
    expect(result.onTask).toBe(false);
    expect(result.driftScore).toBe(1);
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('identifies on-task output', async () => {
    const task = 'Fix the authentication bug in the login module';
    const output = `## Bug Fix\n\nI identified and fixed the authentication bug in the login module. The issue was in the token validation function where expired tokens were not being rejected.\n\n### Changes Made\n- Fixed the token expiration check in auth/login.ts\n- Added proper error message for expired tokens\n\nThe login module now correctly rejects expired authentication tokens.`;

    const result = await analyzeDrift(task, output);
    expect(result.driftScore).toBeLessThan(0.5);
    expect(result.requirementCoverage).toBeGreaterThan(0);
    expect(result.requirements.length).toBeGreaterThan(0);
  });

  it('identifies off-topic output', async () => {
    const task = 'Fix the authentication bug in the login module';
    const output = 'The best pizza in New York can be found at several locations. Joes Pizza on Carmine Street has been serving classic slices since 1975. Another great option is Di Fara Pizza in Brooklyn.';

    const result = await analyzeDrift(task, output);
    expect(result.onTask).toBe(false);
    expect(result.driftScore).toBeGreaterThan(0.5);
    expect(result.issues.some((i) => i.kind === 'off-topic')).toBe(true);
  });

  it('reports requirement coverage accurately', async () => {
    const task = 'Fix the bug and add tests and update documentation';
    const output = '## Bug Fix\nFixed the null pointer exception in the parser by adding a null check.\n\n## Tests Added\nAdded 5 unit tests covering the edge cases for the parser module.';

    const result = await analyzeDrift(task, output);
    expect(result.requirements.length).toBe(3);
    expect(result.requirementCoverage).toBeGreaterThan(0);
    expect(result.requirementCoverage).toBeLessThanOrEqual(1);
  });

  it('computes tangent ratio', async () => {
    const task = 'Explain how the cache works';
    const output = 'The cache uses an LRU eviction strategy with a TTL of 60 seconds. Keys are hashed for O(1) lookup.';

    const result = await analyzeDrift(task, output);
    expect(result.tangentRatio).toBeGreaterThanOrEqual(0);
    expect(result.tangentRatio).toBeLessThanOrEqual(1);
  });

  it('has valid duration measurement', async () => {
    const result = await analyzeDrift('Fix the bug', 'Fixed the bug in auth.ts');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });
});

// ═══ DRIFT RUBRIC ═══════════════════════════════════════════════════════════════

describe('DRIFT_RUBRIC', () => {
  it('is a valid rubric', () => {
    const errors = validateRubric(DRIFT_RUBRIC);
    expect(errors).toEqual([]);
  });

  it('has the expected criteria', () => {
    const ids = DRIFT_RUBRIC.criteria.map((c) => c.id);
    expect(ids).toContain('task-address');
    expect(ids).toContain('action-alignment');
    expect(ids).toContain('focus');
  });

  it('has proper pass and confidence thresholds', () => {
    expect(DRIFT_RUBRIC.passThreshold).toBeGreaterThan(0);
    expect(DRIFT_RUBRIC.passThreshold).toBeLessThanOrEqual(1);
    expect(DRIFT_RUBRIC.confidenceThreshold).toBeGreaterThan(0);
    expect(DRIFT_RUBRIC.confidenceThreshold).toBeLessThanOrEqual(1);
  });

  it('has criteria weights summing close to 1', () => {
    const totalWeight = DRIFT_RUBRIC.criteria.reduce((sum, c) => sum + (c.weight ?? 0), 0);
    expect(totalWeight).toBeCloseTo(1, 1);
  });

  it('has at least 2 levels per criterion', () => {
    for (const criterion of DRIFT_RUBRIC.criteria) {
      expect(criterion.levels.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ═══ ASSERTION: toNotDrift ═══════════════════════════════════════════════════════

describe('toNotDrift', () => {
  it('returns error when no prompt provided', async () => {
    const assertion = toNotDrift();
    const result = await assertion.evaluate('some output');
    expect(result.status).toBe('error');
    expect(result.message).toContain('No task/prompt');
  });

  it('passes for on-task output', async () => {
    const assertion = toNotDrift();
    const result = await assertion.evaluate(
      'Fixed the login bug by correcting the token validation in auth.ts. The issue was a null check missing on the expiration field.',
      { prompt: 'Fix the login bug' },
    );
    expect(['pass', 'skip']).toContain(result.status);
  });

  it('fails for off-topic output', async () => {
    const assertion = toNotDrift();
    const result = await assertion.evaluate(
      'The best restaurants in Paris include Le Jules Verne at the Eiffel Tower, offering stunning views and refined French cuisine with seasonal ingredients.',
      { prompt: 'Fix the authentication bug in the login module' },
    );
    expect(result.status).toBe('fail');
  });

  it('has correct assertion name', () => {
    const assertion = toNotDrift({ coverageThreshold: 0.7 });
    expect(assertion.name).toContain('Tier 3');
    expect(assertion.name).toContain('drift');
  });
});

// ═══ ASSERTION: toAddressRequirements ══════════════════════════════════════════

describe('toAddressRequirements', () => {
  it('returns error when no prompt provided', async () => {
    const assertion = toAddressRequirements();
    const result = await assertion.evaluate('some output');
    expect(result.status).toBe('error');
  });

  it('passes when requirements addressed', async () => {
    const assertion = toAddressRequirements(0.5);
    const result = await assertion.evaluate(
      'I fixed the login bug by patching the token validation. The authentication module now correctly rejects expired tokens.',
      { prompt: 'Fix the login bug' },
    );
    expect(result.status).toBe('pass');
  });

  it('includes evidence in result', async () => {
    const assertion = toAddressRequirements(0.5);
    const result = await assertion.evaluate(
      'I reviewed the code and found several issues with error handling.',
      { prompt: 'Review the code and add tests' },
    );
    if (result.evidence) {
      expect(result.evidence.length).toBeGreaterThan(0);
    }
  });
});

// ═══ ASSERTION: toHaveDriftBelow ═══════════════════════════════════════════════

describe('toHaveDriftBelow', () => {
  it('returns error when no prompt provided', async () => {
    const assertion = toHaveDriftBelow();
    const result = await assertion.evaluate('some output');
    expect(result.status).toBe('error');
  });

  it('passes when drift score is below threshold', async () => {
    const assertion = toHaveDriftBelow(0.8);
    const result = await assertion.evaluate(
      'Fixed the bug in authentication by adding the missing null check on token expiry field.',
      { prompt: 'Fix the authentication bug' },
    );
    expect(['pass', 'skip']).toContain(result.status);
  });

  it('fails for off-topic output with low threshold', async () => {
    const assertion = toHaveDriftBelow(0.2);
    const result = await assertion.evaluate(
      'Spaghetti carbonara is made with eggs, Pecorino Romano, guanciale, and black pepper.',
      { prompt: 'Fix the authentication bug in the login module' },
    );
    expect(['fail', 'skip']).toContain(result.status);
  });
});

// ═══ ASSERTION: toNotExhibitDrift ══════════════════════════════════════════════

describe('toNotExhibitDrift', () => {
  it('returns error when no prompt provided', async () => {
    const assertion = toNotExhibitDrift();
    const result = await assertion.evaluate('some output');
    expect(result.status).toBe('error');
  });

  it('passes when no drift issues of specified kind found', async () => {
    const assertion = toNotExhibitDrift(['off-topic'], 0.5);
    const result = await assertion.evaluate(
      'Fixed the login bug by correcting the token validation. The authentication now properly rejects expired tokens.',
      { prompt: 'Fix the login bug' },
    );
    expect(result.status).toBe('pass');
  });

  it('fails when specified drift kind is detected', async () => {
    const assertion = toNotExhibitDrift(['scope-creep'], 0.2);
    const result = await assertion.evaluate(
      'Fixed the bug. Additionally, I also noticed the database schema was inefficient so I refactored that too. While I was at it, I also updated the CI pipeline configuration.',
      { prompt: 'Fix the login bug' },
    );
    expect(result.status).toBe('fail');
  });

  it('passes when drift issues are below severity threshold', async () => {
    const assertion = toNotExhibitDrift(['scope-creep'], 0.9);
    const result = await assertion.evaluate(
      'Fixed the bug. Additionally, I also noticed a minor typo so I fixed that too.',
      { prompt: 'Fix the login bug' },
    );
    expect(result.status).toBe('pass');
  });
});

// ═══ ASSERTION: toPassDriftJudge ═══════════════════════════════════════════════

describe('toPassDriftJudge', () => {
  it('returns error when no prompt provided', async () => {
    const backend = makeJudgeBackend({ 'task-address': 5, 'action-alignment': 5, focus: 5 });
    const assertion = toPassDriftJudge(backend);
    const result = await assertion.evaluate('some output');
    expect(result.status).toBe('error');
  });

  it('passes with high judge scores', async () => {
    const backend = makeJudgeBackend({ 'task-address': 5, 'action-alignment': 5, focus: 5 });
    const assertion = toPassDriftJudge(backend);
    const result = await assertion.evaluate(
      'Fixed the login bug by correcting token validation.',
      { prompt: 'Fix the login bug' },
    );
    expect(result.status).toBe('pass');
  });

  it('fails with low judge scores', async () => {
    const backend = makeJudgeBackend({ 'task-address': 1, 'action-alignment': 1, focus: 1 });
    const assertion = toPassDriftJudge(backend);
    const result = await assertion.evaluate(
      'Completely off-topic pizza discussion.',
      { prompt: 'Fix the authentication bug' },
    );
    expect(result.status).toBe('fail');
  });

  it('returns skip when confidence is low', async () => {
    const backend = makeJudgeBackend({ 'task-address': 3, 'action-alignment': 3, focus: 3 }, 0.3);
    const assertion = toPassDriftJudge(backend);
    const result = await assertion.evaluate(
      'Maybe related content.',
      { prompt: 'Fix the bug' },
    );
    expect(result.status).toBe('skip');
  });

  it('has correct assertion name', () => {
    const backend = makeJudgeBackend({});
    const assertion = toPassDriftJudge(backend);
    expect(assertion.name).toContain('Tier 3');
    expect(assertion.name).toContain('drift');
  });
});
