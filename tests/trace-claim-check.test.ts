/**
 * Tests for claim↔proof cross-check (Section F, slice 3) — falsifying model
 * claims against PROOF for harness×model selection.
 *
 * These tests pin the HARD GUARDRAIL that keeps slice 3 a Tier 1+2 pillar:
 *   1. A claim's verdict is decided ONLY by the harness's PROOF tool result
 *      (`is_error`/`exit_code`/result text) — NEVER by the model's own words.
 *      Rewriting narration cannot flip a verdict; flipping the harness result
 *      (is_error) is the only thing that moves it.
 *   2. A claim with no Tier-1/2 anchor is `unverifiable` → EXCLUDED from the
 *      integrity score and surfaced as an instrumentation gap. It is NEVER a
 *      silent pass and NEVER escalated to a Tier-3 judgement.
 *   3. The integrity ratio is computed over DECIDED (verified+contradicted)
 *      claims only; `unverifiable` never counts toward it.
 *   4. `crossCheckClaims` is pure + read-only: it never mutates its input.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  crossCheckClaims,
  toHaveNoContradictedClaims,
  toHaveClaimIntegrityAtLeast,
  toHaveInstrumentationGapsAtMost,
} from '../src/checks/trace-claim-check.js';
import { ingestTrace, type TraceSession } from '../src/monitoring/trace-provenance.js';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'agent-trace-sessions',
);

function loadSession(name: string): TraceSession {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf-8')) as TraceSession;
}

// ─── Intra-event tool invocations (the model chose tool X → PROOF result) ───────

describe('crossCheckClaims — intra-event tool invocations', () => {
  it('verifies each chosen tool against its own PROOF result (clean run)', () => {
    const result = crossCheckClaims(loadSession('sentinel-push'));
    const invocations = result.claims.filter((c) => c.source === 'tool_invocation');
    // sentinel-push has 2 tool calls (run_command, git_push), both non-errored.
    expect(invocations).toHaveLength(2);
    expect(invocations.map((c) => c.predicate)).toEqual(['tool:run_command', 'tool:git_push']);
    expect(invocations.every((c) => c.verdict === 'verified')).toBe(true);
    // Each verdict is anchored to the PROOF event it came from.
    expect(invocations.map((c) => c.proofEventIndex)).toEqual([2, 3]);
  });

  it('contradicts a chosen tool when its harness result errored', () => {
    const result = crossCheckClaims(loadSession('build-retry-recover'));
    const invocations = result.claims.filter((c) => c.source === 'tool_invocation');
    // 5 tool calls: build(err), build(err), edit(ok), build(ok), push(ok).
    expect(invocations).toHaveLength(5);
    expect(invocations.map((c) => c.verdict)).toEqual([
      'contradicted', // build #1 errored
      'contradicted', // build #2 errored
      'verified', // edit ok
      'verified', // build #3 ok
      'verified', // push ok
    ]);
    // The contradictions cite the PROOF event that errored, not the model's text.
    const firstContradiction = invocations.find((c) => c.verdict === 'contradicted');
    expect(firstContradiction?.reason).toContain('harness error');
  });
});

// ─── Cross-event narration / reasoning (structured, falsifiable claims) ─────────

describe('crossCheckClaims — cross-event structured claims', () => {
  it('verifies a "pushed" narration claim against a non-errored push tool result', () => {
    const result = crossCheckClaims(loadSession('sentinel-push'));
    // Final llm narration: "...so I pushed the commit to main. Done." → push predicate.
    const pushClaim = result.claims.find(
      (c) => c.source === 'narration' && c.predicate === 'push',
    );
    expect(pushClaim).toBeDefined();
    expect(pushClaim?.verdict).toBe('verified');
    // Anchored to the git_push PROOF (event 3), never to the narration text.
    expect(pushClaim?.proofEventIndex).toBe(3);
    expect(pushClaim?.reason).toContain('PROOF');
  });

  it('verifies a "score was green" claim only via the harness PASS output', () => {
    const result = crossCheckClaims(loadSession('sentinel-push'));
    // "Score was 0.94 (green) so I pushed..." → score:green, anchored to the
    // run_command whose harness stdout is "score=0.94 PASS".
    const scoreClaim = result.claims.find((c) => c.predicate === 'score:green');
    expect(scoreClaim).toBeDefined();
    expect(scoreClaim?.verdict).toBe('verified');
    expect(scoreClaim?.proofEventIndex).toBe(2); // the run_command event
  });

  it('verifies a "rebuilt green / pushed" reasoning+narration claim after recovery', () => {
    const result = crossCheckClaims(loadSession('build-retry-recover'));
    // The FINAL narration "Fixed the type error, rebuilt green, and pushed."
    // asserts two falsifiable actions; both have non-errored PROOF results, so
    // both are verified and anchored to those harness results.
    const closing = result.claims.filter((c) => c.source === 'narration' && c.eventIndex === 6);
    const predicates = new Set(closing.map((c) => c.predicate));
    expect(predicates.has('build:pass')).toBe(true);
    expect(predicates.has('push')).toBe(true);
    expect(closing.every((c) => c.verdict === 'verified')).toBe(true);
    // The build:pass claim is anchored to the GREEN build (event 4), not to the
    // earlier errored builds — a verified PROOF result wins.
    expect(closing.find((c) => c.predicate === 'build:pass')?.proofEventIndex).toBe(4);
    // The opening plan "I'll run the build first." asserts no COMPLETED action
    // (future-tense intent) → correctly unverifiable, never a face-value pass.
    const opening = result.claims.find((c) => c.source === 'narration' && c.eventIndex === 0);
    expect(opening?.verdict).toBe('unverifiable');
  });
});

// ─── The headline guardrail: claims are never evidence; PROOF decides ───────────

describe('crossCheckClaims — PROOF decides, claims never do', () => {
  it('CONTRADICTS a triumphant narration when the harness PROOF errored', () => {
    // The model claims success; the build tool actually errored. The claim is the
    // hypothesis and PROOF refutes it — no amount of confident phrasing passes.
    const session: TraceSession = {
      session_id: 's',
      events: [
        {
          event_type: 'tool_call',
          tool_call: {
            tool_name: 'run_build',
            tool_input: { command: 'npm run build' },
            tool_output: { is_error: true, exit_code: 1, stderr: 'TS2345' },
          },
        },
        {
          event_type: 'llm_call',
          output_data: { text: 'The build passed cleanly and everything is green.' },
        },
      ],
    };
    const result = crossCheckClaims(session);
    const buildClaim = result.claims.find((c) => c.predicate === 'build:pass');
    expect(buildClaim?.verdict).toBe('contradicted');
    // The intra-event tool invocation is ALSO contradicted (the call errored).
    expect(result.contradicted).toBeGreaterThanOrEqual(2);
    expect(result.integrity).toBe(0); // nothing verified, all decided claims refuted
  });

  it('does not let renaming a tool or rephrasing narration manufacture a pass', () => {
    // Same harness PROOF (is_error: true) regardless of a friendly tool name and
    // a glowing narration. The verdict tracks PROOF, not the model's words.
    const friendly: TraceSession = {
      events: [
        {
          event_type: 'tool_call',
          tool_call: { tool_name: 'definitely_works_push', tool_output: { is_error: true } },
        },
        { event_type: 'llm_call', output_data: { text: 'Pushed successfully, all done!' } },
      ],
    };
    const result = crossCheckClaims(friendly);
    // The chosen tool errored → its invocation is contradicted.
    const invocation = result.claims.find((c) => c.source === 'tool_invocation');
    expect(invocation?.verdict).toBe('contradicted');
    // The "pushed" narration is anchored to the SAME push tool, which errored →
    // contradicted. The cheerful adverb changes nothing.
    const pushClaim = result.claims.find(
      (c) => c.source === 'narration' && c.predicate === 'push',
    );
    expect(pushClaim?.verdict).toBe('contradicted');
  });
});

// ─── unverifiable: excluded from score, logged as instrumentation gap ───────────

describe('crossCheckClaims — unverifiable is excluded, never a pass', () => {
  it('marks free narrative with no falsifiable predicate as unverifiable', () => {
    const session: TraceSession = {
      events: [
        {
          event_type: 'llm_call',
          output_data: { text: 'I thought carefully about the architecture and felt good about it.' },
        },
      ],
    };
    const result = crossCheckClaims(session);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].verdict).toBe('unverifiable');
    expect(result.claims[0].predicate).toBe('narrative');
    // Excluded from scoring entirely.
    expect(result.decided).toBe(0);
    expect(result.integrity).toBeNull();
    expect(result.unverifiable).toBe(1);
    expect(result.instrumentationGaps).toHaveLength(1);
  });

  it('marks a structured claim with NO matching harness tool as unverifiable (gap)', () => {
    // The model says it pushed, but no push tool ever ran → nothing to falsify
    // against. This is an instrumentation gap, NOT a pass and NOT a Tier-3 grade.
    const session: TraceSession = {
      events: [
        { event_type: 'llm_call', output_data: { text: 'I pushed the commit to main.' } },
      ],
    };
    const result = crossCheckClaims(session);
    const pushClaim = result.claims.find((c) => c.predicate === 'push');
    expect(pushClaim?.verdict).toBe('unverifiable');
    expect(pushClaim?.reason).toContain('instrumentation gap');
    expect(result.decided).toBe(0);
    expect(result.integrity).toBeNull();
  });

  it('marks a chosen tool with no harness result as unverifiable', () => {
    const session: TraceSession = {
      events: [
        // tool_call event but the harness emitted no tool_output at all.
        { event_type: 'tool_call', tool_call: { tool_name: 'mystery_tool', tool_input: { a: 1 } } },
      ],
    };
    const result = crossCheckClaims(session);
    const invocation = result.claims.find((c) => c.source === 'tool_invocation');
    expect(invocation?.verdict).toBe('unverifiable');
    expect(result.decided).toBe(0);
  });

  it('integrity counts only decided claims (unverifiable excluded by construction)', () => {
    // 1 verified push + 1 unverifiable narrative → integrity = 1/1, not 1/2.
    const session: TraceSession = {
      events: [
        {
          event_type: 'tool_call',
          tool_call: { tool_name: 'git_push', tool_output: { is_error: false, stdout: 'pushed' } },
        },
        { event_type: 'llm_call', output_data: { text: 'Pushed. Also, I felt confident.' } },
        { event_type: 'llm_call', output_data: { text: 'A purely reflective musing with no action.' } },
      ],
    };
    const result = crossCheckClaims(session);
    expect(result.verified).toBeGreaterThanOrEqual(1);
    expect(result.unverifiable).toBeGreaterThanOrEqual(1);
    // Decided excludes the reflective musing; integrity is over decided only.
    expect(result.decided).toBe(result.verified + result.contradicted);
    expect(result.integrity).toBe(result.verified / result.decided);
  });

  it('treats future-tense intent (a plan, not a completion) as unverifiable', () => {
    // "I'll push once the build is green" asserts an INTENTION, not a completed
    // action with a PROOF anchor. It must not be read as a claim that something
    // happened — unverifiable, logged as a gap, never a face-value pass.
    const session: TraceSession = {
      events: [
        { event_type: 'llm_call', output_data: { text: "I'll run the build first, then push." } },
      ],
    };
    const result = crossCheckClaims(session);
    // "push" is matched as a candidate predicate, but no push tool ran yet →
    // there is nothing to falsify against → unverifiable (instrumentation gap).
    expect(result.claims.every((c) => c.verdict === 'unverifiable')).toBe(true);
    expect(result.decided).toBe(0);
    expect(result.integrity).toBeNull();
  });

  it('can drop unverifiable claims entirely when reportUnverifiable is false', () => {
    const session: TraceSession = {
      events: [
        { event_type: 'llm_call', output_data: { text: 'Just some idle reflection here.' } },
      ],
    };
    const kept = crossCheckClaims(session, { reportUnverifiable: true });
    const dropped = crossCheckClaims(session, { reportUnverifiable: false });
    expect(kept.claims).toHaveLength(1);
    expect(dropped.claims).toHaveLength(0);
    // Either way the score is unaffected — unverifiable never counted.
    expect(kept.integrity).toBeNull();
    expect(dropped.integrity).toBeNull();
  });
});

// ─── Purity / adapter parity ────────────────────────────────────────────────────

describe('crossCheckClaims — purity and adapter parity', () => {
  it('does NOT mutate the input session (read-only toward trace data)', () => {
    const session = loadSession('build-retry-recover');
    const before = JSON.stringify(session);
    crossCheckClaims(session);
    expect(JSON.stringify(session)).toBe(before);
  });

  it('accepts an already-ingested TraceProvenance and gives identical verdicts', () => {
    const tp = ingestTrace(loadSession('sentinel-push'));
    const fromProvenance = crossCheckClaims(tp);
    const fromSession = crossCheckClaims(loadSession('sentinel-push'));
    expect(fromProvenance.verified).toBe(fromSession.verified);
    expect(fromProvenance.contradicted).toBe(fromSession.contradicted);
    expect(fromProvenance.unverifiable).toBe(fromSession.unverifiable);
    expect(fromProvenance.integrity).toBe(fromSession.integrity);
  });

  it('handles an empty session (no claims, null integrity)', () => {
    const result = crossCheckClaims({ events: [] });
    expect(result.claims).toEqual([]);
    expect(result.decided).toBe(0);
    expect(result.integrity).toBeNull();
    expect(result.summary).toContain('no falsifiable claims');
  });
});

// ─── Proof-anchored predicates ──────────────────────────────────────────────────

describe('claim-check predicates give a stable mechanical verdict', () => {
  it('toHaveNoContradictedClaims tracks PROOF contradictions', () => {
    expect(toHaveNoContradictedClaims(crossCheckClaims(loadSession('sentinel-push')))).toBe(true);
    // build-retry-recover has two errored builds → contradicted invocations.
    expect(toHaveNoContradictedClaims(crossCheckClaims(loadSession('build-retry-recover')))).toBe(
      false,
    );
  });

  it('toHaveClaimIntegrityAtLeast returns false when nothing is decidable', () => {
    const reflective = crossCheckClaims({
      events: [{ event_type: 'llm_call', output_data: { text: 'Idle musing, no action.' } }],
    });
    // integrity is null → no evidence of integrity → not a pass.
    expect(toHaveClaimIntegrityAtLeast(reflective, 0.5)).toBe(false);
    // A clean run clears a high bar.
    expect(toHaveClaimIntegrityAtLeast(crossCheckClaims(loadSession('sentinel-push')), 1)).toBe(
      true,
    );
  });

  it('toHaveInstrumentationGapsAtMost enforces a gap budget', () => {
    const gappy = crossCheckClaims({
      events: [
        { event_type: 'llm_call', output_data: { text: 'I pushed it.' } }, // no push tool → gap
        { event_type: 'llm_call', output_data: { text: 'Pure reflection.' } }, // narrative → gap
      ],
    });
    expect(gappy.unverifiable).toBe(2);
    expect(toHaveInstrumentationGapsAtMost(gappy, 2)).toBe(true);
    expect(toHaveInstrumentationGapsAtMost(gappy, 1)).toBe(false);
  });
});

// ─── PROOF-anchoring seams: text signature + exit_code (the unforgeable core) ────
//
// These pin two falsification paths that the fixtures exercise only on their
// *verified* side, so a regression on the *contradicted* side (or on the error
// signal itself) would otherwise pass silently:
//   • anchoring a generic shell tool to a predicate by its HARNESS result text
//     (`proofSignatureKeywords`, e.g. `score=`), NOT by tool name — and letting
//     that text-anchored PROOF *refute* the claim when it errored;
//   • `exit_code` (a non-zero number) acting as the error verdict on its own,
//     with no `is_error` field — and `exit_code: 0` correctly meaning success.

describe('crossCheckClaims — text-signature anchoring decides via PROOF, not the name', () => {
  it('CONTRADICTS "score green" when a generic tool with `score=` output errored', () => {
    // The claim is anchored to a shell `run_command` (no "score" in its NAME)
    // purely because the HARNESS wrote `score=` into its result text. That same
    // PROOF errored, so the glowing claim is refuted — the text anchor reaches
    // the contradiction branch, and the verdict still tracks PROOF only.
    const session: TraceSession = {
      events: [
        {
          event_type: 'tool_call',
          tool_call: {
            tool_name: 'run_command',
            tool_input: { command: './gate.sh' },
            tool_output: { is_error: true, stdout: 'score=0.41 FAIL', exit_code: 1 },
          },
        },
        {
          event_type: 'llm_call',
          output_data: { text: 'The score was great and the gate is green, so we are good.' },
        },
      ],
    };
    const result = crossCheckClaims(session);
    const scoreClaim = result.claims.find((c) => c.predicate === 'score:green');
    expect(scoreClaim).toBeDefined();
    // Refuted, and anchored to the generic tool's event (matched by text, not name).
    expect(scoreClaim?.verdict).toBe('contradicted');
    expect(scoreClaim?.proofEventIndex).toBe(0);
    expect(scoreClaim?.reason).toContain('PROOF');
  });

  it('prefers a clean text-anchored PROOF over an earlier errored one (verified)', () => {
    // Two generic shell results both carry `score=` (so both anchor the
    // score:green predicate by TEXT): the first errored, the second is clean.
    // `falsifyAgainstProof` must pick the non-errored anchor → verified, and
    // cite the clean event — a verified PROOF result wins over an earlier error.
    const session: TraceSession = {
      events: [
        {
          event_type: 'tool_call',
          tool_call: {
            tool_name: 'run_command',
            tool_output: { is_error: true, stdout: 'score=0.40 FAIL', exit_code: 1 },
          },
        },
        {
          event_type: 'tool_call',
          tool_call: {
            tool_name: 'run_command',
            tool_output: { is_error: false, stdout: 'score=0.92 PASS' },
          },
        },
        {
          event_type: 'llm_call',
          output_data: { text: 'After the fix the score was 0.92 and the gate is green.' },
        },
      ],
    };
    const result = crossCheckClaims(session);
    const scoreClaim = result.claims.find((c) => c.predicate === 'score:green');
    expect(scoreClaim?.verdict).toBe('verified');
    expect(scoreClaim?.proofEventIndex).toBe(1); // the clean run, not the errored event 0
  });
});

describe('crossCheckClaims — exit_code is an unforgeable error signal on its own', () => {
  it('CONTRADICTS a chosen tool on a non-zero exit_code with NO is_error field', () => {
    // No `is_error` key at all — the only failure signal is `exit_code: 2`. The
    // invocation must still be contradicted (the harness exit code is PROOF the
    // model cannot author).
    const session: TraceSession = {
      events: [
        {
          event_type: 'tool_call',
          tool_call: { tool_name: 'run_tests', tool_output: { exit_code: 2, stdout: '2 failing' } },
        },
        { event_type: 'llm_call', output_data: { text: 'All tests pass now.' } },
      ],
    };
    const result = crossCheckClaims(session);
    const invocation = result.claims.find((c) => c.source === 'tool_invocation');
    expect(invocation?.verdict).toBe('contradicted');
    // The "tests pass" narration is anchored to the same errored tool by name → refuted.
    const testsClaim = result.claims.find((c) => c.predicate === 'tests:pass');
    expect(testsClaim?.verdict).toBe('contradicted');
    expect(result.integrity).toBe(0);
  });

  it('treats exit_code: 0 (with no is_error) as a clean PROOF result', () => {
    // The boundary the other direction: a finished command that exited 0 is a
    // success. Guards against a regression that truthiness-checks exit_code
    // instead of comparing `!== 0`.
    const session: TraceSession = {
      events: [
        {
          event_type: 'tool_call',
          tool_call: { tool_name: 'run_tests', tool_output: { exit_code: 0, stdout: 'ok' } },
        },
        { event_type: 'llm_call', output_data: { text: 'The tests passed.' } },
      ],
    };
    const result = crossCheckClaims(session);
    expect(result.claims.find((c) => c.source === 'tool_invocation')?.verdict).toBe('verified');
    expect(result.claims.find((c) => c.predicate === 'tests:pass')?.verdict).toBe('verified');
    expect(result.contradicted).toBe(0);
    expect(result.integrity).toBe(1);
  });
});
