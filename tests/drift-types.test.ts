/**
 * Seam tests for the Drift check type-vocabulary split.
 *
 * `drift.ts` had its type vocabulary — `DriftKind`, `DriftIssue`,
 * `DriftAnalysisOptions`, `DriftAnalysisResult` — extracted into a leaf module
 * `drift-types.ts`, so the sibling detection pass (`drift-detection.ts`) can
 * depend on the vocabulary directly instead of importing back up into its
 * orchestrator, and `drift.ts` was kept as the public barrel (re-exporting the
 * same types) plus the analysis engine, rubric, and assertion factories.
 *
 * The behavioural suite in `drift.test.ts` imports everything from `drift.js`
 * and therefore only reaches the moved types transitively. These tests pin the
 * seam boundary itself:
 *   1. every moved type is importable from its OWN new module (`drift-types.js`),
 *   2. the public barrels (`drift.js` and `checks/index.js`) re-export the SAME
 *      structural type (values built against one path assign to the other, so a
 *      future refactor can't let a barrel silently diverge from the leaf), and
 *   3. a couple of behaviour-preservation golden checks prove `analyzeDrift` and
 *      the child `detectDriftIssues` still produce those exact shapes end to end.
 *
 * Types are erased at runtime, so a "same reference" check (as used for function
 * seams) is impossible here; instead the cross-path assignments below are the
 * compile-time proof, and `tsc` in CI is what actually enforces them.
 */

import { describe, it, expect } from 'vitest';

// Leaf module — the new home of the vocabulary.
import type {
  DriftKind as DriftKindLeaf,
  DriftIssue as DriftIssueLeaf,
  DriftAnalysisOptions as DriftAnalysisOptionsLeaf,
  DriftAnalysisResult as DriftAnalysisResultLeaf,
} from '../src/checks/drift-types.js';

// Public barrel — what consumers import; must re-export the same types.
import {
  analyzeDrift,
  decomposeTask,
  segmentOutput,
  mapRequirementsToSegments,
  detectDriftIssues,
} from '../src/checks/drift.js';
import type {
  DriftKind as DriftKindBarrel,
  DriftIssue as DriftIssueBarrel,
  DriftAnalysisOptions as DriftAnalysisOptionsBarrel,
  DriftAnalysisResult as DriftAnalysisResultBarrel,
} from '../src/checks/drift.js';

// Checks aggregate barrel — the widest public path for these Tier-3 types.
import type {
  DriftKind as DriftKindChecks,
  DriftIssue as DriftIssueChecks,
} from '../src/checks/index.js';

describe('drift-types seam: leaf ↔ barrels are the same structural type', () => {
  it('a DriftIssue built via the leaf type assigns to the barrel type (and back)', () => {
    const viaLeaf: DriftIssueLeaf = {
      kind: 'off-topic',
      description: 'wandered',
      severity: 1,
      evidence: ['nothing on task'],
      segmentIndices: [0],
      missedRequirements: [0, 1],
    };
    // Cross-path assignment is the compile-time proof the types did not diverge.
    const viaBarrel: DriftIssueBarrel = viaLeaf;
    const viaChecks: DriftIssueChecks = viaBarrel;
    const backToLeaf: DriftIssueLeaf = viaChecks;
    expect(backToLeaf.kind).toBe('off-topic');
    expect(backToLeaf).toBe(viaLeaf);
  });

  it('every DriftKind member is accepted through all three import paths', () => {
    const kinds: DriftKindLeaf[] = [
      'off-topic',
      'wrong-action',
      'scope-creep',
      'partial-address',
      'tangential',
      'task-substitution',
    ];
    for (const k of kinds) {
      const asBarrel: DriftKindBarrel = k;
      const asChecks: DriftKindChecks = asBarrel;
      const asLeaf: DriftKindLeaf = asChecks;
      expect(asLeaf).toBe(k);
    }
    expect(kinds).toHaveLength(6);
  });

  it('DriftAnalysisOptions and DriftAnalysisResult unify across leaf and barrel', () => {
    const opts: DriftAnalysisOptionsLeaf = {
      relevanceThreshold: 0.2,
      coverageThreshold: 0.5,
      maxTangentRatio: 0.4,
      useJudge: false,
    };
    const optsBarrel: DriftAnalysisOptionsBarrel = opts;
    expect(optsBarrel.coverageThreshold).toBe(0.5);

    // A minimally-shaped result value typed via the leaf must satisfy the barrel.
    const result: DriftAnalysisResultLeaf = {
      onTask: true,
      driftScore: 0,
      confidence: 0.9,
      needsReview: false,
      requirements: [],
      segments: [],
      requirementCoverage: 1,
      tangentRatio: 0,
      issues: [],
      summary: 'ok',
      durationMs: 0,
    };
    const resultBarrel: DriftAnalysisResultBarrel = result;
    expect(resultBarrel.onTask).toBe(true);
  });
});

describe('drift-types seam: behaviour is preserved through the moved shapes', () => {
  it('analyzeDrift returns a DriftAnalysisResult assignable to the leaf type', async () => {
    const out: DriftAnalysisResultLeaf = await analyzeDrift(
      'Add tests for the parser module',
      'I added three unit tests covering the parser module happy path and two edge cases.',
    );
    // Field-level shape checks (the type-erased proof that the interface holds).
    expect(typeof out.onTask).toBe('boolean');
    expect(typeof out.driftScore).toBe('number');
    expect(out.driftScore).toBeGreaterThanOrEqual(0);
    expect(out.driftScore).toBeLessThanOrEqual(1);
    expect(Array.isArray(out.requirements)).toBe(true);
    expect(Array.isArray(out.segments)).toBe(true);
    expect(Array.isArray(out.issues)).toBe(true);
    expect(typeof out.summary).toBe('string');
    for (const issue of out.issues) {
      // Each issue must be a well-formed DriftIssue.
      expect(typeof issue.kind).toBe('string');
      expect(Array.isArray(issue.evidence)).toBe(true);
      expect(Array.isArray(issue.segmentIndices)).toBe(true);
    }
  });

  it('empty output yields the off-topic DriftIssue shape (golden, unchanged)', async () => {
    const out = await analyzeDrift('Fix the login bug', '   ');
    expect(out.onTask).toBe(false);
    expect(out.driftScore).toBe(1);
    expect(out.issues).toHaveLength(1);
    const issue: DriftIssueLeaf = out.issues[0]!;
    expect(issue.kind).toBe('off-topic');
    expect(issue.severity).toBe(1);
  });

  it('the child detectDriftIssues consumes the leaf types and emits DriftIssue[]', () => {
    const task = 'Review this pull request for correctness';
    const requirements = decomposeTask(task);
    const segments = mapRequirementsToSegments(
      requirements,
      segmentOutput('Here is a full rewrite of the module with new features.'),
      0.15,
    );
    const issues: DriftIssueLeaf[] = detectDriftIssues(
      task,
      requirements,
      segments,
      'Here is a full rewrite of the module with new features.',
    );
    expect(Array.isArray(issues)).toBe(true);
    for (const issue of issues) {
      expect(issue).toHaveProperty('kind');
      expect(issue).toHaveProperty('severity');
      expect(issue).toHaveProperty('evidence');
    }
  });
});
