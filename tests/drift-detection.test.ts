/**
 * Direct unit tests for the drift DETECTION pass (`src/checks/drift-detection.ts`).
 *
 * The detection pass — `mapRequirementsToSegments` (requirement→segment mapping)
 * and `detectDriftIssues` (drift-pattern detection) — was extracted from
 * `drift.ts` into its own module. `drift.test.ts` exercises these two functions
 * transitively through the `drift.js` re-export; this file pins them directly at
 * their new home and covers edge cases the orchestration suite doesn't, mirroring
 * `drift-relevance.test.ts` / `drift-segmentation.test.ts`.
 *
 * It also asserts the public surface is preserved: the symbols re-exported from
 * `drift.js` are the SAME function references defined here, so `checks/index.ts`
 * and the top-level barrel keep resolving them unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  mapRequirementsToSegments,
  detectDriftIssues,
} from '../src/checks/drift-detection.js';
import {
  mapRequirementsToSegments as mapViaDrift,
  detectDriftIssues as detectViaDrift,
  decomposeTask,
} from '../src/checks/drift.js';
import type { TaskRequirement, OutputSegment } from '../src/checks/drift-segmentation.js';

/** Build an OutputSegment with sensible defaults for the fields under test. */
function seg(text: string, over: Partial<OutputSegment> = {}): OutputSegment {
  return {
    text,
    label: over.label ?? 'Segment',
    startIndex: over.startIndex ?? 0,
    endIndex: over.endIndex ?? text.length,
    addressesRequirements: over.addressesRequirements ?? [],
    relevanceScore: over.relevanceScore ?? 0,
  };
}

// ═══ PUBLIC SURFACE PRESERVATION ════════════════════════════════════════════════

describe('drift-detection: public surface preserved via drift.js', () => {
  it('re-exports the SAME mapRequirementsToSegments reference from drift.js', () => {
    expect(mapViaDrift).toBe(mapRequirementsToSegments);
  });

  it('re-exports the SAME detectDriftIssues reference from drift.js', () => {
    expect(detectViaDrift).toBe(detectDriftIssues);
  });
});

// ═══ mapRequirementsToSegments ══════════════════════════════════════════════════

describe('drift-detection: mapRequirementsToSegments edge cases', () => {
  it('returns the input array unchanged when there are no segments', () => {
    const requirements: TaskRequirement[] = [
      { description: 'Fix the bug', action: 'fix', subject: 'bug', confidence: 0.8 },
    ];
    const segments: OutputSegment[] = [];
    const result = mapRequirementsToSegments(requirements, segments);
    expect(result).toBe(segments); // same reference — short-circuit, no copy
    expect(result).toHaveLength(0);
  });

  it('returns the input array unchanged when there are no requirements', () => {
    const segments = [seg('anything at all')];
    const result = mapRequirementsToSegments([], segments);
    expect(result).toBe(segments);
  });

  it('records the maximum combined score on the segment even below threshold', () => {
    // A segment weakly related to the subject but under the (high) threshold:
    // it should NOT be mapped, yet relevanceScore must still reflect the best match.
    const requirements: TaskRequirement[] = [
      { description: 'Fix the login bug', action: 'fix', subject: 'login authentication token', confidence: 0.8 },
    ];
    const segments = [seg('I corrected the authentication token validation logic in the login flow.')];
    const result = mapRequirementsToSegments(requirements, segments, 0.99);
    expect(result[0]!.addressesRequirements).toEqual([]);
    expect(result[0]!.relevanceScore).toBeGreaterThan(0);
  });

  it('lifts the combined score when the ACTION verb also matches (same subject text)', () => {
    // checkActionMatch contributes 30% of the combined score. Holding the subject
    // wording constant and only appending the action verb must not LOWER the
    // score — the action signal can only add to the subject match.
    const requirements: TaskRequirement[] = [
      { description: 'Add tests for the parser', action: 'test', subject: 'parser module', confidence: 0.8 },
    ];
    const base = 'The parser module handles the parser module grammar for the parser module.';
    const withAction = seg(`${base} I added unit tests that assert and verify it.`);
    const withoutAction = seg(base);

    const threshold = 0.12;
    const mappedWith = mapRequirementsToSegments(requirements, [withAction], threshold);
    const mappedWithout = mapRequirementsToSegments(requirements, [withoutAction], threshold);

    // The action-verb-bearing segment scores at least as high as the bare one,
    // and clears the threshold so it maps to the requirement.
    expect(mappedWith[0]!.relevanceScore).toBeGreaterThanOrEqual(mappedWithout[0]!.relevanceScore);
    expect(mappedWith[0]!.addressesRequirements).toContain(0);
  });

  it('preserves segment identity fields while annotating mapping results', () => {
    const requirements: TaskRequirement[] = [
      { description: 'Fix the login bug', action: 'fix', subject: 'login bug', confidence: 0.8 },
    ];
    const segments = [seg('Fixed the login bug by correcting token validation.', {
      label: 'Bug Fix', startIndex: 10, endIndex: 60,
    })];
    const [result] = mapRequirementsToSegments(requirements, segments);
    expect(result!.label).toBe('Bug Fix');
    expect(result!.startIndex).toBe(10);
    expect(result!.endIndex).toBe(60);
  });
});

// ═══ detectDriftIssues ══════════════════════════════════════════════════════════

describe('drift-detection: detectDriftIssues edge cases', () => {
  it('short-circuits on off-topic: returns ONLY the off-topic issue', () => {
    const task = 'Fix the authentication bug in the login module';
    const requirements = decomposeTask(task);
    // Unrelated text that also carries a scope-creep marker — which must NOT
    // surface, because off-topic returns immediately before later checks run.
    const text = 'The history of pizza is fascinating. Additionally, I also went ahead and toured Naples.';
    const segments = [seg(text, { addressesRequirements: [] })];

    const issues = detectDriftIssues(task, requirements, segments, text);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('off-topic');
    expect(issues[0]!.severity).toBe(1);
    // Every requirement is reported missed when the whole output is off-topic.
    expect(issues[0]!.missedRequirements).toEqual(requirements.map((_, i) => i));
  });

  it('flags wrong-action when the subject is present but the action verb is absent', () => {
    const task = 'Review the authentication module';
    const requirements: TaskRequirement[] = [
      { description: 'Review the authentication module', action: 'review', subject: 'authentication module security', confidence: 0.8 },
    ];
    // Strongly on-subject, but it REWRITES instead of REVIEWING — no review verbs.
    const text = 'I rewrote the authentication module security layer and replaced the whole authentication module security pipeline with a new authentication module security implementation.';
    const segments = [seg(text, { addressesRequirements: [0], relevanceScore: 0.5 })];

    const issues = detectDriftIssues(task, requirements, segments, text);
    expect(issues.some((i) => i.kind === 'wrong-action')).toBe(true);
    const wrong = issues.find((i) => i.kind === 'wrong-action')!;
    expect(wrong.missedRequirements).toContain(0);
    expect(wrong.evidence.join(' ')).toContain('review');
  });

  it('does not flag partial-address when coverage meets the threshold', () => {
    const task = 'Fix the bug and add tests';
    const requirements = decomposeTask(task);
    expect(requirements.length).toBe(2);
    // Both requirements covered → no partial-address issue.
    const segments = [
      seg('Fixed the bug by correcting the null dereference.', { addressesRequirements: [0], relevanceScore: 0.4 }),
      seg('Added unit tests covering the fix.', { addressesRequirements: [1], relevanceScore: 0.4 }),
    ];
    const output = segments.map((s) => s.text).join('\n');
    const issues = detectDriftIssues(task, requirements, segments, output, { coverageThreshold: 0.6 });
    expect(issues.some((i) => i.kind === 'partial-address')).toBe(false);
  });

  it('respects a relaxed maxTangentRatio (no tangential issue when allowance is high)', () => {
    const task = 'Review the authentication code';
    const requirements = decomposeTask(task);
    const segments = [
      seg('The authentication code looks solid with proper token validation.', {
        addressesRequirements: [0], relevanceScore: 0.5,
      }),
      seg('A long aside about the history of OAuth2 and its evolution since 2006, the delegated authorization framework for web applications and services that has gone through many revisions.', {
        addressesRequirements: [], relevanceScore: 0.05,
      }),
    ];
    const output = segments.map((s) => s.text).join('\n');
    // Default 0.4 would flag this; a 0.95 allowance must not.
    const issues = detectDriftIssues(task, requirements, segments, output, { maxTangentRatio: 0.95 });
    expect(issues.some((i) => i.kind === 'tangential')).toBe(false);
  });

  it('ignores short tangential segments (<= 50 chars) when computing tangent ratio', () => {
    const task = 'Review the authentication code';
    const requirements = decomposeTask(task);
    const segments = [
      seg('Reviewed the authentication code; token validation and session handling look correct and safe.', {
        addressesRequirements: [0], relevanceScore: 0.5,
      }),
      seg('Nice work.', { addressesRequirements: [], relevanceScore: 0 }), // < 50 chars → excluded
    ];
    const output = segments.map((s) => s.text).join('\n');
    const issues = detectDriftIssues(task, requirements, segments, output, { maxTangentRatio: 0.4 });
    expect(issues.some((i) => i.kind === 'tangential')).toBe(false);
  });

  it('emits a single task-substitution issue even when multiple markers match', () => {
    const task = 'Explain how the caching system works';
    const requirements = decomposeTask(task);
    // Contains two distinct substitution markers; only one issue should be emitted.
    const text = 'Instead, I will rewrite the caching layer. A better approach would be to redesign it from scratch.';
    const segments = [seg(text, { addressesRequirements: [], relevanceScore: 0.1 })];
    const issues = detectDriftIssues(task, requirements, segments, text);
    const subs = issues.filter((i) => i.kind === 'task-substitution');
    expect(subs).toHaveLength(1);
    expect(subs[0]!.severity).toBeCloseTo(0.7, 5);
  });

  it('returns no issues for focused output with a single fully-covered requirement', () => {
    const task = 'Fix the login bug';
    const requirements = decomposeTask(task);
    const text = 'I fixed the login bug by correcting the token validation in auth.ts; the issue was a missing null check.';
    const segments = [seg(text, { addressesRequirements: [0], relevanceScore: 0.6 })];
    const issues = detectDriftIssues(task, requirements, segments, text);
    expect(issues.filter((i) => i.severity > 0.5)).toHaveLength(0);
  });
});
