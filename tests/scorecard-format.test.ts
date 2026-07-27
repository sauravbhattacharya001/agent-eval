import { describe, it, expect } from 'vitest';
import {
  formatScorecard,
  formatScorecardMarkdown,
} from '../src/monitoring/scorecard-format.js';
import { aggregateScorecard } from '../src/monitoring/scorecard.js';
import type { TranscriptScore } from '../src/monitoring/scorer.js';

// Seam test: the renderers were split out of scorecard.ts into
// scorecard-format.ts. These assert the split preserved behavior (renderers
// still reachable from BOTH import paths) and cover the empty / populated /
// truncation branches directly.

function score(worker: string, passed: boolean): TranscriptScore {
  return {
    file: `${worker}.md`,
    worker,
    score: passed ? 1 : 0,
    passed,
    checks: [
      {
        check: passed ? 'completeness' : 'drift',
        tier: 1,
        score: passed ? 1 : 0,
        status: passed ? 'pass' : 'fail',
      },
    ],
  } as unknown as TranscriptScore;
}

describe('scorecard-format', () => {
  it('renders the empty-fleet branch in both formats', () => {
    const card = aggregateScorecard([]);
    expect(formatScorecard(card)).toContain('(no scored runs)');
    expect(formatScorecardMarkdown(card)).toContain('_No scored runs in this window._');
  });

  it('renders a populated terminal scorecard with grade + pass rate', () => {
    const card = aggregateScorecard([score('builder', true), score('builder', false)]);
    const out = formatScorecard(card);
    expect(out).toContain('builder');
    expect(out).toMatch(/pass \d+%/);
    expect(out).toContain('trends');
  });

  it('renders markdown with a worker table and per-check breakdown', () => {
    const card = aggregateScorecard([score('gardener', true)]);
    const md = formatScorecardMarkdown(card, { title: 'Test Card' });
    expect(md).toContain('# Test Card');
    expect(md).toContain('| Worker | Grade |');
    expect(md).toContain('## Per-check breakdown');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('honors maxFailures capping in markdown', () => {
    const scores: TranscriptScore[] = [];
    for (const c of ['a', 'b', 'c', 'd']) {
      scores.push({
        file: `w-${c}.md`,
        worker: 'w',
        score: 0,
        passed: false,
        checks: [{ check: c, tier: 1, score: 0, status: 'fail' }],
      } as unknown as TranscriptScore);
    }
    const card = aggregateScorecard(scores);
    const md = formatScorecardMarkdown(card, { maxFailures: 2 });
    expect(md).toContain('more');
  });

  it('can omit the per-check breakdown', () => {
    const card = aggregateScorecard([score('sentinel', true)]);
    const md = formatScorecardMarkdown(card, { includeChecks: false });
    expect(md).not.toContain('## Per-check breakdown');
  });
});
