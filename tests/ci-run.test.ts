/**
 * Tests for the CI Single-Run Completeness Evaluator — Phase 4 CI Integration.
 *
 * Two layers:
 *   1. The pure scoring core (scoreCiRun) — completeness + keyword-coverage
 *      verdicts against hand-built prompt/output pairs that exercise the real
 *      failure modes (empty, stub, boilerplate-ignores-prompt, partial, clean).
 *   2. evaluateCiRun end to end — that one run becomes a one-worker scorecard,
 *      the result is a valid ActionEvaluation (drops into toActionOutputs /
 *      emitActionResult), the gate behaves (clean passes, failing trips), and
 *      thresholds / gate overrides take effect.
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateCiRun,
  scoreCiRun,
} from '../src/action/ci-run.js';
import { toActionOutputs } from '../src/action/adapter.js';
import {
  createMemoryWriter,
  emitActionResult,
} from '../src/action/runner.js';

// ─── FIXTURES ──────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-06-11T00:00:00.000Z');

// A realistic PR-review prompt: the agent is asked to review a specific diff.
const REVIEW_PROMPT = `Review this pull request that adds rate limiting to the
authentication login endpoint. Check the token bucket implementation for
correctness, verify the Redis cache key expiry is set, and flag any race
conditions in the concurrent request handling.`;

// A good review: addresses the prompt's topics in structured prose.
const GOOD_REVIEW = `## Review

The rate limiting implementation looks solid overall. A few notes:

### Token bucket
The token bucket refill logic in \`limiter.ts\` is correct — it computes the
refill based on elapsed time and clamps to the bucket capacity. Good.

### Redis expiry
I confirmed the Redis cache key sets an expiry via \`EXPIRE\` after the first
write. However, consider using \`SET ... EX\` atomically to avoid a window where
a crash between \`SET\` and \`EXPIRE\` leaves a key without a TTL.

### Race conditions
There is a potential race condition in the concurrent request handling: two
requests reading the same bucket count before either writes back can both pass
the limit. Use a Lua script or \`INCR\`-based atomic check on the login endpoint
to make the read-modify-write atomic.

Otherwise the authentication changes are clean. Approving with the Redis note.`;

// The #1302 failure mode: posting a guidance file verbatim instead of a review.
const BOILERPLATE_OUTPUT = `# Contributing Guidelines

Thank you for your interest in contributing to our project! Please read these
guidelines carefully before submitting changes.

## Code Style

We use Prettier and ESLint. Run \`npm run lint\` before committing. Follow the
existing conventions in the codebase. Write clear commit messages.

## Pull Requests

Open a pull request against the main branch. Make sure all tests pass. A
maintainer will review your changes. Be patient and respectful in discussions.

## Code of Conduct

Be kind. Be welcoming. We hope this helps and you enjoy contributing here.`;

// Generic-advice failure mode: an output that is *about* software best practices
// in general, not about THIS PR. It barely overlaps the prompt's vocabulary, so
// it is off-topic even though it is well-formed, substantive prose.
const GENERIC_ADVICE = `Thank you for the contribution. Here are some general
best practices to keep in mind for any pull request:

- Always write clear, descriptive commit messages.
- Make sure your code is well documented with comments.
- Add unit tests for new functionality and keep coverage high.
- Follow the SOLID principles and keep functions small and focused.
- Be mindful of code style; run the linter and formatter before pushing.
- Review your own diff before requesting a review from others.
- Keep dependencies up to date and avoid introducing unnecessary libraries.
- Write helpful documentation so future maintainers understand the design.

Following these conventions will make the project easier to maintain for
everyone. Great teamwork makes the codebase healthier over time.`;

// The subtler failure relevance catches that coverage alone misses: the output
// name-drops the prompt's keywords once, then pads with ~80% generic filler.
// Coverage sees the keywords (partial recall); relevance sees that most of the
// content is off-topic (low precision -> drifting).
const PADDED_OUTPUT = `Thanks for the pull request on rate limiting, the token
bucket, the Redis cache key expiry, and race conditions in the login endpoint.

Now, here is some general advice for writing great software. Always remember to
keep your functions small and focused. Write clear and descriptive commit
messages so your teammates understand the history. Documentation is incredibly
important; comment your code thoroughly and keep the README up to date. Make
sure you add plenty of unit tests and integration tests to keep coverage high.
Follow the SOLID principles and favour composition over inheritance. Use a
consistent code style and run the linter and formatter before every push.
Review your own changes carefully, be kind in code review discussions, and
always be welcoming to newcomers. Keep dependencies minimal and up to date.
Great teamwork and good habits make any codebase healthier over time.`;

// ─── scoreCiRun — completeness check (Tier 1) ────────────────────────────────────

describe('scoreCiRun — completeness (Tier 1)', () => {
  it('passes a substantive, structured review', () => {
    const { checks } = scoreCiRun({ prompt: REVIEW_PROMPT, output: GOOD_REVIEW });
    const completeness = checks.find((c) => c.check === 'completeness');
    expect(completeness).toBeDefined();
    expect(completeness?.tier).toBe(1);
    expect(completeness?.status).toBe('pass');
    expect(completeness?.score).toBe(1);
  });

  it('fails an empty output', () => {
    const { checks, completeness } = scoreCiRun({ prompt: REVIEW_PROMPT, output: '   \n  ' });
    const c = checks.find((x) => x.check === 'completeness');
    expect(c?.status).toBe('fail');
    expect(c?.score).toBeLessThan(1);
    expect(completeness.violations.some((v) => v.category === 'empty')).toBe(true);
  });

  it('fails a stub / refusal output', () => {
    const { checks } = scoreCiRun({
      prompt: REVIEW_PROMPT,
      output: "I cannot review this code without more context.",
    });
    const c = checks.find((x) => x.check === 'completeness');
    expect(c?.status).toBe('fail');
    expect(c?.detail?.isStub).toBe(true);
  });

  it('grades the completeness score by violation severity (penalty)', () => {
    // Truncated output (an error-level violation) scores below a clean one.
    const truncated = 'The implementation uses a token bucket that refills based on [...]';
    const { checks } = scoreCiRun({ prompt: REVIEW_PROMPT, output: truncated });
    const c = checks.find((x) => x.check === 'completeness');
    expect(c?.score).toBeLessThan(1);
  });
});

// ─── scoreCiRun — keyword coverage (Tier 2) ──────────────────────────────────────

describe('scoreCiRun — keyword coverage (Tier 2)', () => {
  it('passes a review that covers the prompt topics', () => {
    const { checks } = scoreCiRun({ prompt: REVIEW_PROMPT, output: GOOD_REVIEW });
    const coverage = checks.find((c) => c.check === 'keyword-coverage');
    expect(coverage).toBeDefined();
    expect(coverage?.tier).toBe(2);
    expect(coverage?.status).toBe('pass');
    expect(coverage?.score).toBeGreaterThanOrEqual(0.4);
  });

  it('fails when the output ignores the prompt (boilerplate verbatim)', () => {
    const { checks, coverage } = scoreCiRun({
      prompt: REVIEW_PROMPT,
      output: BOILERPLATE_OUTPUT,
    });
    const c = checks.find((x) => x.check === 'keyword-coverage');
    // Boilerplate about "contributing" doesn't mention token bucket / Redis /
    // race conditions — coverage of the prompt's topics is very low.
    expect(c?.score).toBeLessThan(0.4);
    expect(['fail', 'warn']).toContain(c?.status);
    expect(coverage.coveredCount).toBeLessThan(coverage.totalKeywords);
  });

  it('hard-fails at/under the ignored-prompt threshold', () => {
    const { checks } = scoreCiRun({
      prompt: REVIEW_PROMPT,
      output: BOILERPLATE_OUTPUT,
      // Force the boilerplate under the ignore line regardless of exact score.
      ignoredPromptThreshold: 0.9,
      coverageThreshold: 0.95,
    });
    const c = checks.find((x) => x.check === 'keyword-coverage');
    expect(c?.status).toBe('fail');
    expect(c?.summary.toLowerCase()).toContain('ignored prompt');
  });

  it('warns on partial coverage between the two thresholds', () => {
    const { checks } = scoreCiRun({
      prompt: REVIEW_PROMPT,
      output: GOOD_REVIEW,
      // Set the pass bar above the good review's actual coverage but keep the
      // ignore line low, so it lands in the "warn" band.
      coverageThreshold: 0.99,
      ignoredPromptThreshold: 0.05,
    });
    const c = checks.find((x) => x.check === 'keyword-coverage');
    expect(c?.status).toBe('warn');
  });

  it('passes coverage when the prompt has no extractable topics', () => {
    const { checks } = scoreCiRun({ prompt: '   ', output: GOOD_REVIEW });
    const c = checks.find((x) => x.check === 'keyword-coverage');
    expect(c?.status).toBe('pass');
    expect(c?.detail?.total).toBe(0);
  });
});

// ─── scoreCiRun — relevance (Tier 2) ─────────────────────────────────────────────

describe('scoreCiRun — relevance (Tier 2)', () => {
  it('passes a review that is about the PR', () => {
    const { checks } = scoreCiRun({ prompt: REVIEW_PROMPT, output: GOOD_REVIEW });
    const relevance = checks.find((c) => c.check === 'relevance');
    expect(relevance).toBeDefined();
    expect(relevance?.tier).toBe(2);
    expect(relevance?.status).toBe('pass');
    expect(relevance?.score).toBeGreaterThanOrEqual(0.2);
    expect(relevance?.summary).toContain('on-topic');
  });

  it('fails generic advice that is not about THIS PR', () => {
    const { checks, relevance } = scoreCiRun({
      prompt: REVIEW_PROMPT,
      output: GENERIC_ADVICE,
    });
    const c = checks.find((x) => x.check === 'relevance');
    // Well-formed prose, but its vocabulary is generic best-practices, not the
    // prompt's token-bucket / Redis / race-condition topics.
    expect(c?.status).toBe('fail');
    expect(c?.summary.toLowerCase()).toContain('off-topic');
    // The off-topic terms that dominate the output are surfaced as evidence.
    expect(relevance.extraTerms.length).toBeGreaterThan(0);
  });

  it('catches padded output that coverage alone would only warn on (precision vs recall)', () => {
    const { checks } = scoreCiRun({ prompt: REVIEW_PROMPT, output: PADDED_OUTPUT });
    const relevance = checks.find((c) => c.check === 'relevance');
    const coverage = checks.find((c) => c.check === 'keyword-coverage');
    // Coverage sees the name-dropped keywords -> it is NOT a hard ignore.
    expect(coverage?.status).not.toBe('fail');
    // Relevance sees that most of the content is off-topic filler -> drifting.
    expect(relevance?.status).toBe('warn');
    expect(relevance?.summary.toLowerCase()).toContain('drifting');
    // The two checks genuinely diverge: this is the value relevance adds.
    expect(relevance?.score).toBeLessThan(coverage?.score ?? 1);
  });

  it('hard-fails at/under the off-topic threshold', () => {
    const { checks } = scoreCiRun({
      prompt: REVIEW_PROMPT,
      output: GOOD_REVIEW,
      // Force even the good review under the off-topic line regardless of score.
      offTopicThreshold: 0.99,
    });
    const c = checks.find((x) => x.check === 'relevance');
    expect(c?.status).toBe('fail');
  });

  it('warns when relevance lands between the off-topic and pass thresholds', () => {
    const { checks } = scoreCiRun({
      prompt: REVIEW_PROMPT,
      output: GOOD_REVIEW,
      // Pass bar above the good review's actual similarity, off-topic line below.
      relevanceThreshold: 0.99,
      offTopicThreshold: 0.05,
    });
    const c = checks.find((x) => x.check === 'relevance');
    expect(c?.status).toBe('warn');
  });

  it('exposes a precision proxy and term counts in detail', () => {
    const { checks } = scoreCiRun({ prompt: REVIEW_PROMPT, output: GOOD_REVIEW });
    const c = checks.find((x) => x.check === 'relevance');
    expect(typeof c?.detail?.similarity).toBe('number');
    expect(typeof c?.detail?.precision).toBe('number');
    expect(c?.detail?.precision).toBeGreaterThanOrEqual(0);
    expect(c?.detail?.precision).toBeLessThanOrEqual(1);
    expect(typeof c?.detail?.sharedTerms).toBe('number');
    expect(typeof c?.detail?.extraTerms).toBe('number');
  });

  it('treats an empty prompt as not-measurable and passes (no false off-topic)', () => {
    const { checks } = scoreCiRun({ prompt: '   ', output: GOOD_REVIEW });
    const c = checks.find((x) => x.check === 'relevance');
    expect(c?.status).toBe('pass');
    expect(c?.summary.toLowerCase()).toContain('not measurable');
  });
});

// ─── evaluateCiRun — end to end ──────────────────────────────────────────────────

describe('evaluateCiRun — end to end', () => {
  it('passes a clean run and produces a valid one-worker scorecard', () => {
    const result = evaluateCiRun({
      prompt: REVIEW_PROMPT,
      output: GOOD_REVIEW,
      worker: 'claude-review',
      now: FIXED_NOW,
    });

    expect(result.evaluation.passed).toBe(true);
    expect(result.evaluation.exitCode).toBe(0);

    // One run -> one-worker scorecard.
    const card = result.evaluation.scorecard;
    expect(card.workers).toHaveLength(1);
    expect(card.workers[0]?.worker).toBe('claude-review');
    expect(card.workers[0]?.runs).toBe(1);
    expect(card.totals.runs).toBe(1);

    // All three checks present in the verdict path.
    expect(result.checks.map((c) => c.check).sort()).toEqual([
      'completeness',
      'keyword-coverage',
      'relevance',
    ]);
  });

  it('fails a run that ignores the prompt (trips the gate)', () => {
    const result = evaluateCiRun({
      prompt: REVIEW_PROMPT,
      output: BOILERPLATE_OUTPUT,
      worker: 'claude-review',
      // Make the coverage check a hard fail so the single run's pass rate is 0.
      ignoredPromptThreshold: 0.9,
      coverageThreshold: 0.95,
      now: FIXED_NOW,
    });

    expect(result.evaluation.passed).toBe(false);
    expect(result.evaluation.exitCode).toBe(1);
    expect(result.evaluation.failingWorkers).toBe(1);
    expect(result.evaluation.evidence.length).toBeGreaterThan(0);
  });

  it('fails a run that is off-topic to the prompt (relevance trips the gate)', () => {
    // Generic best-practices advice: well-formed and non-empty (completeness
    // passes) but not about THIS PR. Relevance is the check that catches it.
    const result = evaluateCiRun({
      prompt: REVIEW_PROMPT,
      output: GENERIC_ADVICE,
      worker: 'claude-review',
      now: FIXED_NOW,
    });
    expect(result.evaluation.passed).toBe(false);
    expect(result.evaluation.exitCode).toBe(1);
    expect(result.evaluation.failingWorkers).toBe(1);
    // The relevance check is the (or a) reason — it fails on this output.
    const relevance = result.checks.find((c) => c.check === 'relevance');
    expect(relevance?.status).toBe('fail');
  });

  it('fails an empty run', () => {
    const result = evaluateCiRun({
      prompt: REVIEW_PROMPT,
      output: '',
      now: FIXED_NOW,
    });
    expect(result.evaluation.passed).toBe(false);
    expect(result.evaluation.exitCode).toBe(1);
  });

  it('defaults the worker name to ci-run', () => {
    const result = evaluateCiRun({ prompt: REVIEW_PROMPT, output: GOOD_REVIEW, now: FIXED_NOW });
    expect(result.evaluation.scorecard.workers[0]?.worker).toBe('ci-run');
  });

  it('produces an ActionEvaluation compatible with toActionOutputs', () => {
    const result = evaluateCiRun({
      prompt: REVIEW_PROMPT,
      output: GOOD_REVIEW,
      worker: 'claude-review',
      now: FIXED_NOW,
    });
    const outputs = toActionOutputs(result.evaluation);
    expect(outputs.eval_passed).toBe('true');
    expect(outputs.eval_gate).toBe('watch');
    expect(outputs.eval_evaluated_workers).toBe('1');
    // Score is a finite formatted number.
    expect(outputs.eval_score).toMatch(/^\d\.\d{4}$/);
  });

  it('drops straight into emitActionResult (outputs + summary + exit)', () => {
    const result = evaluateCiRun({
      prompt: REVIEW_PROMPT,
      output: BOILERPLATE_OUTPUT,
      worker: 'claude-review',
      ignoredPromptThreshold: 0.9,
      coverageThreshold: 0.95,
      now: FIXED_NOW,
    });
    const writer = createMemoryWriter();
    const exitCode = emitActionResult(result.evaluation, { writer, title: 'PR Review Eval' });

    expect(exitCode).toBe(1);
    // All seven outputs written.
    expect(writer.outputs.map((o) => o.name).sort()).toEqual(
      [
        'eval_evaluated_workers',
        'eval_evidence',
        'eval_failing_workers',
        'eval_gate',
        'eval_headline',
        'eval_passed',
        'eval_score',
      ].sort(),
    );
    // Summary rendered with the custom title and the scorecard table.
    expect(writer.summaries).toHaveLength(1);
    expect(writer.summaries[0]).toContain('PR Review Eval');
    expect(writer.summaries[0]).toContain('claude-review');
  });

  it('honors a gate override (relax to at-risk lets a warn-only run pass)', () => {
    // With a high pass bar but the ignore line low, coverage warns (not fails),
    // so the run's pass rate stays 100% (warns don't fail a run) and it passes
    // even at the default watch gate. Push the gate stricter to show the knob
    // is wired: an at-risk gate is more lenient, watch is the default here.
    const strict = evaluateCiRun({
      prompt: REVIEW_PROMPT,
      output: GOOD_REVIEW,
      now: FIXED_NOW,
    });
    expect(strict.evaluation.gate).toBe('watch');

    const relaxed = evaluateCiRun({
      prompt: REVIEW_PROMPT,
      output: GOOD_REVIEW,
      action: { gate: 'at-risk' },
      now: FIXED_NOW,
    });
    expect(relaxed.evaluation.gate).toBe('at-risk');
    expect(relaxed.evaluation.passed).toBe(true);
  });

  it('exposes the raw completeness, coverage, and gap analyses', () => {
    const result = evaluateCiRun({
      prompt: REVIEW_PROMPT,
      output: BOILERPLATE_OUTPUT,
      now: FIXED_NOW,
    });
    expect(result.completeness.metrics.wordCount).toBeGreaterThan(0);
    expect(result.coverage.totalKeywords).toBeGreaterThan(0);
    // The boilerplate misses the prompt's real topics -> non-trivial gaps.
    expect(result.gaps.gapCount).toBeGreaterThan(0);
    // The raw relevance analysis is exposed too (similarity + off-topic terms).
    expect(typeof result.relevance.score).toBe('number');
    expect(result.relevance.extraTerms.length).toBeGreaterThan(0);
  });

  it('is deterministic — same inputs produce the same verdict and score', () => {
    const a = evaluateCiRun({ prompt: REVIEW_PROMPT, output: GOOD_REVIEW, now: FIXED_NOW });
    const b = evaluateCiRun({ prompt: REVIEW_PROMPT, output: GOOD_REVIEW, now: FIXED_NOW });
    expect(a.evaluation.passed).toBe(b.evaluation.passed);
    expect(a.evaluation.score).toBe(b.evaluation.score);
    expect(a.checks).toEqual(b.checks);
  });
});

// ─── package-root surface ────────────────────────────────────────────────────────

describe('package root re-exports the CI run evaluator', () => {
  it('exposes evaluateCiRun and scoreCiRun from the index', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.evaluateCiRun).toBe('function');
    expect(typeof mod.scoreCiRun).toBe('function');
  });
});
