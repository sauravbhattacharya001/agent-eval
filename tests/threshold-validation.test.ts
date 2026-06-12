/**
 * Threshold validation — Phase 5 (backs the eval-layer proposal's open question
 * on default thresholds).
 *
 * The single-run gate ({@link evaluateCiRun}) ships a set of *default* thresholds
 * (>=2 actionable artifact kinds, `watch` gate). `docs/eval-layer-proposal.md`
 * level / what thresholds are right for an opt-in check" as an open question to
 * settle with maintainers — and the right way to settle it is to run the DEFAULT
 * configuration against realistic `claude-code-action` runs and confirm the gate
 * lands where a human would.
 *
 * This suite does exactly that. It drives the *full* production pipeline a
 * downstream workflow step uses —
 *
 *     extractCcaRunFromFile(<execution file>) -> evaluateCiRun({ ...defaults })
 *
 * — over execution-file fixtures (`tests/fixtures/cca-runs/*.json`, the real
 * `CcaTurn[]` shape) for the CI failure modes the surviving checks catch,
 * plus a healthy run that must NOT be flagged. No thresholds are overridden: the
 * only knob set is the `watch` gate the example/Mode-A entry point uses. The
 * assertions are on the *gate outcome* and *which check fired* (the durable
 * contract), not on exact scores (which can drift as the heuristics are tuned).
 *
 * The cases:
 *   - healthy-review        → PASS  (structured review, artifacts present)
 *   - stale-noop            → FAIL  (on-topic-looking "LGTM", staleness no-op)
 *   - abandoned-no-result   → FAIL  (#1361: no terminal result turn, abandoned)
 *
 * If a future change to the defaults or the heuristics breaks one of these, the
 * proposal's central claim ("the reported failures all sit in the deterministic
 * Tier 1+2 band, and the defaults catch them without flagging a good run") needs
 * to be re-examined — which is the whole point of pinning it in a test.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractCcaRunFromFile } from '../src/action/cca-execution.js';
import {
  evaluateCiRun,
  type CiCheckResult,
  type CiCheckStatus,
} from '../src/action/ci-run.js';
import { toActionOutputs } from '../src/action/adapter.js';

// ─── FIXTURE LOADING ─────────────────────────────────────────────────────

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cca-runs');

/** Read one execution-file fixture's raw JSON text. */
function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8');
}

// The PR-review prompt the action was given. The execution file does NOT carry
// the prompt (the action passes it via a prompt file), so the run takes it from
// here — exactly as Mode A supplies AGENT_PROMPT.
const REVIEW_PROMPT = `Review this pull request that adds rate limiting to the
authentication login endpoint. Check the token bucket implementation for
correctness, verify the Redis cache key expiry is set, and flag any race
conditions in the concurrent request handling.`;

/**
 * Run one execution-file fixture through the real pipeline with DEFAULT
 * thresholds (only the `watch` gate is set, matching the Mode-A example).
 */
function evaluateFixture(name: string) {
  const raw = loadFixture(name);
  const run = extractCcaRunFromFile(raw, { prompt: REVIEW_PROMPT });
  const result = evaluateCiRun({
    prompt: run.prompt,
    output: run.output,
    timeline: run.timeline,
    worker: 'claude-review',
    // The ONLY override — everything else is a documented default.
    action: { gate: 'watch' },
  });
  return { run, ...result };
}

/** Pull one named check out of the per-check breakdown. */
function check(checks: readonly CiCheckResult[], name: CiCheckResult['check']): CiCheckResult {
  const found = checks.find((c) => c.check === name);
  if (!found) throw new Error(`missing check: ${name}`);
  return found;
}

/** Status of a named check. */
function statusOf(checks: readonly CiCheckResult[], name: CiCheckResult['check']): CiCheckStatus {
  return check(checks, name).status;
}

// ─── STALE NO-OP — must FAIL on staleness ────────────────────────────────────

describe('threshold validation — stale no-op "LGTM" (default thresholds)', () => {
  it('an on-topic-looking bare approval with nothing actionable trips the gate', () => {
    const { evaluation, run } = evaluateFixture('stale-noop');
    expect(run.details.subtype).toBe('success');
    expect(evaluation.passed).toBe(false);
  });

  it('staleness fails as a bare-acknowledgement no-op', () => {
    const { staleness, checks } = evaluateFixture('stale-noop');
    expect(statusOf(checks, 'staleness')).toBe('fail');
    expect(staleness.isAcknowledgementOnly).toBe(true);
    expect(staleness.artifacts.count).toBe(0);
  });

  it('completeness alone would have passed it — staleness is what catches it', () => {
    // The point of the no-op detector: a short, well-formed, grammatical output
    // is "complete" by structure. Only the actionability/staleness check sees
    // that it said nothing to act on.
    const { checks } = evaluateFixture('stale-noop');
    expect(statusOf(checks, 'completeness')).toBe('pass');
  });
});

// ─── #1361 — ABANDONED (no result turn) — must FAIL on staleness ─────────────

describe('threshold validation — #1361 abandoned run, no result turn (default thresholds)', () => {
  it('a run that never emitted a terminal result turn trips the gate', () => {
    const { evaluation, run } = evaluateFixture('abandoned-no-result');
    // No `result` turn → output falls back to assistant text, and the timeline
    // has no `end` event (the abandonment signal).
    expect(run.outputSource).toBe('assistant-text');
    expect(run.timeline.endedAt).toBeUndefined();
    expect(evaluation.passed).toBe(false);
  });

  it('staleness fails: the mid-task narration carries no actionable artifacts', () => {
    const { checks, staleness } = evaluateFixture('abandoned-no-result');
    expect(statusOf(checks, 'staleness')).toBe('fail');
    // "I'll start by reading… let me grep…" is prose with no file refs/line
    // numbers/code/directives a human can act on.
    expect(staleness.artifacts.count).toBe(0);
  });
});

// ─── CROSS-CASE SUMMARY — the gate separates good from bad on defaults ───────

describe('threshold validation — defaults separate good from bad', () => {
  const FAILING = ['stale-noop', 'abandoned-no-result'] as const;

  it('the healthy run is the only one that passes', () => {
    expect(evaluateFixture('healthy-review').evaluation.passed).toBe(true);
    for (const name of FAILING) {
      expect(evaluateFixture(name).evaluation.passed, `${name} should fail`).toBe(false);
    }
  });

  it('every failing run produces a non-empty evidence string', () => {
    for (const name of FAILING) {
      const { evaluation } = evaluateFixture(name);
      const outputs = toActionOutputs(evaluation);
      expect(outputs.eval_evidence.length, `${name} evidence`).toBeGreaterThan(0);
    }
  });

  it('every failing run is failed by at least one Tier 1/Tier 2 check (no model-as-judge)', () => {
    for (const name of FAILING) {
      const { checks } = evaluateFixture(name);
      const failing = checks.filter((c) => c.status === 'fail');
      expect(failing.length, `${name} failing checks`).toBeGreaterThan(0);
      // Every check in the gate is Tier 1 or Tier 2 — deterministic by design.
      for (const c of checks) expect(c.tier === 1 || c.tier === 2).toBe(true);
    }
  });
});
