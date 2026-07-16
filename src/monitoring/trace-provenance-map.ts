/**
 * Trace Provenance — the static CLAIM↔PROOF map + field labeling (Section F, slice 1).
 *
 * This is the single source of truth for *where a trace field comes from*. It is
 * split out from the ingest adapter ({@link ./trace-provenance.js}) so the map
 * and its labeling function are testable and importable in isolation. Labeling
 * depends ONLY on the harness-assigned `eventType` and the static field `path`
 * — never on the field's *content* — so it is deterministic and incorruptible:
 * a model cannot relabel its own narration as proof.
 *
 * HARD GUARDRAIL (do not break — see eval-task.md §F):
 *   - PROOF may come ONLY from harness/code-produced data the agent could not
 *     author (tool `tool_output` incl. `is_error`, `duration_ms`, `tokens_*`,
 *     collector-computed session rollups).
 *   - The self-CLAIM (model-authored `output_data`, `decision_trace.reasoning`,
 *     a chosen `tool_name`/`tool_input`) is the hypothesis, NEVER evidence.
 *   - Labeling is by static provenance (event-type + field-path), not content.
 *
 * @tier 1 — Deterministic (static labeling; pure; no AI, no IO, no network)
 * @module
 */

import type { Provenance } from './trace-provenance-types.js';

// ─── STATIC PROVENANCE MAP ──────────────────────────────────────────────────────
//
// The single source of truth. Keyed by dotted field-path; the label depends on
// the field's ORIGIN, decided here once, statically. A small number of paths are
// event-type-sensitive (the same field name means different things on a tool
// event vs an llm event) — those are resolved by {@link labelField}, which is
// the only place event_type participates, and it still never reads field values.

/** Field paths whose provenance is fixed regardless of event type. */
const FIXED_PROVENANCE: Readonly<Record<string, Provenance>> = Object.freeze({
  // ── PROOF: harness/runtime/code produced; the agent cannot author these. ──
  event_type: 'proof', // harness assigns the kind
  timestamp: 'proof', // harness clock
  duration_ms: 'proof', // harness timing
  tokens_in: 'proof', // runtime token meter
  tokens_out: 'proof', // runtime token meter
  'tool_call.tool_output': 'proof', // the ACTUAL tool result (is_error, exit, side effects)
  'tool_call.duration_ms': 'proof', // harness timing for the tool
  'tool_call.timestamp': 'proof', // harness clock for the tool

  // ── CLAIM: model-authored; the hypothesis under test, never evidence. ──
  'tool_call.tool_name': 'claim', // the model CHOSE this tool
  'tool_call.tool_input': 'claim', // the model CHOSE these args
  'decision_trace.reasoning': 'claim', // model's stated reasoning
  'decision_trace.alternatives_considered': 'claim',
  'decision_trace.confidence': 'claim', // model's self-reported confidence

  // ── NEUTRAL: identifiers / context; assert nothing about behaviour. ──
  event_id: 'neutral',
  session_id: 'neutral',
  model: 'neutral', // selection key, not a behavioural claim or proof
  input_data: 'neutral', // the prompt handed IN; context, not the agent's output
  'tool_call.tool_call_id': 'neutral',
  'decision_trace.trace_id': 'neutral',
  'decision_trace.step': 'neutral',
  'decision_trace.timestamp': 'proof', // harness clock for the decision
});

/**
 * `output_data` is the one field whose provenance genuinely depends on the
 * event type, so it is resolved dynamically (still without reading its value):
 *
 *   - On a `tool_call`/`tool_result` event, `output_data` mirrors the harness's
 *     tool result → PROOF.
 *   - On any other event (`llm_call`, `decision`, `generic`, …) `output_data` is
 *     the model's own narration/answer → CLAIM.
 */
const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set(['tool_call', 'tool_result']);

/**
 * Resolve the static provenance of a single field path. The ONLY inputs are the
 * harness-assigned `eventType` and the static field `path` — the field's value
 * is never consulted, so this function is deterministic and incorruptible.
 *
 * Returns `undefined` for paths not on the map (callers treat unknown paths as
 * NEUTRAL and may surface them as an instrumentation gap).
 */
export function labelField(eventType: string, path: string): Provenance | undefined {
  if (path === 'output_data') {
    return TOOL_EVENT_TYPES.has(eventType) ? 'proof' : 'claim';
  }
  return FIXED_PROVENANCE[path];
}

/**
 * The full static provenance map as a plain object, for documentation, tests,
 * and downstream tools. `output_data` is omitted because it is event-type
 * dependent — use {@link labelField} to resolve it. Returns a fresh copy.
 */
export function provenanceMap(): Record<string, Provenance> {
  return { ...FIXED_PROVENANCE };
}
