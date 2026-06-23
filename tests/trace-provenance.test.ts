/**
 * Tests for trace provenance (Section F, slice 1) — the read-only CLAIM↔PROOF
 * labeling that underpins harness×model selection.
 *
 * These tests pin the HARD GUARDRAIL invariants that make F a Tier 1+2 pillar:
 *   1. Labeling is STATIC and content-blind — the same field path yields the
 *      same label no matter what value it holds (a model cannot relabel its own
 *      narration as proof by changing the text).
 *   2. PROOF is only ever harness/code-produced data (tool_output, timing,
 *      tokens, collector rollups); model-authored fields (output_data on a
 *      non-tool event, decision_trace.*, a chosen tool_name/tool_input) are
 *      CLAIM — the hypothesis, never evidence.
 *   3. `output_data` is the one event-type-sensitive field: PROOF on a tool
 *      event, CLAIM on an llm/decision event.
 *   4. ingestTrace is pure + read-only: it never mutates its input.
 *   5. Absent fields are skipped; an explicit `null` is retained.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  labelField,
  provenanceMap,
  ingestTrace,
  type TraceSession,
  type Provenance,
} from '../src/monitoring/trace-provenance.js';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'agent-trace-sessions',
);

function loadSession(name: string): TraceSession {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf-8')) as TraceSession;
}

// ─── labelField: the static provenance map ──────────────────────────────────────

describe('labelField — static, content-blind provenance', () => {
  it('labels harness/runtime-produced fields as PROOF', () => {
    const proofPaths = [
      'event_type',
      'timestamp',
      'duration_ms',
      'tokens_in',
      'tokens_out',
      'tool_call.tool_output',
      'tool_call.duration_ms',
      'tool_call.timestamp',
    ];
    for (const path of proofPaths) {
      expect(labelField('tool_call', path), `${path} should be PROOF`).toBe('proof');
    }
  });

  it('labels model-authored fields as CLAIM (the hypothesis, never evidence)', () => {
    const claimPaths = [
      'tool_call.tool_name',
      'tool_call.tool_input',
      'decision_trace.reasoning',
      'decision_trace.alternatives_considered',
      'decision_trace.confidence',
    ];
    for (const path of claimPaths) {
      expect(labelField('decision', path), `${path} should be CLAIM`).toBe('claim');
    }
  });

  it('labels identifiers, the model key, and the input prompt as NEUTRAL', () => {
    const neutralPaths = [
      'event_id',
      'session_id',
      'model',
      'input_data',
      'tool_call.tool_call_id',
      'decision_trace.trace_id',
      'decision_trace.step',
    ];
    for (const path of neutralPaths) {
      expect(labelField('llm_call', path), `${path} should be NEUTRAL`).toBe('neutral');
    }
  });

  it('resolves output_data by event type: PROOF on a tool event, CLAIM otherwise', () => {
    expect(labelField('tool_call', 'output_data')).toBe('proof');
    expect(labelField('tool_result', 'output_data')).toBe('proof');
    expect(labelField('llm_call', 'output_data')).toBe('claim');
    expect(labelField('decision', 'output_data')).toBe('claim');
    expect(labelField('generic', 'output_data')).toBe('claim');
  });

  it('is content-blind: the label depends only on path + event type, never on a value', () => {
    // Whatever the field "says", the provenance is identical. (We cannot pass a
    // value to labelField at all — that is the point — so we assert stability
    // across event types for value-independent paths.)
    for (const et of ['llm_call', 'tool_call', 'decision', 'error', 'generic']) {
      expect(labelField(et, 'tokens_in')).toBe('proof');
      expect(labelField(et, 'decision_trace.reasoning')).toBe('claim');
      expect(labelField(et, 'session_id')).toBe('neutral');
    }
  });

  it('returns undefined for unknown paths (callers treat as an instrumentation gap)', () => {
    expect(labelField('llm_call', 'some.unmapped.field')).toBeUndefined();
    expect(labelField('llm_call', 'totally_unknown')).toBeUndefined();
  });

  it('provenanceMap exposes a copy of the fixed map without output_data', () => {
    const map = provenanceMap();
    expect(map['tool_call.tool_output']).toBe('proof');
    expect(map['decision_trace.reasoning']).toBe('claim');
    // output_data is event-type dependent, so it is intentionally not in the map
    expect('output_data' in map).toBe(false);
    // Returned object is a copy: mutating it does not affect later calls.
    (map as Record<string, Provenance>)['tool_call.tool_output'] = 'claim';
    expect(provenanceMap()['tool_call.tool_output']).toBe('proof');
  });
});

// ─── ingestTrace: read-only normalization ───────────────────────────────────────

describe('ingestTrace — read-only normalization into labeled records', () => {
  it('ingests the recorded sentinel session and partitions by provenance', () => {
    const session = loadSession('sentinel-push');
    const tp = ingestTrace(session);

    expect(tp.sessionId).toBe('sess-sentinel-001');
    expect(tp.agentName).toBe('claude-sonnet@winsentinel-harness');
    expect(tp.eventCount).toBe(5);

    // Every record carries a label; the three views partition the whole set.
    expect(tp.claims.length + tp.proofs.length + tp.neutral.length).toBe(tp.records.length);
    expect(tp.claims.every((r) => r.provenance === 'claim')).toBe(true);
    expect(tp.proofs.every((r) => r.provenance === 'proof')).toBe(true);
    expect(tp.neutral.every((r) => r.provenance === 'neutral')).toBe(true);

    // There is real evidence and at least one model claim to test against it.
    expect(tp.proofs.length).toBeGreaterThan(0);
    expect(tp.claims.length).toBeGreaterThan(0);
  });

  it('labels the actual tool result as PROOF and the chosen tool as CLAIM', () => {
    const tp = ingestTrace(loadSession('sentinel-push'));

    const toolOutputs = tp.records.filter((r) => r.path === 'tool_call.tool_output');
    expect(toolOutputs.length).toBe(2);
    expect(toolOutputs.every((r) => r.provenance === 'proof')).toBe(true);
    // The unforgeable is_error/exit lives in PROOF.
    expect(toolOutputs[0].value).toMatchObject({ is_error: false, exit_code: 0 });

    const toolNames = tp.records.filter((r) => r.path === 'tool_call.tool_name');
    expect(toolNames.length).toBe(2);
    expect(toolNames.every((r) => r.provenance === 'claim')).toBe(true);
    expect(toolNames.map((r) => r.value)).toEqual(['run_command', 'git_push']);
  });

  it('labels model narration (output_data) as CLAIM on llm events', () => {
    const tp = ingestTrace(loadSession('sentinel-push'));
    const narration = tp.records.filter(
      (r) => r.path === 'output_data' && r.eventType === 'llm_call',
    );
    expect(narration.length).toBe(2);
    expect(narration.every((r) => r.provenance === 'claim')).toBe(true);
  });

  it('labels the whole decision_trace as CLAIM (model-reported reasoning)', () => {
    const tp = ingestTrace(loadSession('sentinel-push'));
    const reasoning = tp.records.find((r) => r.path === 'decision_trace.reasoning');
    expect(reasoning?.provenance).toBe('claim');
    const confidence = tp.records.find((r) => r.path === 'decision_trace.confidence');
    expect(confidence?.provenance).toBe('claim');
    expect(confidence?.value).toBe(0.82);
  });

  it('does NOT mutate the input session (read-only toward trace data)', () => {
    const session = loadSession('sentinel-push');
    const before = JSON.stringify(session);
    ingestTrace(session);
    expect(JSON.stringify(session)).toBe(before);
  });

  it('skips absent fields but retains an explicit null value', () => {
    const session: TraceSession = {
      session_id: 's1',
      agent_name: 'm@h',
      events: [
        {
          event_type: 'tool_call',
          // duration_ms absent → skipped; tool_output explicitly null → kept.
          tool_call: { tool_name: 'noop', tool_output: null },
        },
      ],
    };
    const tp = ingestTrace(session);
    const paths = tp.records.map((r) => r.path);
    expect(paths).toContain('tool_call.tool_name');
    expect(paths).toContain('tool_call.tool_output');
    expect(paths).not.toContain('duration_ms');
    const out = tp.records.find((r) => r.path === 'tool_call.tool_output');
    expect(out?.value).toBeNull();
    expect(out?.provenance).toBe('proof');
  });

  it('handles an empty / event-less session without throwing', () => {
    expect(ingestTrace({}).records).toEqual([]);
    expect(ingestTrace({ events: [] }).eventCount).toBe(0);
    const tp = ingestTrace({ session_id: 'x', events: [{ event_type: 'error' }] });
    expect(tp.eventCount).toBe(1);
    // an event with only event_type yields exactly the event_type PROOF record
    expect(tp.records.map((r) => r.path)).toEqual(['event_type']);
    expect(tp.records[0].provenance).toBe('proof');
  });

  it('defaults a missing event_type to "generic" so output_data stays CLAIM', () => {
    const tp = ingestTrace({ events: [{ output_data: { text: 'hi' } }] });
    const rec = tp.records.find((r) => r.path === 'output_data');
    expect(rec?.eventType).toBe('generic');
    expect(rec?.provenance).toBe('claim');
  });

  it('records carry the originating event index for cross-event analysis later', () => {
    const tp = ingestTrace(loadSession('sentinel-push'));
    const indices = [...new Set(tp.records.map((r) => r.eventIndex))].sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4]);
  });
});
