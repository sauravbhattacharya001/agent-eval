/**
 * Tests for the CI single-run evaluator's extracted scoring seams.
 *
 * `ci-run.ts` was split into three focused sibling modules with no behavior
 * change: shared types + `round4` (`ci-run-types.ts`), the Tier 1 no-op
 * detection (`ci-run-staleness.ts`), and the Tier 2 task-grounding
 * (`ci-run-relevance.ts`). The public entry points (`analyzeActionability`,
 * `analyzeCiStaleness`, `analyzeTaskGrounding`) are re-exported from `ci-run.ts`
 * and are already covered end-to-end by `ci-run.test.ts` via the public surface.
 *
 * This file pins the pieces that move to those new homes and were previously
 * only exercised *transitively* through `scoreCiRun` / `evaluateCiRun`:
 *   1. The split preserved identity - `ci-run.ts` re-exports the SAME function
 *      references the sibling modules define (so consumers and the barrel are
 *      unaffected by where the code now lives).
 *   2. The internal scoring functions (`scoreStaleness`, `scoreRelevance`) graded
 *      directly against hand-built analyses, covering verdict precedence and the
 *      graded-score math the orchestration suite only reached indirectly.
 *   3. The shared `round4` helper and the `ACTIONABLE_ARTIFACT_KIND_COUNT`
 *      constant the staleness richness score is normalized by.
 */

import { describe, expect, it } from 'vitest';

import * as ciRun from '../src/action/ci-run.js';
import {
  analyzeActionability,
  analyzeCiStaleness,
  scoreStaleness,
  ACTIONABLE_ARTIFACT_KIND_COUNT,
} from '../src/action/ci-run-staleness.js';
import { analyzeTaskGrounding, scoreRelevance } from '../src/action/ci-run-relevance.js';
import { round4 } from '../src/action/ci-run-types.js';
import type {
  StalenessAnalysis,
  TaskGroundingResult,
} from '../src/action/ci-run-types.js';
import type { StalenessIssue, StalenessResult } from '../src/checks/staleness.js';

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** A staleness analysis with no no-op signals; override fields per test. */
function staleness(partial: Partial<StalenessAnalysis> = {}): StalenessAnalysis {
  return {
    artifacts: { kinds: [], labels: [], count: 0 },
    isAcknowledgementOnly: false,
    abandonment: [],
    isRepost: false,
    repostSimilarity: Number.NaN,
    ...partial,
  };
}

/** A grounding result that is not too thin; override fields per test. */
function grounding(partial: Partial<TaskGroundingResult> = {}): TaskGroundingResult {
  return {
    promptCoverage: 0.5,
    jaccard: 0.3,
    promptTerms: ['redis', 'expiry', 'token', 'bucket'],
    matchedTerms: ['redis', 'expiry'],
    missingTerms: ['token', 'bucket'],
    promptTooThin: false,
    ...partial,
  };
}

function issue(kind: StalenessIssue['kind'], severity: StalenessIssue['severity'], message: string): StalenessIssue {
  return { kind, severity, message };
}

/** A complete timeline staleness result; override fields per test. */
function timelineResult(partial: Partial<StalenessResult> = {}): StalenessResult {
  return {
    isStale: false,
    issues: [],
    durationMs: 1000,
    longestGapMs: Number.NaN,
    outputEventCount: 1,
    hasEndEvent: true,
    summary: 'ok',
    ...partial,
  };
}

// ─── 1. Split preserved identity ──────────────────────────────────────────────────

describe('ci-run re-exports the same references the seams define', () => {
  it('staleness entry points resolve to the sibling-module functions', () => {
    expect(ciRun.analyzeActionability).toBe(analyzeActionability);
    expect(ciRun.analyzeCiStaleness).toBe(analyzeCiStaleness);
  });

  it('relevance entry point resolves to the sibling-module function', () => {
    expect(ciRun.analyzeTaskGrounding).toBe(analyzeTaskGrounding);
  });
});

// ─── 2a. scoreStaleness - direct verdict + score coverage ──────────────────────────

describe('scoreStaleness - direct grading', () => {
  it('passes a rich, artifact-laden output and scores it high', () => {
    const a = staleness({ artifacts: { kinds: ['file-ref', 'directive', 'finding'], labels: ['file reference', 'actionable directive', 'structured finding'], count: 3 } });
    const r = scoreStaleness(a, 'a'.repeat(400), 2, 80);
    expect(r.status).toBe('pass');
    expect(r.check).toBe('staleness');
    expect(r.tier).toBe(1);
    expect(r.score).toBeGreaterThan(0.3);
    expect(r.summary).toMatch(/actionable: 3 artifact kind/);
  });

  it('hard-fails a non-trivial output with zero artifacts (a no-op)', () => {
    const r = scoreStaleness(staleness(), 'x'.repeat(300), 2, 80);
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/^no-op:/);
    expect(r.summary).toMatch(/no actionable content/);
  });

  it('only warns when a trivially short output has zero artifacts', () => {
    const r = scoreStaleness(staleness(), 'short', 2, 80);
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/very short/);
  });

  it('warns when artifacts are present but below the minimum threshold', () => {
    const a = staleness({ artifacts: { kinds: ['file-ref'], labels: ['file reference'], count: 1 } });
    const r = scoreStaleness(a, 'see src/auth/login.ts for the change here', 2, 80);
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/thin: only 1 actionable artifact kind/);
  });

  it('fails on a verbatim repost and applies the extra repost penalty', () => {
    const rich = { kinds: ['file-ref', 'directive', 'finding'], labels: ['a', 'b', 'c'], count: 3 };
    const baseline = scoreStaleness(staleness({ artifacts: rich }), 'x'.repeat(300), 2, 80);
    const reposted = scoreStaleness(
      staleness({ artifacts: rich, isRepost: true, repostSimilarity: 0.97 }),
      'x'.repeat(300),
      2,
      80,
    );
    expect(reposted.status).toBe('fail');
    expect(reposted.summary).toMatch(/reposts prior comment verbatim \(97% identical\)/);
    // Same artifacts, but the repost path adds a 0.4 penalty on top of the fail penalty.
    expect(reposted.score).toBeLessThan(baseline.score);
    expect(reposted.detail?.repost).toBe(true);
    expect(reposted.detail?.repostSimilarity).toBe(0.97);
  });

  it('fails on a bare-acknowledgement-only output', () => {
    const r = scoreStaleness(staleness({ isAcknowledgementOnly: true, acknowledgement: 'bare approval' }), 'LGTM', 2, 80);
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/bare acknowledgement only \(bare approval\)/);
    expect(r.detail?.ackOnly).toBe(true);
  });

  it('fails when the timeline reports a hard error (timeout / no output)', () => {
    const a = staleness({
      timeline: timelineResult({ isStale: true, issues: [issue('timeout', 'error', 'ran past the 2h limit')], durationMs: 7_200_000 }),
    });
    const r = scoreStaleness(a, 'x'.repeat(300), 2, 80);
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/run timeout/);
    expect(r.detail?.timelineErrors).toBe(1);
  });

  it('warns (not fails) on a non-fatal timeline gap', () => {
    const a = staleness({
      artifacts: { kinds: ['file-ref', 'directive'], labels: ['a', 'b'], count: 2 },
      timeline: timelineResult({ issues: [issue('stale_gap', 'warning', 'large gap between events')] }),
    });
    const r = scoreStaleness(a, 'see src/x.ts and you should fix it', 2, 80);
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/timeline: stale_gap/);
    expect(r.detail?.timelineWarnings).toBe(1);
  });

  it('fails on an error-severity abandonment signal (truncated mid-code)', () => {
    const a = staleness({ abandonment: [issue('abandoned', 'error', 'unbalanced code fence')] });
    const r = scoreStaleness(a, 'x'.repeat(300), 2, 80);
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/unbalanced code fence/);
    expect(r.detail?.abandonErrors).toBe(1);
  });

  it('warns on a dangling-intent (no_progress) abandonment signal', () => {
    const a = staleness({
      artifacts: { kinds: ['file-ref', 'directive'], labels: ['a', 'b'], count: 2 },
      abandonment: [issue('no_progress', 'warning', 'stated intent without follow-through')],
    });
    const r = scoreStaleness(a, 'see src/x.ts; you should next look into', 2, 80);
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/stated intent without follow-through/);
  });

  it('records "n/a" repost similarity when no previous output was compared', () => {
    const r = scoreStaleness(staleness({ artifacts: { kinds: ['file-ref', 'directive'], labels: ['a', 'b'], count: 2 } }), 'see src/x.ts and rename it', 2, 80);
    expect(r.detail?.repostSimilarity).toBe('n/a');
  });
});

// ─── 2b. scoreRelevance - direct verdict + score coverage ──────────────────────────

describe('scoreRelevance - direct grading', () => {
  it('skips when the prompt is too thin to ground against', () => {
    const r = scoreRelevance(grounding({ promptTooThin: true, promptCoverage: Number.NaN, jaccard: Number.NaN }), 'anything', 0.25, 200);
    expect(r.status).toBe('skip');
    expect(r.score).toBeNaN();
    expect(r.summary).toMatch(/prompt too thin/);
    expect(r.detail?.skipped).toBe(true);
  });

  it('skips when coverage is non-finite even if promptTooThin is false', () => {
    const r = scoreRelevance(grounding({ promptCoverage: Number.NaN }), 'anything', 0.25, 200);
    expect(r.status).toBe('skip');
  });

  it('passes a well-grounded output and reports the coverage percentage', () => {
    const r = scoreRelevance(grounding({ promptCoverage: 0.75, matchedTerms: ['redis', 'expiry', 'token'] }), 'x'.repeat(400), 0.25, 200);
    expect(r.status).toBe('pass');
    expect(r.score).toBe(0.75);
    expect(r.summary).toMatch(/on-task: covers 75% of the prompt's topics/);
    expect(r.detail?.substantive).toBe(true);
  });

  it('hard-fails a substantive output that ignores the task (low coverage, long)', () => {
    const r = scoreRelevance(grounding({ promptCoverage: 0.1, matchedTerms: ['redis'], missingTerms: ['expiry', 'token', 'bucket'] }), 'x'.repeat(400), 0.25, 200);
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/off-task: only 10% of the prompt's topics addressed/);
    expect(r.summary).toMatch(/ignores expiry, token, bucket/);
  });

  it('only warns (not fails) when low coverage comes from a short output', () => {
    const r = scoreRelevance(grounding({ promptCoverage: 0.1, matchedTerms: ['redis'] }), 'too short to hard-fail', 0.25, 200);
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/weak grounding: short output/);
    expect(r.detail?.substantive).toBe(false);
  });

  it('treats coverage exactly at the threshold as grounded (pass)', () => {
    const r = scoreRelevance(grounding({ promptCoverage: 0.25 }), 'x'.repeat(400), 0.25, 200);
    expect(r.status).toBe('pass');
  });

  it('reports jaccard as "n/a" in detail when it is non-finite', () => {
    const r = scoreRelevance(grounding({ promptCoverage: 0.5, jaccard: Number.NaN }), 'x'.repeat(400), 0.25, 200);
    expect(r.detail?.jaccard).toBe('n/a');
  });

  it('clamps the reported score into [0,1]', () => {
    const high = scoreRelevance(grounding({ promptCoverage: 1 }), 'x'.repeat(400), 0.25, 200);
    expect(high.score).toBe(1);
  });
});

// ─── 3. Shared helpers / constants ─────────────────────────────────────────────────

describe('ci-run shared helpers', () => {
  it('round4 rounds finite numbers to four decimals', () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(1)).toBe(1);
    expect(round4(2 / 3)).toBe(0.6667);
  });

  it('round4 passes non-finite values through unchanged', () => {
    expect(round4(Number.NaN)).toBeNaN();
    expect(round4(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('ACTIONABLE_ARTIFACT_KIND_COUNT matches the number of detectable kinds', () => {
    // The richness score divides the artifact count by this total, so it must
    // equal the count of distinct kinds the scanner can actually report.
    expect(ACTIONABLE_ARTIFACT_KIND_COUNT).toBeGreaterThan(0);
    const everyKind = analyzeActionability(
      [
        'see src/auth/login.ts',           // file-ref
        'on line 42',                       // line-ref
        '```ts\nconst x = 1;\n```',         // code-block
        'use `INCR` here',                  // inline-code
        '@@ -1,2 +1,3 @@',                   // diff
        'you should refactor this',         // directive
        '- Issue: the cache key is wrong',  // finding
      ].join('\n'),
    );
    expect(everyKind.count).toBe(ACTIONABLE_ARTIFACT_KIND_COUNT);
  });
});
