/**
 * Trace Provenance (Section F, slice 1) — static CLAIM↔PROOF labeling for agent
 * execution traces.
 *
 * Section F evaluates an agent as `(model × harness)` to answer two selection
 * questions ("given a model, which harness?"; "given a harness, which model?").
 * The comparison is a **Tier 1+2** pillar — Tier 3 (model-as-judge) is NEVER
 * used here. The subtlety F turns on:
 *
 *   - The agent's *self-claimed* behaviour (what it SAID it did/decided) is the
 *     **HYPOTHESIS under test**, not evidence.
 *   - The actual judging happens entirely at Tier 1+2: each self-claim is
 *     falsified against the harness's *actual outputs* (tool results, exit
 *     codes, side effects, timing, tokens) = Tier-1 PROOF, or against a
 *     code-computed Tier-2 baseline.
 *
 * This module is **slice 1**: the read-only provenance map + trace adapter. It
 * ingests an agent {@link TraceSession} and labels every field as
 * {@link Provenance | CLAIM, PROOF, or NEUTRAL} by a **static map** keyed on
 * `(eventType, fieldPath)` — never by inspecting the field's *content*. Because
 * labeling is by static provenance, the labeling itself is deterministic and
 * incorruptible: a model cannot relabel its own narration as proof.
 *
 * The module is organised in three cohesive parts:
 *   - {@link ./trace-provenance-types.js} — the shared trace shape + label types.
 *   - {@link ./trace-provenance-map.js} — the static map + {@link labelField}.
 *   - this file — the read-only {@link ingestTrace} adapter.
 * All three are re-exported here, so `./trace-provenance.js` remains the single
 * import surface for consumers.
 *
 * HARD GUARDRAIL (do not break — see eval-task.md §F):
 *   - PROOF may come ONLY from harness/code-produced data the agent could not
 *     author (tool `tool_output` incl. `is_error`, `duration_ms`, `tokens_*`,
 *     collector-computed session rollups).
 *   - The self-CLAIM (model-authored `output_data`, `decision_trace.reasoning`,
 *     a chosen `tool_name`/`tool_input`) is the hypothesis, NEVER evidence.
 *   - Labeling is by static provenance (event-type + field-path), not content.
 *   - Read-only toward trace data: this module never mutates the input.
 *
 * Downstream slices (NOT in this file): behavioural-footprint checks
 * (PROOF-only) and the claim↔proof cross-check land in `src/checks`; selection
 * ranking lands alongside the monitoring layer. This file is the pure,
 * IO-free foundation they consume.
 *
 * @tier 1 — Deterministic (static labeling; pure; no AI, no IO, no network)
 * @module
 */

import { labelField } from './trace-provenance-map.js';
import type {
  ProvenanceRecord,
  TraceEvent,
  TraceProvenance,
  TraceSession,
} from './trace-provenance-types.js';

// Re-export the trace shape + label types and the static map so this module
// remains the single import surface for provenance consumers.
export type {
  Provenance,
  ProvenanceRecord,
  TraceDecision,
  TraceEvent,
  TraceProvenance,
  TraceSession,
  TraceToolCall,
} from './trace-provenance-types.js';
export { labelField, provenanceMap } from './trace-provenance-map.js';

// ─── INGEST (read-only adapter) ─────────────────────────────────────────────────

/** Paths that are present directly on an event (non-nested). */
const EVENT_SCALAR_PATHS = [
  'event_type',
  'timestamp',
  'duration_ms',
  'tokens_in',
  'tokens_out',
  'model',
  'event_id',
  'session_id',
  'input_data',
  'output_data',
] as const;

/** Sub-record field paths, expanded when the sub-record is present. */
const TOOL_CALL_PATHS = [
  'tool_call.tool_name',
  'tool_call.tool_input',
  'tool_call.tool_output',
  'tool_call.duration_ms',
  'tool_call.timestamp',
  'tool_call.tool_call_id',
] as const;

const DECISION_PATHS = [
  'decision_trace.reasoning',
  'decision_trace.alternatives_considered',
  'decision_trace.confidence',
  'decision_trace.trace_id',
  'decision_trace.step',
  'decision_trace.timestamp',
] as const;

function getNested(event: TraceEvent, path: string): unknown {
  const dot = path.indexOf('.');
  const record = event as Record<string, unknown>;
  if (dot === -1) return record[path];
  const head = path.slice(0, dot);
  const tail = path.slice(dot + 1);
  const sub = record[head];
  if (sub == null || typeof sub !== 'object') return undefined;
  return (sub as Record<string, unknown>)[tail];
}

/**
 * Ingest an agent trace session into labeled provenance records — **read-only**.
 * Pure and IO-free: no network, no disk, no mutation of the input. Every field
 * present on every event is labeled by static provenance (see
 * {@link labelField}); fields that are absent are skipped, so the record set
 * reflects exactly what the harness emitted.
 *
 * @param session A decoded trace session (load it from a recorded fixture or a
 *   trace collector at the IO edge — never inside this core).
 * @returns A {@link TraceProvenance} with claims/proofs/neutral partitioned.
 */
export function ingestTrace(session: TraceSession): TraceProvenance {
  const events = Array.isArray(session.events) ? session.events : [];
  const records: ProvenanceRecord[] = [];

  events.forEach((event, eventIndex) => {
    const eventType = typeof event.event_type === 'string' ? event.event_type : 'generic';

    const paths: string[] = [...EVENT_SCALAR_PATHS];
    if (event.tool_call != null && typeof event.tool_call === 'object') {
      paths.push(...TOOL_CALL_PATHS);
    }
    if (event.decision_trace != null && typeof event.decision_trace === 'object') {
      paths.push(...DECISION_PATHS);
    }

    for (const path of paths) {
      const value = getNested(event, path);
      // Skip fields the harness did not emit (undefined). `null` is a real,
      // emitted value (e.g. an explicit empty tool_output) and is retained.
      if (value === undefined) continue;
      const provenance = labelField(eventType, path) ?? 'neutral';
      records.push({ eventIndex, eventType, path, provenance, value });
    }
  });

  return {
    sessionId: typeof session.session_id === 'string' ? session.session_id : '',
    agentName: typeof session.agent_name === 'string' ? session.agent_name : '',
    eventCount: events.length,
    records,
    claims: records.filter((r) => r.provenance === 'claim'),
    proofs: records.filter((r) => r.provenance === 'proof'),
    neutral: records.filter((r) => r.provenance === 'neutral'),
  };
}
