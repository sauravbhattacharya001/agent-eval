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

// ─── PROVENANCE LABEL ──────────────────────────────────────────────────────────

/**
 * Static provenance of a trace field, decided by *where the value comes from*,
 * never by what it contains.
 *
 * - `proof`   — produced by the harness/runtime/code; the agent could not author
 *               it (tool results, exit/error flags, timing, token counts,
 *               collector-computed rollups). Admissible as Tier-1 evidence.
 * - `claim`   — authored by the model; the hypothesis under test (narration,
 *               stated reasoning, a tool name/args the model *chose*). NEVER
 *               admissible as evidence — only ever the thing being falsified.
 * - `neutral` — identifiers/context that assert nothing about agent behaviour
 *               (ids, agent name, timestamps used purely for ordering,
 *               arbitrary metadata, the input prompt). Excluded from scoring.
 */
export type Provenance = 'proof' | 'claim' | 'neutral';

// ─── AGENT TRACE SHAPE (a common session/span trace format) ─────────────────────
//
// These interfaces describe the session/event/tool-call/decision trace shape
// emitted by common agent-tracing SDKs (a session of events; each event may
// carry a model call, a tool call, and/or a decision trace, with inputs,
// outputs, tokens, timing, and cost). They are declared here — not imported —
// so the library stays zero-dependency and decoupled from any specific tracer;
// only the *shape* is shared. Unknown/extra fields are tolerated.

/** A single tool/function call recorded inside an event. */
export interface TraceToolCall {
  tool_call_id?: string;
  /** Tool the model chose to invoke. CLAIM (model-authored intent). */
  tool_name?: string;
  /** Arguments the model chose. CLAIM (model-authored intent). */
  tool_input?: Record<string, unknown> | null;
  /** The harness's actual tool result. PROOF (code-produced; unforgeable). */
  tool_output?: Record<string, unknown> | null;
  /** Wall-clock time the tool ran. PROOF (harness timing). */
  timestamp?: string | number;
  /** Tool execution time in ms. PROOF (harness timing). */
  duration_ms?: number | null;
  [extra: string]: unknown;
}

/** The model's self-reported reasoning behind a decision. Entirely CLAIM. */
export interface TraceDecision {
  trace_id?: string;
  step?: number;
  /** Free-text reasoning the model authored. CLAIM (the hypothesis). */
  reasoning?: string;
  /** Alternatives the model says it considered. CLAIM. */
  alternatives_considered?: string[];
  /** The model's self-reported confidence. CLAIM. */
  confidence?: number | null;
  timestamp?: string | number;
  [extra: string]: unknown;
}

/** A single observable event in an agent's execution. */
export interface TraceEvent {
  event_id?: string;
  session_id?: string;
  /** Harness-assigned kind: llm_call, tool_call, decision, error, … PROOF. */
  event_type?: string;
  /** Event wall-clock time. PROOF (harness timing). */
  timestamp?: string | number;
  /** Input/prompt handed to the model. NEUTRAL context (not claim, not proof). */
  input_data?: Record<string, unknown> | null;
  /** Model-authored output/narration for non-tool events. CLAIM. */
  output_data?: Record<string, unknown> | null;
  /** Model identifier for an llm_call. NEUTRAL (selection key, not behaviour). */
  model?: string | null;
  /** Prompt tokens counted by the runtime. PROOF. */
  tokens_in?: number;
  /** Completion tokens counted by the runtime. PROOF. */
  tokens_out?: number;
  /** Tool call sub-record (mixed provenance — see {@link TraceToolCall}). */
  tool_call?: TraceToolCall | null;
  /** Decision sub-record (all CLAIM — see {@link TraceDecision}). */
  decision_trace?: TraceDecision | null;
  /** Event duration in ms. PROOF (harness timing). */
  duration_ms?: number | null;
  [extra: string]: unknown;
}

/** An agent tracking session: the unit F ingests. */
export interface TraceSession {
  session_id?: string;
  /** Agent name (often `model@harness` or similar). NEUTRAL selection key. */
  agent_name?: string;
  started_at?: string | number;
  ended_at?: string | number | null;
  /** Arbitrary user metadata. NEUTRAL. */
  metadata?: Record<string, unknown>;
  events?: TraceEvent[];
  /** Collector-summed prompt tokens. PROOF (code-computed rollup). */
  total_tokens_in?: number;
  /** Collector-summed completion tokens. PROOF (code-computed rollup). */
  total_tokens_out?: number;
  /** Collector-assigned status: active/completed/error. PROOF. */
  status?: string;
  [extra: string]: unknown;
}

// ─── NORMALIZED RECORDS ─────────────────────────────────────────────────────────

/**
 * One labeled field extracted from a trace. The atomic unit slice-1 produces:
 * a `(value, provenance)` pair anchored to its origin by a static `path`.
 */
export interface ProvenanceRecord {
  /** Zero-based index of the owning event within the session. */
  eventIndex: number;
  /** Harness-assigned event type (verbatim), e.g. `tool_call`. */
  eventType: string;
  /** Dotted field path within the event, e.g. `tool_call.tool_output`. */
  path: string;
  /** Static provenance label for this path (content was NOT inspected). */
  provenance: Provenance;
  /** The field's value (copied by reference; never mutated). */
  value: unknown;
}

/**
 * The result of {@link ingestTrace}: every meaningful field of a session,
 * partitioned by static provenance, ready for the Tier 1+2 checks in later
 * slices. CLAIM records are hypotheses; PROOF records are admissible evidence;
 * NEUTRAL records are excluded from scoring.
 */
export interface TraceProvenance {
  /** Session id (or `''` if absent). */
  sessionId: string;
  /** Agent/selection label as recorded (`agent_name`). */
  agentName: string;
  /** Number of events ingested. */
  eventCount: number;
  /** All labeled records in event order, then field order. */
  records: ProvenanceRecord[];
  /** Convenience views (references into {@link records}). */
  claims: ProvenanceRecord[];
  proofs: ProvenanceRecord[];
  neutral: ProvenanceRecord[];
}

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
