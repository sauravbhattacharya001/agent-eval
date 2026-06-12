/**
 * Tests for the `verification` check - the ground-truth side-channel that
 * cross-checks a transcript's SELF-REPORTED claims against trusted run
 * metadata from the orchestrator. This is the only check that can catch a
 * transcript that is wrong about its own outcome or duration, because every
 * other check grades the same self-report.
 */

import { describe, it, expect } from 'vitest';

import { parseTranscript } from '../src/monitoring/transcript-reader.js';
import { scoreTranscript, scoreTranscripts } from '../src/monitoring/scorer.js';
import type { CheckScore } from '../src/monitoring/scorer.js';
import type { RunMetadata } from '../src/monitoring/index.js';

function transcript(opts: { outcome: string; duration?: string; filename?: string }): ReturnType<typeof parseTranscript> {
  const md = `# Builder Run - 2026-06-05 10:00 PT

## Task
Do the thing.

## Actions Taken
1. Cloned the repo
2. Made a change and pushed it

## Key Outputs
- Commit a1b2c3d: did the thing

## Outcome
${opts.outcome}

## Duration
${opts.duration ?? '10:00 PT -> 10:14 PT (14 minutes)'}
`;
  return parseTranscript(md, { filename: opts.filename ?? 'builder/2026-06-05-1000.md' });
}

function verifCheck(score: ReturnType<typeof scoreTranscript>): CheckScore {
  const c = score.checks.find((x) => x.check === 'verification');
  if (!c) throw new Error('verification check missing');
  return c;
}

describe('verification check', () => {
  it('is present and Tier 1', () => {
    const c = verifCheck(scoreTranscript(transcript({ outcome: 'pass - done' })));
    expect(c.tier).toBe(1);
  });

  describe('skip behavior (no metadata = no score impact)', () => {
    it('skips when no runMetadata is supplied', () => {
      const c = verifCheck(scoreTranscript(transcript({ outcome: 'pass - done' })));
      expect(c.status).toBe('skip');
    });

    it('does not change overall/failCount when skipped', () => {
      const withMeta = scoreTranscript(transcript({ outcome: 'pass - done' }));
      // a skipped check must be excluded from the average
      const scored = withMeta.checks.filter((c) => c.status !== 'skip');
      expect(scored.some((c) => c.check === 'verification')).toBe(false);
    });
  });

  describe('outcome mismatch (the headline signal)', () => {
    it('FAILS when transcript claims pass but the run errored', () => {
      const meta: RunMetadata = { exitStatus: 'error' };
      const c = verifCheck(scoreTranscript(transcript({ outcome: 'pass - all good' }), { runMetadata: meta }));
      expect(c.status).toBe('fail');
      expect(c.summary).toMatch(/claims "pass" but orchestrator recorded/i);
      expect(c.score).toBeLessThan(0.5);
    });

    it('FAILS when transcript claims pass but the run timed out', () => {
      const c = verifCheck(
        scoreTranscript(transcript({ outcome: 'pass' }), { runMetadata: { exitStatus: 'timeout' } }),
      );
      expect(c.status).toBe('fail');
    });

    it('FAILS when transcript claims pass but exitCode is non-zero', () => {
      const c = verifCheck(
        scoreTranscript(transcript({ outcome: 'pass' }), { runMetadata: { exitCode: 1 } }),
      );
      expect(c.status).toBe('fail');
    });

    it('PASSES when transcript pass agrees with orchestrator ok', () => {
      const c = verifCheck(
        scoreTranscript(transcript({ outcome: 'pass - done' }), { runMetadata: { exitStatus: 'ok' } }),
      );
      expect(c.status).toBe('pass');
      expect(c.score).toBe(1);
    });

    it('warns (not fail) when transcript reports fail but run succeeded', () => {
      const c = verifCheck(
        scoreTranscript(transcript({ outcome: 'fail - gave up' }), { runMetadata: { exitStatus: 'ok' } }),
      );
      expect(c.status).toBe('warn');
    });

    it('does not penalize a partial outcome against a success', () => {
      const c = verifCheck(
        scoreTranscript(transcript({ outcome: 'partial - 1 of 2' }), { runMetadata: { exitStatus: 'ok' } }),
      );
      // partial vs ok is not a hard contradiction
      expect(c.status).not.toBe('fail');
    });
  });

  describe('completion mismatch', () => {
    it('warns when the transcript is finished but the orchestrator says running', () => {
      const c = verifCheck(
        scoreTranscript(transcript({ outcome: 'pass - done' }), { runMetadata: { exitStatus: 'running' } }),
      );
      expect(c.status).toBe('warn');
      expect(c.summary).toMatch(/still running/i);
    });
  });

  describe('duration honesty', () => {
    it('warns when self-reported duration wildly disagrees with measured', () => {
      // Transcript claims 14 min; orchestrator measured ~2 min.
      const c = verifCheck(
        scoreTranscript(transcript({ outcome: 'pass - done' }), {
          runMetadata: { exitStatus: 'ok', durationMs: 2 * 60_000 },
        }),
      );
      expect(c.status).toBe('warn');
      expect(c.summary).toMatch(/disagrees with measured/i);
    });

    it('does not warn when durations roughly agree', () => {
      const c = verifCheck(
        scoreTranscript(transcript({ outcome: 'pass - done' }), {
          runMetadata: { exitStatus: 'ok', durationMs: 13 * 60_000 },
        }),
      );
      expect(c.status).toBe('pass');
    });

    it('derives measured duration from startedAt/endedAt when durationMs absent', () => {
      const c = verifCheck(
        scoreTranscript(transcript({ outcome: 'pass - done' }), {
          runMetadata: {
            exitStatus: 'ok',
            startedAt: '2026-06-05T17:00:00Z',
            endedAt: '2026-06-05T17:02:00Z', // 2 min, vs 14 claimed
          },
        }),
      );
      expect(c.status).toBe('warn');
    });
  });

  describe('metadata resolution', () => {
    it('accepts a single RunMetadata record', () => {
      const c = verifCheck(
        scoreTranscript(transcript({ outcome: 'pass' }), { runMetadata: { exitStatus: 'error' } }),
      );
      expect(c.status).toBe('fail');
    });

    it('accepts a map keyed by runId', () => {
      const meta: Record<string, RunMetadata> = {
        'builder/2026-06-05-1000': { exitStatus: 'error' },
      };
      const c = verifCheck(
        scoreTranscript(transcript({ outcome: 'pass', filename: 'builder/2026-06-05-1000.md' }), {
          runMetadata: meta,
        }),
      );
      expect(c.status).toBe('fail');
    });

    it('falls back to a worker-keyed entry', () => {
      const meta: Record<string, RunMetadata> = { builder: { exitStatus: 'error' } };
      const c = verifCheck(scoreTranscript(transcript({ outcome: 'pass' }), { runMetadata: meta }));
      expect(c.status).toBe('fail');
    });

    it('skips when the map has no entry for this run', () => {
      const meta: Record<string, RunMetadata> = { someoneElse: { exitStatus: 'error' } };
      const c = verifCheck(scoreTranscript(transcript({ outcome: 'pass' }), { runMetadata: meta }));
      expect(c.status).toBe('skip');
    });

    it('applies per-run metadata correctly in a batch', () => {
      const t1 = transcript({ outcome: 'pass', filename: 'builder/2026-06-05-1000.md' });
      const t2 = transcript({ outcome: 'pass', filename: 'gardener/2026-06-05-1100.md' });
      const meta: Record<string, RunMetadata> = {
        'builder/2026-06-05-1000': { exitStatus: 'error' },
        'gardener/2026-06-05-1100': { exitStatus: 'ok' },
      };
      const [s1, s2] = scoreTranscripts([t1, t2], { runMetadata: meta });
      expect(verifCheck(s1!).status).toBe('fail');
      expect(verifCheck(s2!).status).toBe('pass');
    });
  });
});
