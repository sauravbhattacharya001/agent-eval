/**
 * Unit tests for the extracted claim↔proof internal seams (Section F, slice 3).
 *
 * `trace-claim-check.ts` was split along its internal seams into:
 *   - `trace-claim-check-proof.ts`       — PROOF readers + PROOF index
 *   - `trace-claim-check-predicates.ts`  — structured predicate matcher + falsifier
 *
 * These tests pin those internal helpers directly (the higher-level
 * `crossCheckClaims` behaviour is covered by `trace-claim-check.test.ts`), so
 * the seams are locked and a future refactor cannot silently change what counts
 * as PROOF or which predicate a claim proposes.
 */

import { describe, it, expect } from 'vitest';
import type { TraceProvenance } from '../src/monitoring/trace-provenance.js';
import {
  isErrorResult,
  proofText,
  buildProofIndex,
} from '../src/checks/trace-claim-check-proof.js';
import {
  matchPredicates,
  falsifyAgainstProof,
  PREDICATE_SIGNATURES,
  type PredicateSignature,
} from '../src/checks/trace-claim-check-predicates.js';

describe('trace-claim-check-proof: isErrorResult (harness verdict only)', () => {
  it('is not an error for non-object / nullish outputs', () => {
    expect(isErrorResult(null)).toBe(false);
    expect(isErrorResult(undefined)).toBe(false);
    expect(isErrorResult('boom')).toBe(false);
    expect(isErrorResult(42)).toBe(false);
  });

  it('flags an explicit harness is_error === true', () => {
    expect(isErrorResult({ is_error: true })).toBe(true);
    // only strict boolean true — a truthy string is NOT the harness flag
    expect(isErrorResult({ is_error: 'true' })).toBe(false);
  });

  it('flags a non-zero numeric exit_code, but not zero or non-numeric', () => {
    expect(isErrorResult({ exit_code: 1 })).toBe(true);
    expect(isErrorResult({ exit_code: -1 })).toBe(true);
    expect(isErrorResult({ exit_code: 0 })).toBe(false);
    expect(isErrorResult({ exit_code: '1' })).toBe(false);
  });
});

describe('trace-claim-check-proof: proofText (harness-authored channels only)', () => {
  it('returns empty for non-object outputs', () => {
    expect(proofText(null)).toBe('');
    expect(proofText('nope')).toBe('');
  });

  it('concatenates and lower-cases the known channels in order', () => {
    const out = {
      stdout: 'BUILD OK',
      stderr: 'Warn',
      output: 'Out',
      result: 'Res',
      message: 'Msg',
      other: 'IGNORED',
    };
    expect(proofText(out)).toBe('build ok\nwarn\nout\nres\nmsg');
  });

  it('skips non-string channel values', () => {
    expect(proofText({ stdout: 123, stderr: 'REAL' })).toBe('real');
  });
});

describe('trace-claim-check-proof: buildProofIndex', () => {
  const tp = (records: TraceProvenance['records']): TraceProvenance =>
    ({ records } as TraceProvenance);

  it('emits one entry per event that has a tool_output, sorted by event index', () => {
    const idx = buildProofIndex(
      tp([
        { eventIndex: 2, path: 'tool_call.tool_name', value: 'git_push' } as never,
        { eventIndex: 2, path: 'tool_call.tool_output', value: { is_error: false } } as never,
        { eventIndex: 0, path: 'tool_call.tool_output', value: { exit_code: 1 } } as never,
      ]),
    );
    expect(idx.map((p) => p.eventIndex)).toEqual([0, 2]);
    expect(idx[0].isError).toBe(true);
    expect(idx[1]).toMatchObject({ toolName: 'git_push', isError: false });
  });

  it('labels a tool_output with <unknown> when its event has no tool_name', () => {
    const idx = buildProofIndex(
      tp([{ eventIndex: 5, path: 'tool_call.tool_output', value: {} } as never]),
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].toolName).toBe('<unknown>');
  });

  it('excludes an event that has only a tool_name (a chosen tool with no PROOF result)', () => {
    const idx = buildProofIndex(
      tp([{ eventIndex: 1, path: 'tool_call.tool_name', value: 'run_tests' } as never]),
    );
    expect(idx).toHaveLength(0);
  });

  it('ignores an empty-string tool_name (keeps the <unknown> label)', () => {
    const idx = buildProofIndex(
      tp([
        { eventIndex: 3, path: 'tool_call.tool_name', value: '' } as never,
        { eventIndex: 3, path: 'tool_call.tool_output', value: {} } as never,
      ]),
    );
    expect(idx[0].toolName).toBe('<unknown>');
  });
});

describe('trace-claim-check-predicates: matchPredicates', () => {
  it('returns nothing for free narrative with no structured predicate', () => {
    expect(matchPredicates('i thought about the problem for a while')).toEqual([]);
  });

  it('matches a single predicate from its trigger phrase', () => {
    expect(matchPredicates('finally pushed the branch').map((s) => s.predicate)).toEqual(['push']);
  });

  it('matches multiple predicates in signature order from one narration', () => {
    const preds = matchPredicates('rebuilt green and then pushed').map((s) => s.predicate);
    expect(preds).toEqual(['push', 'build:pass']);
  });

  it('every frozen signature has a label, phrases, and tool hints', () => {
    for (const sig of PREDICATE_SIGNATURES) {
      expect(sig.predicate.length).toBeGreaterThan(0);
      expect(sig.claimPhrases.length).toBeGreaterThan(0);
      expect(sig.toolNameHints.length).toBeGreaterThan(0);
    }
  });
});

describe('trace-claim-check-predicates: falsifyAgainstProof (verdict from PROOF only)', () => {
  const pushSig = PREDICATE_SIGNATURES.find((s) => s.predicate === 'push')!;
  const scoreSig = PREDICATE_SIGNATURES.find((s) => s.predicate === 'score:green')!;
  const proof = (over: Partial<ReturnType<typeof mk>> = {}) => ({ ...mk(), ...over });
  function mk() {
    return { eventIndex: 0, toolName: 'git_push', isError: false, text: '' };
  }

  it('unverifiable when no PROOF anchors the predicate', () => {
    const r = falsifyAgainstProof(pushSig, [proof({ toolName: 'run_tests' })]);
    expect(r.verdict).toBe('unverifiable');
    expect(r.proofEventIndex).toBeNull();
    expect(r.reason).toContain('instrumentation gap');
  });

  it('verified when an anchored PROOF result did not error', () => {
    const r = falsifyAgainstProof(pushSig, [proof({ eventIndex: 4, isError: false })]);
    expect(r.verdict).toBe('verified');
    expect(r.proofEventIndex).toBe(4);
  });

  it('contradicted when the only anchored PROOF result errored', () => {
    const r = falsifyAgainstProof(pushSig, [proof({ eventIndex: 7, isError: true })]);
    expect(r.verdict).toBe('contradicted');
    expect(r.proofEventIndex).toBe(7);
  });

  it('prefers a non-errored result when both errored and clean anchors exist', () => {
    const r = falsifyAgainstProof(pushSig, [
      proof({ eventIndex: 1, isError: true }),
      proof({ eventIndex: 2, isError: false }),
    ]);
    expect(r.verdict).toBe('verified');
    expect(r.proofEventIndex).toBe(2);
  });

  it('anchors a generic tool via a harness result-text signature keyword', () => {
    const r = falsifyAgainstProof(scoreSig, [
      proof({ toolName: 'run_command', text: 'score=0.94 pass', isError: false }),
    ]);
    expect(r.verdict).toBe('verified');
  });

  it('the anchor-missing reason names the keyword hint when the signature has one', () => {
    const r = falsifyAgainstProof(scoreSig, [proof({ toolName: 'run_command', text: 'nothing' })]);
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toContain("score=");
  });

  it('accepts a custom PredicateSignature (matcher is data-driven)', () => {
    const custom: PredicateSignature = {
      predicate: 'deploy',
      claimPhrases: ['deployed'],
      toolNameHints: ['deploy'],
      proofSignatureKeywords: [],
    };
    const r = falsifyAgainstProof(custom, [proof({ toolName: 'deploy_prod', isError: false })]);
    expect(r.verdict).toBe('verified');
  });
});
